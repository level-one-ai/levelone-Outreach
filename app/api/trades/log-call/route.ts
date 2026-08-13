import { fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { logCallSchema } from "@/lib/schema";
import type { TradeLead } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Records the outcome of a cold call.
 *
 * This is the "Call Made" modal's three buttons. It only moves the lead
 * between tabs — no email is sent here, not even for a positive outcome.
 *
 * That separation is on purpose. Logging a call and emailing a client are two
 * decisions, and collapsing them would mean a mis-click on "Positive" fires a
 * meeting invite at someone you have not agreed a time with. The positive tab
 * shows a separate "Send Meeting Email" button; that is where n8n gets
 * involved.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, logCallSchema);
  if (!parsed.success) return parsed.response;

  const { lead_id, outcome } = parsed.data;

  try {
    const pb = createPublicClient();
    const lead = await pb
      .collection(COLLECTIONS.tradesLeads)
      .update<TradeLead>(lead_id, { status: outcome });

    return ok({ lead });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.tradesLeads);
    console.error("[trades/log-call] failed:", reason);
    return fail(reason, 502);
  }
}
