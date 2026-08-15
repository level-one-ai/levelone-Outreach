import type { B2BCampaign, B2BContact, TradeLead } from "@/lib/types";

/**
 * ===========================================================================
 *  n8n — EVERY CLIENT-FACING EMAIL LEAVES THROUGH THIS FILE.
 * ===========================================================================
 *
 * Four outbound webhooks, one function each. Nothing in this app sends mail to
 * a client by any other route; lib/resend.ts is structurally incapable of it.
 *
 * Design rules that apply to all four:
 *
 *  - Every payload carries `event`, `sent_at` and the PocketBase record ids, so
 *    an n8n workflow can always call back and update the record it acted on.
 *  - A missing webhook URL is an ERROR, not a silent no-op. The UI must never
 *    tell you an email was sent when no workflow was ever called.
 *  - Failures are returned, not thrown, so the caller can decide whether to
 *    roll back a status change.
 *
 * The exact JSON body of each payload is documented in docs/OPERATIONS.md.
 */

const WEBHOOKS = {
  tradesMeeting: process.env.N8N_WEBHOOK_TRADES_MEETING ?? "",
  b2bSequence: process.env.N8N_WEBHOOK_B2B_SEQUENCE ?? "",
  dispatchResponse: process.env.N8N_WEBHOOK_DISPATCH_RESPONSE ?? "",
  negativeReply: process.env.N8N_WEBHOOK_NEGATIVE_REPLY ?? "",
  cancelNudge: process.env.N8N_WEBHOOK_CANCEL_NUDGE ?? "",
} as const;

type WebhookName = keyof typeof WEBHOOKS;

const ENV_NAME: Record<WebhookName, string> = {
  tradesMeeting: "N8N_WEBHOOK_TRADES_MEETING",
  b2bSequence: "N8N_WEBHOOK_B2B_SEQUENCE",
  dispatchResponse: "N8N_WEBHOOK_DISPATCH_RESPONSE",
  negativeReply: "N8N_WEBHOOK_NEGATIVE_REPLY",
  cancelNudge: "N8N_WEBHOOK_CANCEL_NUDGE",
};

export interface DispatchResult {
  ok: boolean;
  /** Whatever the workflow replied with, when it replied with JSON. */
  response?: unknown;
  error?: string;
}

/** n8n workflows can be slow to acknowledge; this bounds how long we wait. */
const TIMEOUT_MS = 20_000;

async function post(
  name: WebhookName,
  body: Record<string, unknown>
): Promise<DispatchResult> {
  const url = WEBHOOKS[name];

  if (!url) {
    const error = `${ENV_NAME[name]} is not configured — no email was sent.`;
    console.error(`[n8n] ${error}`);
    return { ok: false, error };
  }

  const payload = { ...body, sent_at: new Date().toISOString() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const error = `n8n replied ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`;
      console.error(`[n8n:${name}] ${error}`);
      return { ok: false, error };
    }

    // A workflow that ends in "Respond to Webhook" returns JSON; one that
    // ends immediately returns an empty body. Both are success.
    const response = await res.json().catch(() => null);
    return { ok: true, response };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const error = aborted
      ? `n8n did not respond within ${TIMEOUT_MS / 1000}s.`
      : `Could not reach n8n: ${err instanceof Error ? err.message : "unknown error"}`;
    console.error(`[n8n:${name}] ${error}`);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

/** The contact block shared by the three B2B payloads. */
function contactBlock(contact: B2BContact) {
  return {
    contact_id: contact.id,
    contact_name: contact.contact_name,
    contact_email: contact.email,
    company_name: contact.company_name,
    website: contact.website,
    linkedin_url: contact.linkedin_url,
  };
}

/* -------------------------------------------------------------------- */
/*  1. Trades — meeting email after a positive call                      */
/* -------------------------------------------------------------------- */

/**
 * Fired from the trades board when a lead is logged Positive and you click
 * "Send Meeting Email". n8n sends the client their meeting/Zoom link.
 */
export async function dispatchTradesMeeting(
  lead: TradeLead,
  meetingLink: string
): Promise<DispatchResult> {
  return post("tradesMeeting", {
    event: "trades_meeting_email",
    lead_id: lead.id,
    company_name: lead.company_name,
    contact_email: lead.email,
    phone: lead.phone,
    location: lead.location,
    call_date_time: lead.call_date_time || null,
    meeting_link: meetingLink,
  });
}

/* -------------------------------------------------------------------- */
/*  2. B2B — send one day's batch                                        */
/* -------------------------------------------------------------------- */

/**
 * Fired by the daily dispatcher with the leads due to be emailed TODAY —
 * never with a whole import. n8n's job here is transport only: send each
 * email, then POST the outcome back to `callback_url`.
 *
 * That callback is not optional. Nothing in this app marks a lead as emailed
 * until n8n says the mail left, which is what stops tomorrow's batch from
 * re-sending the same first email to someone who already got it.
 *
 * Sent as one batch rather than one call per contact: a 50-a-day campaign
 * would otherwise mean 50 webhook calls, and n8n's own rate limits are the
 * thing that breaks first.
 */
export async function dispatchB2BBatch(
  campaign: B2BCampaign,
  runs: Array<{ outreach_id: string; contact: B2BContact }>,
  callbackUrl: string
): Promise<DispatchResult> {
  return post("b2bSequence", {
    event: "b2b_batch_send",
    campaign: {
      campaign_id: campaign.id,
      title: campaign.title,
      offer_description: campaign.offer_description,
      from_email: campaign.from_email,
    },
    /**
     * POST `{outreach_id, status:"success"|"failed", subject, body, error}`
     * here per recipient (or `{results:[…]}` once), with the
     * x-webhook-secret header.
     */
    callback_url: callbackUrl,
    /** Days after the first email that each follow-up should go out. */
    follow_up_schedule: [2, 5],
    recipients: runs.map((r) => ({
      outreach_id: r.outreach_id,
      ...contactBlock(r.contact),
    })),
  });
}

/* -------------------------------------------------------------------- */
/*  3. Positive reply — your approved response + 24h booking timer       */
/* -------------------------------------------------------------------- */

/**
 * Fired when you click "Send Response" in the AI Inbox. n8n emails the client
 * your (possibly edited) draft, then enters a 24-hour Wait node that nudges
 * them if no discovery call has been booked by the time it expires.
 */
export async function dispatchPositiveResponse(params: {
  outreachId: string;
  contact: B2BContact;
  campaign: B2BCampaign;
  subject: string;
  body: string;
  discoveryCallLink: string;
}): Promise<DispatchResult> {
  return post("dispatchResponse", {
    event: "positive_reply_response",
    outreach_id: params.outreachId,
    campaign_id: params.campaign.id,
    ...contactBlock(params.contact),
    from_email: params.campaign.from_email,
    subject: params.subject,
    body: params.body,
    discovery_call_link: params.discoveryCallLink,
    /* The two flags that drive the Wait node. n8n should re-check
       call_booked in PocketBase when the timer expires before nudging. */
    start_booking_timer: true,
    timer_hours: 24,
  });
}

/* -------------------------------------------------------------------- */
/*  4. Negative reply — polite apology, then archive                     */
/* -------------------------------------------------------------------- */

/**
 * Fired when you dismiss a negative reply. n8n sends the apology with a
 * greeting matched to the recipient's local time of day.
 *
 * The greeting is chosen inside n8n rather than here, because the email may
 * sit in a queue: computing "good morning" at dispatch time is what makes it
 * accurate, not computing it when the button was clicked.
 */
export async function dispatchNegativeReply(params: {
  outreachId: string;
  contact: B2BContact;
  campaign: B2BCampaign;
  /** IANA zone, e.g. "Europe/London". n8n picks morning/afternoon/evening. */
  localTimezone: string;
}): Promise<DispatchResult> {
  return post("negativeReply", {
    event: "negative_reply_apology",
    outreach_id: params.outreachId,
    campaign_id: params.campaign.id,
    ...contactBlock(params.contact),
    from_email: params.campaign.from_email,
    local_timezone: params.localTimezone,
    greeting_mode: "time_of_day",
  });
}

/* -------------------------------------------------------------------- */
/*  5. Cancel the pending nudge (optional)                               */
/* -------------------------------------------------------------------- */

/**
 * Fired when a discovery call is booked, so a workflow holding a 24-hour Wait
 * node can drop it. Optional — if your workflow instead re-reads
 * `call_booked` from PocketBase before nudging, leave N8N_WEBHOOK_CANCEL_NUDGE
 * unset and this becomes a no-op that reports success.
 */
export async function cancelBookingNudge(params: {
  outreachId: string;
  contactEmail: string;
  bookedFor: string;
}): Promise<DispatchResult> {
  if (!WEBHOOKS.cancelNudge) {
    return { ok: true, response: { skipped: "N8N_WEBHOOK_CANCEL_NUDGE unset" } };
  }
  return post("cancelNudge", {
    event: "discovery_call_booked",
    outreach_id: params.outreachId,
    contact_email: params.contactEmail,
    booked_for: params.bookedFor,
    cancel_nudge: true,
  });
}

/** Surfaced by /api/health/pocketbase so misconfiguration is visible early. */
export function webhookConfigStatus(): Record<string, boolean> {
  return Object.fromEntries(
    (Object.keys(WEBHOOKS) as WebhookName[]).map((k) => [
      ENV_NAME[k],
      Boolean(WEBHOOKS[k]),
    ])
  );
}
