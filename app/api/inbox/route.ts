import { fail, ok } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  getAll,
} from "@/lib/pocketbase";
import type { B2BOutreach, ReplySentiment } from "@/lib/types";

export const dynamic = "force-dynamic";

const SENTIMENTS: ReplySentiment[] = ["positive", "negative", "no_reply"];

/**
 * The AI Inbox: every run that has received a reply, grouped by Gemini's
 * sentiment classification.
 *
 * Archived runs are excluded — a negative reply you have already apologised to
 * is finished business and does not belong in a working inbox.
 */
export async function GET(request: Request) {
  const campaignId = new URL(request.url).searchParams.get("campaign_id");

  try {
    const pb = createPublicClient();
    const filter = campaignId
      ? pb.filter(
          "kanban_stage = 'replied' && archived = false && campaign = {:k}",
          { k: campaignId }
        )
      : "kanban_stage = 'replied' && archived = false";

    const runs = await getAll<B2BOutreach>(pb, COLLECTIONS.b2bOutreach, {
      filter,
      sort: "-updated",
      expand: "contact,campaign",
    });

    const grouped = Object.fromEntries(
      SENTIMENTS.map((s) => [s, runs.filter((r) => r.reply_sentiment === s)])
    ) as Record<ReplySentiment, B2BOutreach[]>;

    // Runs still awaiting classification would otherwise vanish from the UI.
    grouped.pending = runs.filter((r) => r.reply_sentiment === "pending");

    return ok({ groups: grouped, total: runs.length });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
    console.error("[inbox] list failed:", reason);
    return fail(reason, 502);
  }
}
