import { fail, ok, parseBody } from "@/lib/api";
import { importB2BContacts } from "@/lib/b2b-import";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { b2bImportSchema } from "@/lib/schema";
import { isVerifierConfigured } from "@/lib/verify-email";
import type { B2BCampaign } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Pastes B2B contacts straight into a campaign's QUEUE.
 *
 * This route no longer sends anything. It used to hand the whole batch to n8n
 * the moment the import finished, which meant importing 500 leads emailed 500
 * people at once — and marked them all "sent" before n8n had confirmed a
 * single message. Contacts now land in `queued` and leave at the campaign's
 * chosen daily pace, under lib/b2b-dispatch.ts.
 *
 * Note what is NOT enrolled: contacts already in this campaign. Re-importing
 * the same list is therefore safe and will not double-email anyone — a
 * property worth relying on, because re-importing after a partial failure is
 * the natural thing to do.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, b2bImportSchema);
  if (!parsed.success) return parsed.response;

  const { campaign_id, contacts, allow_unverified } = parsed.data;
  const pb = createPublicClient();

  let campaign: B2BCampaign;
  try {
    campaign = await pb
      .collection(COLLECTIONS.b2bCampaigns)
      .getOne<B2BCampaign>(campaign_id);
  } catch (err) {
    return fail(
      `Campaign not found. ${describePocketBaseError(err, COLLECTIONS.b2bCampaigns)}`,
      404
    );
  }

  let result;
  try {
    result = await importB2BContacts(pb, campaign_id, contacts, {
      allowUnverified: allow_unverified,
      meta: { source: "paste" },
    });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bContacts);
    console.error("[b2b/import] failed:", reason);
    return fail(reason, 502);
  }

  return ok({
    summary: result.summary,
    /* What happens next, in the response, so the UI never has to imply that
       an import means an email. */
    queued: result.summary.enrolled,
    daily_send_limit: campaign.daily_send_limit || 10,
    sending_active: Boolean(campaign.sending_active),
    verification: isVerifierConfigured()
      ? "active"
      : "disabled — contacts imported as UNVERIFIED (set EMAIL_VERIFIER_PROVIDER to enable)",
  });
}
