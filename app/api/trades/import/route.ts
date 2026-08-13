import { fail, ok, parseBody } from "@/lib/api";
import { createPublicClient } from "@/lib/pocketbase";
import { tradesImportSchema } from "@/lib/schema";
import { importTradeLeads } from "@/lib/trades-import";
import { isTpsConfigured } from "@/lib/tps";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Imports a batch of scraped trades from outside the app.
 *
 * The in-app grid scraper does not go through this route — it calls
 * `importTradeLeads` directly — but both share that same function, so an
 * externally posted batch gets identical phone normalisation, deduplication
 * and TPS screening. There is no back door into the calling list.
 *
 * Useful for a CSV you scraped elsewhere, or a supplementary n8n/Apify run.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, tradesImportSchema);
  if (!parsed.success) return parsed.response;

  try {
    const pb = createPublicClient();
    const summary = await importTradeLeads(pb, parsed.data.leads);

    return ok({
      summary,
      tps_screening: isTpsConfigured()
        ? "active"
        : "disabled — leads saved as UNSCREENED (set TPS_PROVIDER to enable)",
    });
  } catch (err) {
    console.error("[trades/import] failed:", err);
    return fail(
      err instanceof Error ? err.message : "Import failed.",
      502
    );
  }
}
