import { fail, ok, parseBody } from "@/lib/api";
import { importB2BContacts } from "@/lib/b2b-import";
import { dispatchB2BSequence } from "@/lib/n8n";
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
 * Imports B2B contacts into a campaign and starts their sequence.
 *
 * Verification, contact deduplication and campaign enrolment all happen in
 * lib/b2b-import.ts; this route's own job is the n8n hand-off afterwards.
 *
 * Note what is NOT enrolled: contacts already in this campaign. Re-importing
 * the same list is therefore safe and will not double-email anyone — a
 * property worth relying on, because re-importing after a partial failure is
 * the natural thing to do.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, b2bImportSchema);
  if (!parsed.success) return parsed.response;

  const { campaign_id, contacts, allow_unverified, start_sequence } = parsed.data;
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
    });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bContacts);
    console.error("[b2b/import] failed:", reason);
    return fail(reason, 502);
  }

  /* Hand the whole batch to n8n in one call. The sequence webhook sends the
     first cold email and schedules the 2-day and 5-day follow-ups. */
  let sequence: { started: boolean; error?: string } = { started: false };
  if (start_sequence && result.enrolled.length > 0) {
    const dispatch = await dispatchB2BSequence(campaign, result.enrolled);
    sequence = dispatch.ok
      ? { started: true }
      : { started: false, error: dispatch.error };

    if (!dispatch.ok) {
      /* The contacts ARE enrolled and sitting in the "First Email Sent"
         column, but nothing has actually been emailed. Say so plainly rather
         than reporting a clean import. */
      console.error("[b2b/import] enrolled but sequence not started:", dispatch.error);
    }
  }

  return ok({
    summary: result.summary,
    sequence,
    verification: isVerifierConfigured()
      ? "active"
      : "disabled — contacts imported as UNVERIFIED (set EMAIL_VERIFIER_PROVIDER to enable)",
  });
}
