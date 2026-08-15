import type PocketBase from "pocketbase";

import { APP_BASE_URL } from "@/lib/api";
import { dispatchB2BBatch } from "@/lib/n8n";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  getAll,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import type { B2BCampaign, B2BContact, B2BOutreach } from "@/lib/types";

/**
 * ===========================================================================
 *  THE DAILY SEND ENGINE
 * ===========================================================================
 *
 * The rule this file exists to enforce: if a campaign is set to 10 a day and
 * has 100 queued leads, then leads 1-10 are emailed today, 11-20 tomorrow, and
 * nobody ever receives the same first email twice.
 *
 * Three mechanisms hold that together, and each one covers a different way it
 * could break:
 *
 *  1. STAGE. Only `queued` runs are ever selected. A lead that has been
 *     emailed is `sent_1`, which is invisible to selection. This is the actual
 *     no-double-send guarantee.
 *
 *  2. THE CLAIM. Selected runs are flipped to `sending` BEFORE the batch goes
 *     to n8n. If a second tick fires while the first is still working, it sees
 *     no queued runs among them and takes nothing. `sending` is released only
 *     by n8n's callback (→ `sent_1`) or by the stale sweep below (→ `queued`).
 *
 *  3. THE DAY LOCK. `campaign.last_dispatch_date` is written BEFORE sending,
 *     not after. The ticker runs every minute; without claiming the day up
 *     front, a crash between sending and recording would send another batch a
 *     minute later.
 *
 * Nothing here decides WHAT to say — n8n owns the email content and the
 * follow-up Wait nodes. This file only decides WHO gets one and WHEN.
 */

/** How long a `sending` claim can go unconfirmed before we assume n8n lost it. */
const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

/** Give up on a lead after this many failed sends. */
const MAX_SEND_ATTEMPTS = 3;

export interface CampaignDispatchResult {
  campaign_id: string;
  campaign_title: string;
  /** How many leads were handed to n8n. */
  sent: number;
  /** Released back to the queue by the stale sweep. */
  recovered: number;
  skipped?: string;
  error?: string;
}

/* -------------------------------------------------------------------- */
/*  Time, in the campaign's own timezone                                 */
/* -------------------------------------------------------------------- */

/**
 * "Now" in a given IANA zone, as `{ date: "YYYY-MM-DD", minutes: 0-1439 }`.
 *
 * Uses Intl rather than date maths so DST is handled by the platform. A
 * campaign set to 09:00 Europe/London sends at 09:00 local on both sides of a
 * clock change, which is the only behaviour that isn't surprising.
 */
export function localNow(timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  /* Intl renders midnight as "24" in some locales/zones; normalise it. */
  const hour = Number(get("hour")) % 24;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/** "09:00" → 540. Malformed values park at midnight rather than throwing. */
function parseSendTime(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Falls back for campaigns created before these fields existed, and for the
 * empty strings PocketBase hands back for unset text fields.
 */
function sendSettings(campaign: B2BCampaign) {
  const tz = campaign.send_timezone || "Europe/London";
  let zone = tz;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    console.warn(
      `[dispatch] campaign ${campaign.id} has invalid timezone "${tz}" — using Europe/London.`
    );
    zone = "Europe/London";
  }
  return {
    limit: campaign.daily_send_limit > 0 ? campaign.daily_send_limit : 10,
    sendMinutes: parseSendTime(campaign.send_time || "09:00"),
    timeZone: zone,
  };
}

/* -------------------------------------------------------------------- */
/*  Stale claim recovery                                                 */
/* -------------------------------------------------------------------- */

/**
 * Returns runs stuck in `sending` to the queue.
 *
 * n8n crashing, the network dropping, or a workflow being edited mid-run all
 * leave a lead claimed but never confirmed. Without this they would sit in
 * `sending` forever, silently shrinking the campaign. They keep their
 * `send_attempts` count, so a lead that repeatedly strands still gives up
 * eventually rather than looping.
 */
export async function sweepStaleClaims(
  pb: PocketBase,
  campaignId: string
): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  const stuck = await getAll<B2BOutreach>(pb, COLLECTIONS.b2bOutreach, {
    filter: pb.filter(
      "campaign = {:k} && kanban_stage = 'sending' && dispatched_at < {:cutoff}",
      { k: campaignId, cutoff }
    ),
  });

  let recovered = 0;
  for (const run of stuck) {
    const attempts = (run.send_attempts ?? 0) + 1;
    const exhausted = attempts >= MAX_SEND_ATTEMPTS;
    try {
      await pb.collection(COLLECTIONS.b2bOutreach).update(run.id, {
        kanban_stage: exhausted ? "send_failed" : "queued",
        send_attempts: attempts,
        dispatched_at: "",
        send_error: "n8n never confirmed this send.",
      });
      recovered++;
    } catch (err) {
      console.error(`[dispatch] could not recover ${run.id}:`, err);
    }
  }

  if (recovered > 0) {
    console.warn(
      `[dispatch] recovered ${recovered} unconfirmed send(s) on campaign ${campaignId}.`
    );
  }
  return recovered;
}

/* -------------------------------------------------------------------- */
/*  One campaign's batch                                                 */
/* -------------------------------------------------------------------- */

/**
 * Sends one day's batch for one campaign.
 *
 * `force` skips the clock and the day lock — that is the "Send next batch now"
 * button. It still respects the daily limit and still only ever touches
 * `queued` runs, so it can be pressed twice without emailing anyone twice.
 */
export async function dispatchCampaign(
  pb: PocketBase,
  campaign: B2BCampaign,
  options: { force?: boolean } = {}
): Promise<CampaignDispatchResult> {
  const base: CampaignDispatchResult = {
    campaign_id: campaign.id,
    campaign_title: campaign.title,
    sent: 0,
    recovered: 0,
  };

  const { limit, sendMinutes, timeZone } = sendSettings(campaign);

  // 1. Release anything n8n never confirmed, so it can go out again today.
  try {
    base.recovered = await sweepStaleClaims(pb, campaign.id);
  } catch (err) {
    console.error(`[dispatch] stale sweep failed for ${campaign.id}:`, err);
  }

  const now = localNow(timeZone);

  // 2. Is it time yet, and has today already gone out?
  if (!options.force) {
    if (now.minutes < sendMinutes) {
      return { ...base, skipped: "before send time" };
    }
    if (campaign.last_dispatch_date === now.date) {
      return { ...base, skipped: "already sent today" };
    }
  }

  // 3. Take the front of the queue, oldest first.
  let queued: B2BOutreach[];
  try {
    const page = await pb
      .collection(COLLECTIONS.b2bOutreach)
      .getList<B2BOutreach>(1, limit, {
        filter: pb.filter(
          "campaign = {:k} && kanban_stage = 'queued' && archived = false",
          { k: campaign.id }
        ),
        sort: "queued_at,created",
        expand: "contact",
      });
    queued = page.items;
  } catch (err) {
    return { ...base, error: describePocketBaseError(err, COLLECTIONS.b2bOutreach) };
  }

  if (queued.length === 0) {
    return { ...base, skipped: "nothing queued" };
  }

  /* Without an absolute base URL n8n has nowhere to report the send back to,
     and every lead would strand in `sending` until the stale sweep. Refuse
     before claiming anything rather than discovering it two hours later. */
  if (!APP_BASE_URL) {
    return {
      ...base,
      error:
        "APP_BASE_URL is not set, so n8n has no callback URL to confirm sends. Nothing was sent.",
    };
  }

  /* 4. CLAIM THE DAY BEFORE SENDING. If the process dies between here and the
        webhook call, the worst case is one batch that never went out — which
        the stale sweep returns to the queue. Recording the day afterwards
        would instead risk sending a second batch a minute later.

        A forced batch claims the day too. It skipped the CHECK, not the
        limit: pressing "send next batch" at 8am should bring today's send
        forward, not earn the campaign a second one at 9am. */
  try {
    await pb
      .collection(COLLECTIONS.b2bCampaigns)
      .update(campaign.id, { last_dispatch_date: now.date });
  } catch (err) {
    return {
      ...base,
      error: `Could not claim today's send slot: ${describePocketBaseError(err, COLLECTIONS.b2bCampaigns)}`,
    };
  }

  // 5. Claim each lead, so a concurrent tick cannot take the same ones.
  const claimed: Array<{ outreach_id: string; contact: B2BContact }> = [];
  const dispatchedAt = new Date().toISOString();

  for (const run of queued) {
    const contact = run.expand?.contact;
    if (!contact) {
      console.error(`[dispatch] run ${run.id} has no contact — skipping.`);
      continue;
    }
    try {
      await pb.collection(COLLECTIONS.b2bOutreach).update(run.id, {
        kanban_stage: "sending",
        dispatched_at: dispatchedAt,
      });
      claimed.push({ outreach_id: run.id, contact });
    } catch (err) {
      console.error(`[dispatch] could not claim ${run.id}:`, err);
    }
  }

  if (claimed.length === 0) {
    return { ...base, skipped: "nothing could be claimed" };
  }

  // 6. Hand the batch to n8n.
  const callbackUrl = `${APP_BASE_URL}/api/webhooks/email-sent`;
  const result = await dispatchB2BBatch(campaign, claimed, callbackUrl);

  if (!result.ok) {
    /* n8n never took the batch, so nothing was emailed. Put every lead back
       and give up the day, or the campaign would silently lose a day's send. */
    await releaseClaims(pb, claimed.map((c) => c.outreach_id), result.error ?? "");
    await pb
      .collection(COLLECTIONS.b2bCampaigns)
      .update(campaign.id, { last_dispatch_date: campaign.last_dispatch_date ?? "" })
      .catch(() => undefined);

    await sendInternalAlert("system_error", {
      subject: `Batch not sent — ${campaign.title}`,
      summary: `${claimed.length} leads were due to be emailed but the n8n webhook failed. They have been returned to the queue and nothing was sent.`,
      facts: { Reason: result.error ?? "unknown", Campaign: campaign.title },
      link: "/b2b",
      linkLabel: "Open B2B board",
    });

    return { ...base, error: result.error ?? "n8n webhook failed." };
  }

  return { ...base, sent: claimed.length };
}

/** Returns claimed runs to `queued` without counting an attempt against them. */
async function releaseClaims(
  pb: PocketBase,
  ids: string[],
  reason: string
): Promise<void> {
  for (const id of ids) {
    await pb
      .collection(COLLECTIONS.b2bOutreach)
      .update(id, {
        kanban_stage: "queued",
        dispatched_at: "",
        send_error: reason.slice(0, 500),
      })
      .catch((err) => console.error(`[dispatch] could not release ${id}:`, err));
  }
}

/* -------------------------------------------------------------------- */
/*  Every campaign — what the ticker calls                               */
/* -------------------------------------------------------------------- */

/**
 * Runs the dispatch check across every campaign that has sending switched on.
 *
 * Called once a minute by the ticker in instrumentation.ts, and directly by
 * /api/b2b/dispatch for the "send now" button. Cheap when there is nothing to
 * do: one filtered list read, then an early return per campaign.
 */
export async function dispatchDueCampaigns(
  options: { force?: string; pb?: PocketBase } = {}
): Promise<CampaignDispatchResult[]> {
  const pb = options.pb ?? createPublicClient();
  const results: CampaignDispatchResult[] = [];

  let campaigns: B2BCampaign[];
  try {
    campaigns = options.force
      ? [
          await pb
            .collection(COLLECTIONS.b2bCampaigns)
            .getOne<B2BCampaign>(options.force),
        ]
      : await getAll<B2BCampaign>(pb, COLLECTIONS.b2bCampaigns, {
          filter: "active = true && sending_active = true",
        });
  } catch (err) {
    console.error("[dispatch] could not load campaigns:", err);
    return results;
  }

  for (const campaign of campaigns) {
    try {
      results.push(
        await dispatchCampaign(pb, campaign, { force: Boolean(options.force) })
      );
    } catch (err) {
      console.error(`[dispatch] campaign ${campaign.id} threw:`, err);
      results.push({
        campaign_id: campaign.id,
        campaign_title: campaign.title,
        sent: 0,
        recovered: 0,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return results;
}
