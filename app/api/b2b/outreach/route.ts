import { fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  getAll,
} from "@/lib/pocketbase";
import { outreachStageSchema } from "@/lib/schema";
import { BOARD_STAGES, type B2BOutreach, type KanbanStage } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The Kanban board for one campaign.
 *
 * Returns every non-archived run with its contact expanded, so the board
 * renders from a single request. Runs that have reached `replied` are
 * returned too but counted separately — they belong in the AI Inbox, not on
 * the board.
 */
export async function GET(request: Request) {
  const campaignId = new URL(request.url).searchParams.get("campaign_id");
  if (!campaignId) return fail("campaign_id is required.");

  try {
    const pb = createPublicClient();
    const runs = await getAll<B2BOutreach>(pb, COLLECTIONS.b2bOutreach, {
      filter: pb.filter("campaign = {:k} && archived = false", { k: campaignId }),
      sort: "-created",
      expand: "contact",
    });

    const board = Object.fromEntries(
      BOARD_STAGES.map((stage) => [
        stage,
        /* `sending` is a claim that normally lasts seconds. Show those cards in
           Queued rather than giving a near-always-empty column a third of the
           board — they have not been emailed yet, so that is where they read
           correctly. */
        stage === "queued"
          ? runs.filter(
              (r) => r.kanban_stage === "queued" || r.kanban_stage === "sending"
            )
          : runs.filter((r) => r.kanban_stage === stage),
      ])
    ) as Record<KanbanStage, B2BOutreach[]>;

    return ok({
      board,
      replied: runs.filter((r) => r.kanban_stage === "replied"),
      /* Surfaced as a strip above the board: these need a decision, not a
         column in the flow. */
      failed: runs.filter((r) => r.kanban_stage === "send_failed"),
      total: runs.length,
    });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
    console.error("[b2b/outreach] board failed:", reason);
    return fail(reason, 502);
  }
}

/**
 * Moves a run between columns.
 *
 * Manual moves only. The normal path through the board is driven by n8n's
 * Wait nodes calling back as each follow-up goes out, and by the inbound-reply
 * webhook jumping a run straight to `replied`. This exists for the times you
 * need to correct the board by hand.
 */
export async function PATCH(request: Request) {
  const parsed = await parseBody(request, outreachStageSchema);
  if (!parsed.success) return parsed.response;

  const { outreach_id, kanban_stage } = parsed.data;

  try {
    const pb = createPublicClient();
    const run = await pb
      .collection(COLLECTIONS.b2bOutreach)
      .update<B2BOutreach>(outreach_id, {
        kanban_stage,
        // Moving to a sent/follow-up column is a statement that an email just
        // went out, so keep the timestamp consistent with that. Moving BACK to
        // queued is the opposite statement — clear it, and reset the claim so
        // the next batch can pick this lead up.
        ...(kanban_stage === "queued"
          ? {
              last_email_sent_at: "",
              dispatched_at: "",
              queued_at: new Date().toISOString(),
              send_error: "",
            }
          : {}),
        ...(kanban_stage !== "replied" && kanban_stage !== "queued" && kanban_stage !== "send_failed"
          ? { last_email_sent_at: new Date().toISOString() }
          : {}),
      });
    return ok({ run });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.b2bOutreach);
    console.error("[b2b/outreach] stage move failed:", reason);
    return fail(reason, 502);
  }
}
