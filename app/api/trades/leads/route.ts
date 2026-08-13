import { fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  getAll,
} from "@/lib/pocketbase";
import { tradesUpdateSchema } from "@/lib/schema";
import type { TradeLead, TradeStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: TradeStatus[] = ["scraped", "negative", "no_answer", "positive"];

/**
 * Lists trade leads for one status tab.
 *
 * Also returns the count for every tab in one go, so switching tabs never
 * needs a second round trip just to keep the badge numbers honest.
 */
export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status") ?? "scraped";
  if (!STATUSES.includes(status as TradeStatus)) {
    return fail(`Unknown status "${status}".`);
  }

  try {
    const pb = createPublicClient();
    const all = await getAll<TradeLead>(pb, COLLECTIONS.tradesLeads, {
      sort: "-created",
    });

    const counts = Object.fromEntries(
      STATUSES.map((s) => [s, all.filter((l) => l.status === s).length])
    ) as Record<TradeStatus, number>;

    return ok({ leads: all.filter((l) => l.status === status), counts });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.tradesLeads);
    console.error("[trades/leads] list failed:", reason);
    return fail(reason, 502);
  }
}

/**
 * Inline edits from a lead card — the email field and the call date picker.
 *
 * Deliberately narrow: only the three fields the card can actually change are
 * writable. A phone number or TPS status must never be editable from the UI,
 * because both are the output of checks that this route does not re-run.
 */
export async function PATCH(request: Request) {
  const parsed = await parseBody(request, tradesUpdateSchema);
  if (!parsed.success) return parsed.response;

  const { id, ...patch } = parsed.data;
  const fields = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  );

  if (Object.keys(fields).length === 0) {
    return fail("No editable fields were supplied.");
  }

  try {
    const pb = createPublicClient();
    const lead = await pb
      .collection(COLLECTIONS.tradesLeads)
      .update<TradeLead>(id, fields);
    return ok({ lead });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.tradesLeads);
    console.error("[trades/leads] update failed:", reason);
    return fail(reason, 502);
  }
}
