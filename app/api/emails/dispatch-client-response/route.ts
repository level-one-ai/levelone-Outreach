import { fail, ok, parseBody } from "@/lib/api";
import { dispatchPositiveResponse } from "@/lib/n8n";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { dispatchResponseSchema } from "@/lib/schema";
import type { B2BCampaign, B2BContact, B2BOutreach } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * "Send Response" on a positive reply — the busiest single action in the app.
 *
 * Four things happen, in this order:
 *   1. n8n emails the CLIENT your approved draft, with the discovery call
 *      link, and starts its 24-hour booking timer.
 *   2. The outbound message is logged to `messages`.
 *   3. The run is marked as responded.
 *   4. Resend tells YOU the deal is moving.
 *
 * n8n goes first for the same reason as the trades meeting email: if the
 * webhook fails, nothing is recorded and nothing is claimed. You get an error
 * and the draft is still sitting there to retry.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, dispatchResponseSchema);
  if (!parsed.success) return parsed.response;

  const { outreach_id, subject, body } = parsed.data;
  const discoveryCallLink =
    parsed.data.discovery_call_link || process.env.DISCOVERY_CALL_LINK || "";

  const pb = createPublicClient();

  let run: B2BOutreach;
  try {
    run = await pb
      .collection(COLLECTIONS.b2bOutreach)
      .getOne<B2BOutreach>(outreach_id, { expand: "contact,campaign" });
  } catch (err) {
    return fail(
      `Outreach run not found. ${describePocketBaseError(err, COLLECTIONS.b2bOutreach)}`,
      404
    );
  }

  const contact = run.expand?.contact as B2BContact | undefined;
  const campaign = run.expand?.campaign as B2BCampaign | undefined;

  if (!contact || !campaign) {
    return fail(
      "This outreach run is missing its contact or campaign relation — it cannot be emailed.",
      422
    );
  }

  // ---- 1. Client email + 24h tracker, via n8n ----------------------
  const dispatch = await dispatchPositiveResponse({
    outreachId: run.id,
    contact,
    campaign,
    subject,
    body,
    discoveryCallLink,
  });

  if (!dispatch.ok) {
    return fail(`The response was not sent. ${dispatch.error}`, 502);
  }

  // ---- 2 + 3. Record what was sent ---------------------------------
  const sentAt = new Date().toISOString();
  try {
    await pb.collection(COLLECTIONS.messages).create({
      outreach_run: run.id,
      direction: "outbound",
      subject,
      body,
      sent_at: sentAt,
    });
  } catch (err) {
    console.error(
      "[dispatch-client-response] message log failed:",
      describePocketBaseError(err, COLLECTIONS.messages)
    );
  }

  try {
    await pb.collection(COLLECTIONS.b2bOutreach).update(run.id, {
      last_email_sent_at: sentAt,
      // The draft has been used; clearing it stops the inbox offering to
      // send the same reply a second time.
      ai_draft_reply: "",
    });
  } catch (err) {
    console.error(
      "[dispatch-client-response] run update failed:",
      describePocketBaseError(err, COLLECTIONS.b2bOutreach)
    );
  }

  // ---- 4. Internal alert, via Resend -------------------------------
  const alert = await sendInternalAlert("response_sent", {
    subject: `${contact.contact_name || contact.email} · 24h call tracker started`,
    summary: `Your response has been sent. n8n will nudge them in 24 hours if no discovery call is booked.`,
    facts: {
      Contact: contact.contact_name || "—",
      Email: contact.email,
      Company: contact.company_name,
      Campaign: campaign.title,
      "Sent from": campaign.from_email,
      Subject: subject,
      "Booking link": discoveryCallLink || "not configured",
    },
    link: "/inbox",
    linkLabel: "Open AI Inbox",
  });

  return ok({
    outreach_id: run.id,
    sent_at: sentAt,
    tracker_hours: 24,
    alert_sent: alert.sent,
    alert_reason: alert.reason,
  });
}
