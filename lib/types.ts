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

export type KanbanStage = "sent_1" | "followup_2d" | "followup_5d" | "replied";

/**
 * The three columns the board actually draws. A run that reaches `replied`
 * leaves the board entirely and surfaces in the AI Inbox instead — which is
 * the visual half of the auto-pause: a replied lead stops being something the
 * follow-up sequence is still working on.
 */
export const BOARD_STAGES: KanbanStage[] = [
  "sent_1",
  "followup_2d",
  "followup_5d",
];

export const STAGE_LABELS: Record<KanbanStage, string> = {
  sent_1: "First Email Sent",
  followup_2d: "Follow-up · 2 Days",
  followup_5d: "Follow-up · 5 Days",
  replied: "Replied",
};

export type ReplySentiment = "pending" | "positive" | "negative" | "no_reply";

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
}

export interface B2BCampaign extends BaseRecord {
  title: string;
  offer_description: string;
  from_email: string;
  active: boolean;
}

export interface B2BOutreach extends BaseRecord {
  contact: string;
  campaign: string;
  kanban_stage: KanbanStage;
  reply_sentiment: ReplySentiment;
  ai_draft_reply: string;
  call_booked: boolean;
  call_booked_at: string;
  last_email_sent_at: string;
  archived: boolean;
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
