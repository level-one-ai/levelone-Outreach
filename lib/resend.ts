import { Resend } from "resend";

/**
 * ===========================================================================
 *  RESEND — INTERNAL ALERTS ONLY. NEVER A CLIENT.
 * ===========================================================================
 *
 * This module exists to make one architectural rule impossible to break by
 * accident: Resend emails YOU, n8n emails CLIENTS.
 *
 * The enforcement is structural, not documentary. `sendInternalAlert` takes no
 * recipient parameter at all — the `to` address is read from
 * INTERNAL_ALERT_EMAIL inside this file and cannot be influenced by a caller.
 * A route that mistakenly passes a lead's address has nowhere to put it.
 *
 * Every client-facing email in this system goes through lib/n8n.ts instead.
 * If you ever find yourself wanting to add a `to` argument here, that is the
 * signal that the email belongs in n8n.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM = process.env.RESEND_FROM_EMAIL ?? "alerts@levelone.digital";
const TO = process.env.INTERNAL_ALERT_EMAIL ?? "";
const APP_BASE_URL = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");

/** Lazily constructed so a missing key degrades instead of crashing boot. */
let client: Resend | null = null;
function getClient(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!client) client = new Resend(RESEND_API_KEY);
  return client;
}

/** The five alerts this system sends. Adding one means adding it here. */
export type AlertKind =
  | "trades_meeting_sent"
  | "positive_reply_received"
  | "response_sent"
  | "call_booked"
  | "system_error";

export interface AlertPayload {
  /** Headline fact — company or contact this is about. */
  subject: string;
  /** Short lead paragraph. */
  summary: string;
  /** Rendered as a definition list in the email body. */
  facts?: Record<string, string | number | boolean | null | undefined>;
  /** Path within this app, e.g. "/inbox". Becomes an absolute deep link. */
  link?: string;
  linkLabel?: string;
}

export interface AlertResult {
  sent: boolean;
  reason?: string;
}

const SUBJECT_PREFIX: Record<AlertKind, string> = {
  trades_meeting_sent: "Meeting email sent",
  positive_reply_received: "Positive reply",
  response_sent: "Response sent",
  call_booked: "Discovery call booked",
  system_error: "Outreach system alert",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Plain, unbranded HTML. These land in your own inbox — legibility on a phone
 * lock screen matters more than design here.
 */
function renderHtml(payload: AlertPayload): string {
  const rows = Object.entries(payload.facts ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(
      ([k, v]) =>
        `<tr>
           <td style="padding:6px 16px 6px 0;color:#6b6a66;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(
             k
           )}</td>
           <td style="padding:6px 0;color:#111110;font-size:13px">${escapeHtml(
             String(v)
           )}</td>
         </tr>`
    )
    .join("");

  const href =
    payload.link && APP_BASE_URL ? `${APP_BASE_URL}${payload.link}` : "";

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#faf9f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e8e6e0;border-radius:16px;padding:28px">
    <p style="margin:0 0 4px;font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#6b6a66">Level One Outreach</p>
    <h1 style="margin:0 0 12px;font-size:19px;line-height:1.3;color:#111110">${escapeHtml(
      payload.subject
    )}</h1>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#111110">${escapeHtml(
      payload.summary
    )}</p>
    ${rows ? `<table style="border-collapse:collapse;margin-bottom:24px">${rows}</table>` : ""}
    ${
      href
        ? `<a href="${href}" style="display:inline-block;background:#111110;color:#faf9f6;text-decoration:none;padding:11px 22px;border-radius:999px;font-size:13px;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(
            payload.linkLabel ?? "Open in Outreach"
          )}</a>`
        : ""
    }
    <p style="margin:24px 0 0;font-size:11px;color:#6b6a66">Internal notification. This address is never used for client email.</p>
  </div>
</body></html>`;
}

/**
 * Sends an alert to you and nobody else.
 *
 * Always non-fatal. Every caller has already completed the thing being
 * announced — the lead is saved, the client email is away — so a mail failure
 * must never turn into a failed request or an n8n redelivery loop. Failures
 * are logged and reported in the return value instead of thrown.
 */
export async function sendInternalAlert(
  kind: AlertKind,
  payload: AlertPayload
): Promise<AlertResult> {
  const resend = getClient();

  if (!resend) {
    console.warn(`[resend] RESEND_API_KEY unset — alert "${kind}" not sent.`);
    return { sent: false, reason: "RESEND_API_KEY is not configured." };
  }
  if (!TO) {
    console.warn(`[resend] INTERNAL_ALERT_EMAIL unset — alert "${kind}" not sent.`);
    return { sent: false, reason: "INTERNAL_ALERT_EMAIL is not configured." };
  }

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      // Hardcoded on purpose. See the header comment.
      to: TO,
      subject: `${SUBJECT_PREFIX[kind]} — ${payload.subject}`,
      html: renderHtml(payload),
    });

    if (error) {
      console.error(`[resend] alert "${kind}" rejected:`, error);
      return { sent: false, reason: error.message };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[resend] alert "${kind}" failed:`, err);
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "unknown error",
    };
  }
}
