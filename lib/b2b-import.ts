import type PocketBase from "pocketbase";

import {
  COLLECTIONS,
  describePocketBaseError,
  isNotFound,
  isUniqueViolation,
} from "@/lib/pocketbase";
import {
  MIN_SCORE,
  isPlausibleEmail,
  isVerifierConfigured,
  verifyEmailBatch,
} from "@/lib/verify-email";
import type { B2BContact, B2BOutreach, ContactSource } from "@/lib/types";

/**
 * The B2B import pipeline, in two halves that are deliberately separate:
 *
 *   importB2BLeads()  normalise → verify → upsert contact       (the POOL)
 *   enrolContacts()   contact + campaign → a queued outreach run (the QUEUE)
 *
 * They are separate because scraping and campaigning are separate jobs. You
 * fill the pool from a scrape without deciding who to email; later you pick
 * from the pool and enrol them. Nothing here sends an email or talks to n8n —
 * enrolment produces a `queued` run and stops. lib/b2b-dispatch.ts owns
 * sending, and it is the only thing that ever moves a run out of `queued`.
 *
 * The other important idea is the split between a CONTACT and an OUTREACH RUN.
 * A contact is a person and exists once, forever. An outreach run is one
 * campaign aimed at that person. Re-targeting a lead from six months ago with
 * a new offer creates a second run against the same contact record — it never
 * duplicates the person. That is what makes lead reuse work, and it is why
 * `b2b_contacts.email` is unique but `b2b_outreach` is not.
 */

export interface RawContact {
  email: string;
  contact_name?: string;
  company_name?: string;
  website?: string;
  linkedin_url?: string;
}

/** Provenance stamped onto every contact a single scrape or paste produces. */
export interface PoolMeta {
  niche?: string;
  source?: ContactSource;
  scrape_run?: string;
}

/** Result of filling the pool — no campaign involved. */
export interface B2BPoolSummary {
  received: number;
  /** New contact records created. */
  contactsCreated: number;
  /** Existing contacts recognised and refreshed rather than duplicated. */
  contactsReused: number;
  /** Rejected by the verifier (or malformed). */
  rejected: number;
  errors: string[];
}

/** Result of putting pooled contacts into a campaign's queue. */
export interface B2BEnrolSummary {
  /** New outreach runs created — the number of people now QUEUED, not sent. */
  enrolled: number;
  /** Already enrolled in THIS campaign; skipped. */
  alreadyInCampaign: number;
  errors: string[];
}

/** The combined shape, kept intact so /api/b2b/import's response is unchanged. */
export interface B2BImportSummary extends B2BPoolSummary, B2BEnrolSummary {}

/** Finds a contact by email, or null. Email is the unique key. */
async function findContactByEmail(
  pb: PocketBase,
  email: string
): Promise<B2BContact | null> {
  try {
    return await pb
      .collection(COLLECTIONS.b2bContacts)
      .getFirstListItem<B2BContact>(pb.filter("email = {:email}", { email }));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Is this contact already enrolled in this specific campaign? */
async function findExistingRun(
  pb: PocketBase,
  contactId: string,
  campaignId: string
): Promise<B2BOutreach | null> {
  try {
    return await pb
      .collection(COLLECTIONS.b2bOutreach)
      .getFirstListItem<B2BOutreach>(
        pb.filter("contact = {:c} && campaign = {:k}", {
          c: contactId,
          k: campaignId,
        })
      );
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export interface EnrolledRun {
  outreach_id: string;
  contact: B2BContact;
}

/* ==================================================================== */
/*  Half one: fill the lead pool                                         */
/* ==================================================================== */

/**
 * Normalises, verifies and upserts contacts into the pool.
 *
 * No campaign, no outreach run, no email. This is what a scrape calls.
 */
export async function importB2BLeads(
  pb: PocketBase,
  raw: RawContact[],
  meta: PoolMeta = {},
  options: { allowUnverified?: boolean } = {}
): Promise<{ summary: B2BPoolSummary; contacts: B2BContact[] }> {
  const summary: B2BPoolSummary = {
    received: raw.length,
    contactsCreated: 0,
    contactsReused: 0,
    rejected: 0,
    errors: [],
  };
  const saved: B2BContact[] = [];

  /* Normalise and de-duplicate within the batch first. Scraped exports
     routinely list the same person twice under different job titles, and
     verifying the same address twice is a wasted paid API call. */
  const byEmail = new Map<string, RawContact>();
  for (const c of raw) {
    const email = c.email.trim().toLowerCase();
    if (!isPlausibleEmail(email)) {
      summary.rejected++;
      continue;
    }
    if (!byEmail.has(email)) byEmail.set(email, { ...c, email });
  }

  const contacts = [...byEmail.values()];
  if (contacts.length === 0) return { summary, contacts: saved };

  /* Verification gate. With no verifier configured every result comes back
     unverified with score 0 — so we import them flagged rather than
     discarding an entire list because a key is missing. */
  const verifications = await verifyEmailBatch(contacts.map((c) => c.email));
  const gateActive = isVerifierConfigured() && !options.allowUnverified;

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const v = verifications[i];

    if (gateActive && v.score < MIN_SCORE) {
      summary.rejected++;
      continue;
    }

    try {
      let contact = await findContactByEmail(pb, c.email);

      if (contact) {
        summary.contactsReused++;
        /* Refresh only fields the scrape actually filled in. A later scrape
           with a blank company name must not erase a good one. */
        const patch: Partial<B2BContact> = {};
        if (c.contact_name && !contact.contact_name) patch.contact_name = c.contact_name;
        if (c.company_name && !contact.company_name) patch.company_name = c.company_name;
        if (c.website && !contact.website) patch.website = c.website;
        if (c.linkedin_url && !contact.linkedin_url) patch.linkedin_url = c.linkedin_url;
        if (v.verified && !contact.email_verified) {
          patch.email_verified = true;
          patch.verification_score = v.score;
        }
        /* Provenance follows the same rule: a re-scrape under a new niche
           should not blank the niche that first found this person. */
        if (meta.niche && !contact.niche) patch.niche = meta.niche;
        if (meta.scrape_run && !contact.scrape_run) patch.scrape_run = meta.scrape_run;

        if (Object.keys(patch).length > 0) {
          contact = await pb
            .collection(COLLECTIONS.b2bContacts)
            .update<B2BContact>(contact.id, patch);
        }
      } else {
        try {
          contact = await pb
            .collection(COLLECTIONS.b2bContacts)
            .create<B2BContact>({
              email: c.email,
              contact_name: c.contact_name ?? "",
              company_name: c.company_name ?? "",
              website: c.website ?? "",
              linkedin_url: c.linkedin_url ?? "",
              email_verified: v.verified,
              verification_score: v.score,
              niche: meta.niche ?? "",
              source: meta.source ?? "api",
              scrape_run: meta.scrape_run ?? "",
              pool_status: "new",
            });
          summary.contactsCreated++;
        } catch (err) {
          // Lost a race with a concurrent import; the other one won.
          if (!isUniqueViolation(err)) throw err;
          contact = await findContactByEmail(pb, c.email);
          if (!contact) throw err;
          summary.contactsReused++;
        }
      }

      saved.push(contact);
    } catch (err) {
      const reason = describePocketBaseError(err, COLLECTIONS.b2bContacts);
      console.error(`[b2b-import] pool write failed for ${c.email}:`, reason);
      if (summary.errors.length < 5) summary.errors.push(reason);
    }
  }

  return { summary, contacts: saved };
}

/* ==================================================================== */
/*  Half two: put pooled contacts into a campaign's queue                */
/* ==================================================================== */

/**
 * Creates one QUEUED outreach run per contact.
 *
 * Nothing is emailed here and nothing is handed to n8n. Runs are created with
 * `kanban_stage: "queued"` and an EMPTY `last_email_sent_at` — the field is
 * only written when n8n calls back to say the mail actually left. Writing it
 * at enrolment (as this used to) meant a failed webhook left every contact
 * marked as emailed when nothing had been sent.
 */
export async function enrolContacts(
  pb: PocketBase,
  campaignId: string,
  contacts: B2BContact[]
): Promise<{ summary: B2BEnrolSummary; enrolled: EnrolledRun[] }> {
  const summary: B2BEnrolSummary = {
    enrolled: 0,
    alreadyInCampaign: 0,
    errors: [],
  };
  const enrolled: EnrolledRun[] = [];

  for (const contact of contacts) {
    try {
      const existingRun = await findExistingRun(pb, contact.id, campaignId);
      if (existingRun) {
        summary.alreadyInCampaign++;
        continue;
      }

      const run = await pb.collection(COLLECTIONS.b2bOutreach).create<B2BOutreach>({
        contact: contact.id,
        campaign: campaignId,
        kanban_stage: "queued",
        reply_sentiment: "pending",
        ai_draft_reply: "",
        call_booked: false,
        call_booked_at: "",
        last_email_sent_at: "",
        archived: false,
        send_attempts: 0,
        queued_at: new Date().toISOString(),
        dispatched_at: "",
        send_error: "",
      });

      if (contact.pool_status !== "in_campaign") {
        /* Best-effort: a pool badge is not worth failing an enrolment over. */
        await pb
          .collection(COLLECTIONS.b2bContacts)
          .update(contact.id, { pool_status: "in_campaign" })
          .catch(() => undefined);
      }

      enrolled.push({ outreach_id: run.id, contact });
      summary.enrolled++;
    } catch (err) {
      if (isUniqueViolation(err)) {
        summary.alreadyInCampaign++;
        continue;
      }
      const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
      console.error(`[b2b-import] enrol failed for ${contact.email}:`, reason);
      if (summary.errors.length < 5) summary.errors.push(reason);
    }
  }

  return { summary, enrolled };
}

/* ==================================================================== */
/*  Both halves, for the paste-import route                              */
/* ==================================================================== */

/**
 * Pool + enrol in one call — what `/api/b2b/import` does.
 *
 * Still sends nothing: the contacts land in the campaign's queue and wait for
 * the daily dispatcher like every other lead.
 */
export async function importB2BContacts(
  pb: PocketBase,
  campaignId: string,
  raw: RawContact[],
  options: { allowUnverified?: boolean; meta?: PoolMeta } = {}
): Promise<{ summary: B2BImportSummary; enrolled: EnrolledRun[] }> {
  const pool = await importB2BLeads(pb, raw, options.meta ?? {}, {
    allowUnverified: options.allowUnverified,
  });
  const enrolment = await enrolContacts(pb, campaignId, pool.contacts);

  return {
    summary: {
      ...pool.summary,
      ...enrolment.summary,
      errors: [...pool.summary.errors, ...enrolment.summary.errors].slice(0, 5),
    },
    enrolled: enrolment.enrolled,
  };
}
