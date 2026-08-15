import { fail, ok, parseBody } from "@/lib/api";
import { enrolContacts } from "@/lib/b2b-import";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { b2bEnrolSchema } from "@/lib/schema";
import type { B2BCampaign, B2BContact } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Moves pooled contacts into a campaign's send queue.
 *
 * Emphatically does NOT email anyone. Every contact lands in `queued` and
 * waits for the campaign's daily batch — which is why you can safely tip 500
 * leads into a campaign that sends 10 a day and know exactly what happens
 * next.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, b2bEnrolSchema);
  if (!parsed.success) return parsed.response;
  const { campaign_id, contact_ids } = parsed.data;

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

  /* Load the real records rather than trusting the ids: enrolContacts needs
     each contact's current pool_status, and a stale id from the browser
     should fail here rather than create a run pointing at nothing. */
  const contacts: B2BContact[] = [];
  const missing: string[] = [];
  for (const id of contact_ids) {
    try {
      contacts.push(
        await pb.collection(COLLECTIONS.b2bContacts).getOne<B2BContact>(id)
      );
    } catch {
      missing.push(id);
    }
  }

  if (contacts.length === 0) {
    return fail("None of those leads could be found in the pool.", 404);
  }

  try {
    const { summary, enrolled } = await enrolContacts(pb, campaign_id, contacts);
    return ok({
      summary: { ...summary, missing: missing.length },
      queued: enrolled.length,
      campaign: { id: campaign.id, title: campaign.title },
    });
  } catch (err) {
    return fail(describePocketBaseError(err, COLLECTIONS.b2bOutreach), 502);
  }
}
