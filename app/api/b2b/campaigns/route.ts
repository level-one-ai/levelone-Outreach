import { fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  getAll,
} from "@/lib/pocketbase";
import { campaignSchema, campaignUpdateSchema } from "@/lib/schema";
import type { B2BCampaign } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Campaigns — the reusable half of the B2B model.
 *
 * A campaign is an offer, a sending identity ("Q3 Automation Pitch", from
 * dean@…) and a pace — how many first emails a day, at what time. Contacts
 * live separately in the pool, so the same lead can be enrolled in a new
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
      .create<B2BCampaign>({ ...parsed.data, last_dispatch_date: "" });
    return ok({ campaign });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bCampaigns);
    console.error("[b2b/campaigns] create failed:", reason);
    return fail(reason, 502);
  }
}

/**
 * Edits a campaign — including the send controls and the Start/Pause switch.
 *
 * Turning `sending_active` on clears `last_dispatch_date`, so pressing Start
 * mid-afternoon sends today's batch rather than waiting until tomorrow because
 * a previous run had already claimed the date.
 */
export async function PATCH(request: Request) {
  const parsed = await parseBody(request, campaignUpdateSchema);
  if (!parsed.success) return parsed.response;

  const { id, ...patch } = parsed.data;
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  );

  if (Object.keys(fields).length === 0) return fail("No fields to update.");

  try {
    const pb = createPublicClient();

    if (fields.sending_active === true) {
      const current = await pb
        .collection(COLLECTIONS.b2bCampaigns)
        .getOne<B2BCampaign>(id);
      if (!current.sending_active) fields.last_dispatch_date = "";
    }

    const campaign = await pb
      .collection(COLLECTIONS.b2bCampaigns)
      .update<B2BCampaign>(id, fields);
    return ok({ campaign });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bCampaigns);
    console.error("[b2b/campaigns] update failed:", reason);
    return fail(reason, 502);
  }
}
