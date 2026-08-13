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
import type { B2BContact, B2BOutreach } from "@/lib/types";

/**
 * The B2B import pipeline: normalise → verify → upsert contact → enrol.
 *
 * The important idea here is the split between a CONTACT and an OUTREACH RUN.
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

export interface B2BImportSummary {
  received: number;
  /** New contact records created. */
  contactsCreated: number;
  /** Existing contacts reused for this campaign. */
  contactsReused: number;
  /** New outreach runs created — the number of people who will be emailed. */
  enrolled: number;
  /** Already enrolled in THIS campaign; skipped. */
  alreadyInCampaign: number;
  /** Rejected by the verifier (or malformed). */
  rejected: number;
  errors: string[];
}

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

export async function importB2BContacts(
  pb: PocketBase,
  campaignId: string,
  raw: RawContact[],
  options: { allowUnverified?: boolean } = {}
): Promise<{ summary: B2BImportSummary; enrolled: EnrolledRun[] }> {
  const summary: B2BImportSummary = {
    received: raw.length,
    contactsCreated: 0,
    contactsReused: 0,
    enrolled: 0,
    alreadyInCampaign: 0,
    rejected: 0,
    errors: [],
  };
  const enrolled: EnrolledRun[] = [];

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
  if (contacts.length === 0) return { summary, enrolled };

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
      // ---- Contact: reuse if known, create if new -------------------
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

      // ---- Outreach run: one per (contact, campaign) ----------------
      const existingRun = await findExistingRun(pb, contact.id, campaignId);
      if (existingRun) {
        summary.alreadyInCampaign++;
        continue;
      }

      const run = await pb.collection(COLLECTIONS.b2bOutreach).create<B2BOutreach>({
        contact: contact.id,
        campaign: campaignId,
        kanban_stage: "sent_1",
        reply_sentiment: "pending",
        ai_draft_reply: "",
        call_booked: false,
        call_booked_at: "",
        last_email_sent_at: new Date().toISOString(),
        archived: false,
      });

      enrolled.push({ outreach_id: run.id, contact });
      summary.enrolled++;
    } catch (err) {
      if (isUniqueViolation(err)) {
        summary.alreadyInCampaign++;
        continue;
      }
      const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
      console.error(`[b2b-import] failed for ${c.email}:`, reason);
      if (summary.errors.length < 5) summary.errors.push(reason);
    }
  }

  return { summary, enrolled };
}
