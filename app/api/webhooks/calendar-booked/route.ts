import { checkWebhookAuth, fail, ok, parseBody } from "@/lib/api";
import { cancelBookingNudge } from "@/lib/n8n";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  isNotFound,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { calendarBookedSchema } from "@/lib/schema";
import type { B2BCampaign, B2BContact, B2BOutreach } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Discovery call booking receiver — WEBHOOK 3 of the system.
 *
 * Fired by your calendar tool (Cal.com, Calendly) the moment a client books.
 * Three consequences:
 *   1. `call_booked = true` — which is also what n8n's 24-hour Wait node
 *      should re-check before nudging. Writing this flag is the durable half
 *      of cancelling the nudge; the webhook call below is the immediate half.
 *   2. n8n is told to drop its pending timer.
 *   3. Resend tells you a call is in the diary.
 *
 * Publicly reachable, so it is guarded by x-webhook-secret.
 */
export async function POST(request: Request) {
  const unauthorized = checkWebhookAuth(request);
  if (unauthorized) return unauthorized;

  const parsed = await parseBody(request, calendarBookedSchema);
  if (!parsed.success) return parsed.response;

  const { outreach_id, contact_email, booked_for, booking_reference } = parsed.data;
  const pb = createPublicClient();

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
      run = await pb
        .collection(COLLECTIONS.b2bOutreach)
        .getFirstListItem<B2BOutreach>(
          pb.filter("contact = {:c}", { c: contact.id }),
          { sort: "-created", expand: "contact,campaign" }
        );
    }
  } catch (err) {
    if (isNotFound(err)) {
      /* A booking from someone who never came through this pipeline — a
         referral, or a link you shared directly. Still worth telling you
         about, but there is no record to update. */
      const alert = await sendInternalAlert("call_booked", {
        subject: contact_email ?? "Unknown contact",
        summary:
          "A discovery call was booked by someone with no matching outreach run — likely a direct or referred booking.",
        facts: {
          Email: contact_email ?? "—",
          "Booked for": booked_for || "—",
          Reference: booking_reference || "—",
        },
      });
      return ok({ matched: false, alert_sent: alert.sent });
    }
    const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
    console.error("[calendar-booked] lookup failed:", reason);
    return fail(reason, 502);
  }

  if (!run) return fail("Could not resolve the outreach run.", 404);

  // ---- 1. Record the booking ---------------------------------------
  try {
    await pb.collection(COLLECTIONS.b2bOutreach).update(run.id, {
      call_booked: true,
      call_booked_at: booked_for || new Date().toISOString(),
    });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
    console.error("[calendar-booked] update failed:", reason);
    return fail(reason, 502);
  }

  const contact = run.expand?.contact as B2BContact | undefined;
  const campaign = run.expand?.campaign as B2BCampaign | undefined;

  // ---- 2. Cancel the pending 24h nudge ------------------------------
  const cancel = await cancelBookingNudge({
    outreachId: run.id,
    contactEmail: contact?.email ?? contact_email ?? "",
    bookedFor: booked_for,
  });

  // ---- 3. Alert -----------------------------------------------------
  const alert = await sendInternalAlert("call_booked", {
    subject: `${contact?.contact_name || contact?.email || "A lead"}${
      booked_for ? `, ${booked_for}` : ""
    }`,
    summary: "A discovery call has been booked. The 24-hour nudge is cancelled.",
    facts: {
      Contact: contact?.contact_name || "—",
      Email: contact?.email ?? contact_email ?? "—",
      Company: contact?.company_name || "—",
      Campaign: campaign?.title || "—",
      "Booked for": booked_for || "—",
      Reference: booking_reference || "—",
    },
    link: "/inbox",
    linkLabel: "Open AI Inbox",
  });

  return ok({
    matched: true,
    outreach_id: run.id,
    call_booked: true,
    nudge_cancelled: cancel.ok,
    alert_sent: alert.sent,
  });
}
