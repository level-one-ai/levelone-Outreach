import { fail, ok, parseBody } from "@/lib/api";
import { dispatchDueCampaigns } from "@/lib/b2b-dispatch";
import { COLLECTIONS, createPublicClient, describePocketBaseError, getAll } from "@/lib/pocketbase";
import { dispatchNowSchema } from "@/lib/schema";
import type { B2BOutreach } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * "Send the next batch now" — the manual half of the send engine.
 *
 * Runs the same code the minute-by-minute ticker runs, with the clock and the
 * once-a-day lock bypassed. It does NOT bypass the daily limit and it still
 * only ever selects `queued` runs, so pressing it twice sends the next batch
 * once and then finds nothing to do. That is the point: no button in this app
 * can email the same person the same first email twice.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, dispatchNowSchema);
  if (!parsed.success) return parsed.response;

  const results = await dispatchDueCampaigns({ force: parsed.data.campaign_id });
  const result = results[0];

  if (!result) return fail("Campaign not found.", 404);
  if (result.error) return fail(result.error, 502);

  return ok({ result });
}

/**
 * Queue state for the campaign header — how many are waiting, how many have
 * gone, and when the next batch is due.
 */
export async function GET(request: Request) {
  const campaignId = new URL(request.url).searchParams.get("campaign_id");
  if (!campaignId) return fail("campaign_id is required.");

  try {
    const pb = createPublicClient();
    const runs = await getAll<B2BOutreach>(pb, COLLECTIONS.b2bOutreach, {
      filter: pb.filter("campaign = {:k} && archived = false", { k: campaignId }),
    });

    const count = (stage: string) =>
      runs.filter((r) => r.kanban_stage === stage).length;

    return ok({
      queued: count("queued"),
      sending: count("sending"),
      failed: count("send_failed"),
      /* Everything past the first email — the campaign's real reach so far. */
      contacted: runs.filter((r) =>
        ["sent_1", "followup_2d", "followup_5d", "replied"].includes(r.kanban_stage)
      ).length,
    });
  } catch (err) {
    return fail(describePocketBaseError(err, COLLECTIONS.b2bOutreach), 502);
  }
}
