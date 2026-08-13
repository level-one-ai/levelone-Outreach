import { z } from "zod";

/**
 * Request validation for every route in the app.
 *
 * Two of these routes are public webhook receivers that anything on the
 * internet can POST to, so validation is a boundary, not a formality: nothing
 * reaches PocketBase without passing through a schema here first.
 */

/* -------------------------------------------------------------------- */
/*  Trades                                                               */
/* -------------------------------------------------------------------- */

export const tradesScrapeSchema = z.object({
  /** Free-text place or postcode; geocoded server-side. */
  query: z.string().min(2).max(120).optional(),
  /** Or explicit coordinates, when the caller already has them. */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  /** The trade to search for, e.g. "plumber", "roofer". */
  keyword: z.string().min(2).max(80),
  /** Metres. 25km is already a very large, very expensive run. */
  searchRadius: z.number().int().min(500).max(25_000).default(5_000),
  cellRadius: z.number().int().min(400).max(5_000).default(1_500),
}).refine(
  (v) => Boolean(v.query) || (v.lat !== undefined && v.lng !== undefined),
  { message: "Provide either a location query or both lat and lng." }
);

export const tradesImportSchema = z.object({
  leads: z
    .array(
      z.object({
        company_name: z.string().min(1).max(200),
        location: z.string().max(300).default(""),
        phone: z.string().min(6).max(40),
        email: z.string().max(200).default(""),
        website: z.string().max(400).default(""),
        place_id: z.string().max(200).default(""),
        grid_cell: z.string().max(80).default(""),
      })
    )
    .min(1)
    .max(1000),
});

export const tradesUpdateSchema = z.object({
  id: z.string().min(1),
  email: z.string().max(200).optional(),
  call_date_time: z.string().max(40).optional(),
  status: z.enum(["scraped", "negative", "no_answer", "positive"]).optional(),
});

export const logCallSchema = z.object({
  lead_id: z.string().min(1),
  outcome: z.enum(["negative", "no_answer", "positive"]),
});

export const sendMeetingSchema = z.object({
  lead_id: z.string().min(1),
  /** Falls back to TRADES_MEETING_LINK when omitted. */
  meeting_link: z.string().max(500).optional(),
});

/* -------------------------------------------------------------------- */
/*  B2B                                                                  */
/* -------------------------------------------------------------------- */

export const campaignSchema = z.object({
  title: z.string().min(2).max(160),
  offer_description: z.string().max(8000).default(""),
  from_email: z.string().email(),
  active: z.boolean().default(true),
});

export const b2bScrapeSchema = z.object({
  campaign_id: z.string().min(1),
  /**
   * Passed straight through to your Apify actor as its input. Every actor
   * takes a different shape, so this is deliberately not modelled further —
   * the UI sends whatever the actor's own docs specify.
   */
  actor_input: z.record(z.unknown()),
});

export const b2bImportSchema = z.object({
  campaign_id: z.string().min(1),
  contacts: z
    .array(
      z.object({
        email: z.string().min(3).max(200),
        contact_name: z.string().max(160).default(""),
        company_name: z.string().max(200).default(""),
        website: z.string().max(400).default(""),
        linkedin_url: z.string().max(400).default(""),
      })
    )
    .min(1)
    .max(2000),
  /** Enrol contacts that failed verification anyway. Off by default. */
  allow_unverified: z.boolean().default(false),
  /** Fire the n8n sequence webhook immediately after enrolment. */
  start_sequence: z.boolean().default(true),
});

export const outreachStageSchema = z.object({
  outreach_id: z.string().min(1),
  kanban_stage: z.enum(["sent_1", "followup_2d", "followup_5d", "replied"]),
});

/* -------------------------------------------------------------------- */
/*  Email dispatch                                                       */
/* -------------------------------------------------------------------- */

export const dispatchResponseSchema = z.object({
  outreach_id: z.string().min(1),
  subject: z.string().min(1).max(300),
  /** The AI draft, after whatever edits you made in the composer. */
  body: z.string().min(1).max(20_000),
  discovery_call_link: z.string().max(500).optional(),
});

export const dispatchNegativeSchema = z.object({
  outreach_id: z.string().min(1),
  /** IANA zone used by n8n to pick the greeting. */
  local_timezone: z.string().max(60).default("Europe/London"),
});

/* -------------------------------------------------------------------- */
/*  Inbound webhooks                                                     */
/* -------------------------------------------------------------------- */

/**
 * Posted by n8n after Gemini has classified a client's reply.
 *
 * The outreach run can be addressed either by its PocketBase id (when n8n
 * kept it from the sequence payload) or by the contact's email address (when
 * the reply arrived through a mailbox trigger that only knows the sender).
 */
export const inboundReplySchema = z
  .object({
    outreach_id: z.string().min(1).optional(),
    contact_email: z.string().email().optional(),
    campaign_id: z.string().min(1).optional(),
    sentiment: z.enum(["positive", "negative", "no_reply"]),
    ai_draft_reply: z.string().max(20_000).default(""),
    subject: z.string().max(300).default(""),
    body: z.string().max(50_000).default(""),
    received_at: z.string().max(40).optional(),
  })
  .refine((v) => Boolean(v.outreach_id || v.contact_email), {
    message: "Provide either outreach_id or contact_email.",
  });

/** Posted by the calendar tool (directly, or relayed through n8n). */
export const calendarBookedSchema = z
  .object({
    outreach_id: z.string().min(1).optional(),
    contact_email: z.string().email().optional(),
    /** ISO datetime of the booked call. */
    booked_for: z.string().max(40).default(""),
    booking_reference: z.string().max(200).default(""),
  })
  .refine((v) => Boolean(v.outreach_id || v.contact_email), {
    message: "Provide either outreach_id or contact_email.",
  });

/* -------------------------------------------------------------------- */
/*  Helpers                                                              */
/* -------------------------------------------------------------------- */

/** Flattens a ZodError into one readable sentence for the API envelope. */
export function describeZodError(err: z.ZodError): string {
  return err.errors
    .map((e) => `${e.path.join(".") || "body"}: ${e.message}`)
    .join("; ");
}
