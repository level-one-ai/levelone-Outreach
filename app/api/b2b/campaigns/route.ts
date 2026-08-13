import { fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  getAll,
} from "@/lib/pocketbase";
import { campaignSchema } from "@/lib/schema";
import type { B2BCampaign } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Campaigns — the reusable half of the B2B model.
 *
 * A campaign is an offer plus a sending identity ("Q3 Automation Pitch", from
 * dean@…). Contacts live separately, so the same lead can be enrolled in a new
 * campaign months later without their contact record being duplicated.
 */
export async function GET() {
  try {
    const pb = createPublicClient();
    const campaigns = await getAll<B2BCampaign>(pb, COLLECTIONS.b2bCampaigns, {
      sort: "-created",
    });
    return ok({ campaigns });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bCampaigns);
    console.error("[b2b/campaigns] list failed:", reason);
    return fail(reason, 502);
  }
}

export async function POST(request: Request) {
  const parsed = await parseBody(request, campaignSchema);
  if (!parsed.success) return parsed.response;

  try {
    const pb = createPublicClient();
    const campaign = await pb
      .collection(COLLECTIONS.b2bCampaigns)
      .create<B2BCampaign>(parsed.data);
    return ok({ campaign });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bCampaigns);
    console.error("[b2b/campaigns] create failed:", reason);
    return fail(reason, 502);
  }
}
