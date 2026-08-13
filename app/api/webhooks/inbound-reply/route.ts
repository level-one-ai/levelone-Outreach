import { checkWebhookAuth, fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  isNotFound,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { inboundReplySchema } from "@/lib/schema";
import type { B2BCampaign, B2BContact, B2BOutreach } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Inbound reply receiver — WEBHOOK 1 of the system.
 *
 * n8n captures the client's reply, hands it to Gemini for classification and
 * (for positives) a drafted response, then POSTs the result here.
 *
 * This route does the three things that follow from a reply arriving:
 *   1. Marks the run `replied`, which is the AUTO-PAUSE. n8n's follow-up Wait
 *      nodes re-check this stage before sending, so a client who replies on
 *      day 3 never receives the day-5 follow-up.
 *   2. Stores the sentiment, the AI draft, and the raw inbound message.
 *   3. Alerts you by Resend — but only for a POSITIVE reply. A negative one is
 *      handled from the inbox at your convenience and does not warrant
 *      interrupting you.
 *
 * Publicly reachable, so it is guarded by x-webhook-secret.
 */
export async function POST(request: Request) {
  const unauthorized = checkWebhookAuth(request);
  if (unauthorized) return unauthorized;

  const parsed = await parseBody(request, inboundReplySchema);
  if (!parsed.success) return parsed.response;

  const {
    outreach_id,
    contact_email,
    campaign_id,
    sentiment,
    ai_draft_reply,
    subject,
    body,
    received_at,
  } = parsed.data;

  const pb = createPublicClient();

  /* Resolve the run. n8n knows the outreach_id when the reply came back
     through the sequence; a mailbox trigger only knows who sent it, so we
     fall back to the most recent live run for that address. */
  let run: B2BOutreach | null = null;
  try {
    if (outreach_id) {
      run = await pb
        .collection(COLLECTIONS.b2bOutreach)
        .getOne<B2BOutreach>(outreach_id, { expand: "contact,campaign" });
    } else if (contact_email) {
      const contact = await pb
        .collection(COLLECTIONS.b2bContacts)
        .getFirstListItem<B2BContact>(
          pb.filter("email = {:email}", { email: contact_email.toLowerCase() })
        );

      const filter = campaign_id
        ? pb.filter("contact = {:c} && campaign = {:k} && archived = false", {
            c: contact.id,
            k: campaign_id,
          })
        : pb.filter("contact = {:c} && archived = false", { c: contact.id });

      run = await pb
        .collection(COLLECTIONS.b2bOutreach)
        .getFirstListItem<B2BOutreach>(filter, {
          sort: "-created",
          expand: "contact,campaign",
        });
    }
  } catch (err) {
    if (isNotFound(err)) {
      /* 404 rather than 500: this is a reply to something we have no record
         of — a forwarded thread, or a campaign since deleted. n8n should not
         redeliver it. */
      return fail(
        `No live outreach run found for ${outreach_id ?? contact_email}.`,
        404
      );
    }
    const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
    console.error("[inbound-reply] lookup failed:", reason);
    return fail(reason, 502);
  }

  if (!run) return fail("Could not resolve the outreach run.", 404);

  const receivedAt = received_at || new Date().toISOString();

  // ---- 1 + 2. Pause the sequence and record the reply --------------
  let updated: B2BOutreach;
  try {
    updated = await pb
      .collection(COLLECTIONS.b2bOutreach)
      .update<B2BOutreach>(run.id, {
        kanban_stage: "replied",
        reply_sentiment: sentiment,
        ai_draft_reply,
      });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
    console.error("[inbound-reply] update failed:", reason);
    return fail(reason, 502);
  }

  try {
    await pb.collection(COLLECTIONS.messages).create({
      outreach_run: run.id,
      direction: "inbound",
      subject,
      body,
      sent_at: receivedAt,
    });
  } catch (err) {
    console.error(
      "[inbound-reply] message log failed:",
      describePocketBaseError(err, COLLECTIONS.messages)
    );
  }

  // ---- 3. Alert, positives only ------------------------------------
  const contact = run.expand?.contact as B2BContact | undefined;
  const campaign = run.expand?.campaign as B2BCampaign | undefined;
  let alertSent = false;

  if (sentiment === "positive") {
    const alert = await sendInternalAlert("positive_reply_received", {
      subject: `${contact?.contact_name || contact?.email || "A lead"}${
        contact?.company_name ? ` @ ${contact.company_name}` : ""
      }`,
      summary:
        "A positive reply just landed and Gemini has drafted a response for you to review.",
      facts: {
        Contact: contact?.contact_name || "—",
        Email: contact?.email ?? "—",
        Company: contact?.company_name || "—",
        Campaign: campaign?.title || "—",
        "Their subject": subject || "—",
        "Their message": body ? body.slice(0, 400) : "—",
      },
      link: "/inbox",
      linkLabel: "Review and send",
    });
    alertSent = alert.sent;
  }

  return ok({
    outreach_id: updated.id,
    kanban_stage: updated.kanban_stage,
    sentiment,
    sequence_paused: true,
    alert_sent: alertSent,
  });
}
