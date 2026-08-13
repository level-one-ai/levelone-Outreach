import { fail, ok, parseBody } from "@/lib/api";
import { dispatchTradesMeeting } from "@/lib/n8n";
import { formatUkPhone } from "@/lib/phone";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { sendMeetingSchema } from "@/lib/schema";
import type { TradeLead } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * "Send Meeting Email" on a positive trades lead.
 *
 * The full both-halves-of-the-architecture flow, in order:
 *   1. n8n sends the meeting/Zoom link to the CLIENT.
 *   2. Only if that succeeded, the lead is marked meeting_sent.
 *   3. Resend tells YOU it happened.
 *
 * The ordering is what keeps the board honest. Marking the record first would
 * leave a lead permanently flagged "meeting sent" after a webhook failure,
 * with no way to tell from the UI that the client never got anything.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, sendMeetingSchema);
  if (!parsed.success) return parsed.response;

  const { lead_id } = parsed.data;
  const meetingLink =
    parsed.data.meeting_link || process.env.TRADES_MEETING_LINK || "";

  const pb = createPublicClient();

  let lead: TradeLead;
  try {
    lead = await pb.collection(COLLECTIONS.tradesLeads).getOne<TradeLead>(lead_id);
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.tradesLeads);
    return fail(reason, 404);
  }

  if (!lead.email) {
    return fail(
      "This lead has no email address. Add one on the card before sending."
    );
  }

  // ---- 1. Client email, via n8n -----------------------------------
  const dispatch = await dispatchTradesMeeting(lead, meetingLink);
  if (!dispatch.ok) {
    return fail(`The meeting email was not sent. ${dispatch.error}`, 502);
  }

  // ---- 2. Record it -----------------------------------------------
  let updated = lead;
  try {
    updated = await pb
      .collection(COLLECTIONS.tradesLeads)
      .update<TradeLead>(lead_id, { meeting_sent: true });
  } catch (err) {
    // The client HAS been emailed at this point, so this is not a failure —
    // just a board that will look out of date until the next edit.
    console.error(
      "[trades/send-meeting] email sent but record not updated:",
      describePocketBaseError(err, COLLECTIONS.tradesLeads)
    );
  }

  // ---- 3. Internal alert, via Resend ------------------------------
  const alert = await sendInternalAlert("trades_meeting_sent", {
    subject: lead.company_name,
    summary: `A meeting email has been sent to ${lead.company_name} following a positive call.`,
    facts: {
      Company: lead.company_name,
      Email: lead.email,
      Phone: formatUkPhone(lead.phone),
      Location: lead.location,
      "Scheduled for": lead.call_date_time || "not set",
      "Meeting link": meetingLink || "not configured",
    },
    link: "/trades?status=positive",
    linkLabel: "Open positive leads",
  });

  return ok({ lead: updated, alert_sent: alert.sent, alert_reason: alert.reason });
}
