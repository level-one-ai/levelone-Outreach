/**
 * PocketBase record shapes.
 *
 * These mirror docs/pocketbase-schema.json exactly. If you add a field in the
 * PocketBase admin UI, add it here too — PocketBase silently rejects writes to
 * fields that do not exist, and TypeScript is the only thing standing between
 * a typo and a 400 you only notice in production.
 */

/** Fields PocketBase attaches to every record. */
export interface BaseRecord {
  id: string;
  created: string;
  updated: string;
  collectionId?: string;
  collectionName?: string;
}

/* -------------------------------------------------------------------- */
/*  Trades pipeline                                                      */
/* -------------------------------------------------------------------- */

export type TradeStatus = "scraped" | "negative" | "no_answer" | "positive";

/**
 * `unchecked` is the honest default: it means no TPS provider was configured,
 * NOT that the number is clear to call. The UI shows it as an amber
 * "UNSCREENED" badge for exactly that reason.
 */
export type TpsStatus = "unchecked" | "clear" | "listed" | "error";

export interface TradeLead extends BaseRecord {
  company_name: string;
  location: string;
  /** Normalised to E.164 before saving — this is the unique dedupe key. */
  phone: string;
  tps_verified: boolean;
  tps_status: TpsStatus;
  email: string;
  website: string;
  /** ISO datetime, or "" when no call is scheduled. */
  call_date_time: string;
  status: TradeStatus;
  meeting_sent: boolean;
  /** Google Places id — the secondary dedupe key across overlapping cells. */
  place_id: string;
  /** Which grid cell found this lead, e.g. "53.4808,-2.2426@1500m". */
  grid_cell: string;
}

/* -------------------------------------------------------------------- */
/*  B2B pipeline                                                         */
/* -------------------------------------------------------------------- */

/**
 * The lifecycle of one person inside one campaign.
 *
 * `queued` is the important addition: enrolling a contact no longer means
 * emailing them. A run sits in `queued` until the daily dispatcher picks it,
 * which is what makes a send limit possible at all.
 *
 * `sending` is a CLAIM, not a status you would ever set by hand. The
 * dispatcher writes it before handing the batch to n8n so a second tick
 * cannot grab the same leads, and only n8n's success callback moves it on to
 * `sent_1`. That pairing is the whole guarantee that nobody receives the same
 * first email twice.
 */
export type KanbanStage =
  | "queued"
  | "sending"
  | "sent_1"
  | "followup_2d"
  | "followup_5d"
  | "replied"
  | "send_failed";

/**
 * The columns the board actually draws. A run that reaches `replied` leaves
 * the board entirely and surfaces in the AI Inbox instead — which is the
 * visual half of the auto-pause: a replied lead stops being something the
 * follow-up sequence is still working on.
 *
 * `sending` is deliberately absent: it lasts seconds in the happy path, and a
 * column that is empty 99% of the time is noise. The board folds it into
 * Queued. `send_failed` surfaces as a strip above the board instead, because
 * it needs your attention rather than a place in the flow.
 */
export const BOARD_STAGES: KanbanStage[] = [
  "queued",
  "sent_1",
  "followup_2d",
  "followup_5d",
];

export const STAGE_LABELS: Record<KanbanStage, string> = {
  queued: "Queued",
  sending: "Sending…",
  sent_1: "First Email Sent",
  followup_2d: "Follow-up · 2 Days",
  followup_5d: "Follow-up · 5 Days",
  replied: "Replied",
  send_failed: "Send Failed",
};

export type ReplySentiment = "pending" | "positive" | "negative" | "no_reply";

/** Where a pooled contact came from. */
export type ContactSource = "apify" | "paste" | "api";

/**
 * `in_campaign` means "enrolled somewhere at least once" — it is a browsing
 * convenience for the pool, not a constraint. The same contact can still be
 * added to a second campaign later; `b2b_outreach`'s unique index is what
 * actually prevents duplicate enrolment.
 */
export type PoolStatus = "new" | "in_campaign" | "suppressed";

export interface B2BContact extends BaseRecord {
  /** Lowercased and trimmed — the unique dedupe key. */
  email: string;
  contact_name: string;
  company_name: string;
  website: string;
  linkedin_url: string;
  email_verified: boolean;
  /** 0–100 deliverability score from the verifier, or 0 when unverified. */
  verification_score: number;
  /** What you searched for, e.g. "SaaS founders, Manchester". */
  niche: string;
  source: ContactSource;
  /** The `scrape_runs` id that produced this contact, or "". */
  scrape_run: string;
  pool_status: PoolStatus;
}

export interface B2BCampaign extends BaseRecord {
  title: string;
  offer_description: string;
  from_email: string;
  active: boolean;
  /** Initial emails per day. The whole point of the queue. */
  daily_send_limit: number;
  /** 24-hour "HH:MM" in `send_timezone`. */
  send_time: string;
  /** IANA zone, e.g. "Europe/London". */
  send_timezone: string;
  /** Master switch — the dispatcher ignores campaigns with this off. */
  sending_active: boolean;
  /**
   * "YYYY-MM-DD" of the last day a batch went out, in `send_timezone`.
   *
   * Claimed BEFORE the batch is sent, not after. The ticker runs every
   * minute; this field is the only thing making "once per day" true.
   */
  last_dispatch_date: string;
}

export interface B2BOutreach extends BaseRecord {
  contact: string;
  campaign: string;
  kanban_stage: KanbanStage;
  reply_sentiment: ReplySentiment;
  ai_draft_reply: string;
  call_booked: boolean;
  call_booked_at: string;
  /** Empty until n8n confirms the first email actually went out. */
  last_email_sent_at: string;
  archived: boolean;
  /** Failed sends are retried on later days; 3 strikes and it parks. */
  send_attempts: number;
  /** When it joined the queue — the dispatcher sends FIFO. */
  queued_at: string;
  /** When it was handed to n8n. Drives the stale-claim sweep. */
  dispatched_at: string;
  send_error: string;
  /** Populated when fetched with `expand=contact,campaign`. */
  expand?: {
    contact?: B2BContact;
    campaign?: B2BCampaign;
  };
}

export type MessageDirection = "inbound" | "outbound";

export interface OutreachMessage extends BaseRecord {
  outreach_run: string;
  direction: MessageDirection;
  subject: string;
  body: string;
  sent_at: string;
}

/* -------------------------------------------------------------------- */
/*  Background scrape runs                                               */
/* -------------------------------------------------------------------- */

export type ScrapeKind = "trades" | "b2b";
export type ScrapeStatus = "queued" | "running" | "complete" | "failed";

export interface ScrapeRun extends BaseRecord {
  kind: ScrapeKind;
  status: ScrapeStatus;
  /** The request that started the run, echoed back for the progress panel. */
  params: Record<string, unknown>;
  cells_total: number;
  cells_done: number;
  /** Raw results seen, before dedupe. */
  found: number;
  /** Records actually written to PocketBase. */
  imported: number;
  /** Skipped because the phone/email already existed. */
  duplicates: number;
  /** Skipped by TPS screening or by email verification. */
  blocked: number;
  error: string;
  started_at: string;
  finished_at: string;
}

/* -------------------------------------------------------------------- */
/*  Shared API envelope                                                  */
/* -------------------------------------------------------------------- */

/**
 * Every route in this app answers with this shape, so the client never has to
 * guess whether a 200 means success.
 */
export type ApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; details?: unknown };
