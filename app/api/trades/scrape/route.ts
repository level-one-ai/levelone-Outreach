import { fail, ok, parseBody } from "@/lib/api";
import { estimateApiCalls, generateGrid } from "@/lib/grid";
import {
  createRun,
  bumpProgress,
  completeRun,
  failRun,
  runDetached,
} from "@/lib/jobs";
import {
  fetchDetails,
  geocode,
  isPlacesConfigured,
  mapWithConcurrency,
  searchCell,
} from "@/lib/places";
import { COLLECTIONS, createPublicClient, describePocketBaseError } from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { tradesScrapeSchema } from "@/lib/schema";
import { importTradeLeads, type RawTradeLead } from "@/lib/trades-import";
import type { ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";
/* Cells are processed one at a time with a 2s pause between result pages, so
   a large grid runs for minutes. The detached loop outlives the response, but
   the platform still needs to be told not to reap the function early. */
export const maxDuration = 300;

const MAX_CELLS = Number(process.env.PLACES_MAX_CELLS ?? 120);

/**
 * Starts a Google Maps grid scrape and returns immediately with a run id.
 *
 * The grid is what beats Google's 120-result ceiling: instead of one search
 * over a whole town, we run one small search per cell across a lattice
 * covering it. See lib/grid.ts for the geometry.
 *
 * Nothing about the run's progress lives in the browser — it is all in the
 * `scrape_runs` record — so closing the tab does not stop the scrape.
 */
export async function POST(request: Request) {
  if (!isPlacesConfigured()) {
    return fail(
      "GOOGLE_PLACES_API_KEY is not configured — the scraper cannot run.",
      503
    );
  }

  const parsed = await parseBody(request, tradesScrapeSchema);
  if (!parsed.success) return parsed.response;
  const { query, keyword, searchRadius, cellRadius } = parsed.data;

  // Resolve the centre point.
  let lat = parsed.data.lat;
  let lng = parsed.data.lng;
  let label = query ?? "";

  if (lat === undefined || lng === undefined) {
    try {
      const hit = await geocode(query!);
      if (!hit) return fail(`Could not find a location matching "${query}".`, 404);
      lat = hit.lat;
      lng = hit.lng;
      label = hit.label;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "geocoding failed";
      console.error("[trades/scrape] geocode failed:", reason);
      return fail(reason, 502);
    }
  }

  const cells = generateGrid({
    lat,
    lng,
    searchRadius,
    cellRadius,
    maxCells: MAX_CELLS,
  });

  if (cells.length === 0) {
    return fail("That search area produced no grid cells — check the radius.");
  }

  const pb = createPublicClient();
  let run: ScrapeRun;
  try {
    run = await createRun(
      pb,
      "trades",
      { query: label, keyword, lat, lng, searchRadius, cellRadius },
      cells.length
    );
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.scrapeRuns);
    console.error("[trades/scrape] could not create run:", reason);
    return fail(`Could not start the scrape. ${reason}`, 502);
  }

  runDetached(pb, run.id, async () => {
    const seenPlaceIds = new Set<string>();

    try {
    for (const cell of cells) {
      let results: Array<{ place_id: string; name: string; address: string }>;
      try {
        results = await searchCell(cell, keyword);
      } catch (err) {
        /* One bad cell must not end a 60-cell run — a transient Places error
           costs us that cell's leads, not the whole scrape. A hard failure
           (bad key, billing disabled) will fail every cell and the run simply
           finishes having imported nothing, with the reason in the log. */
        console.error(`[trades/scrape] cell ${cell.id} failed:`, err);
        await bumpProgress(pb, run.id, { cellsDone: 1 });
        continue;
      }

      // Overlapping cells return the same business repeatedly. Drop those
      // before spending a Place Details call on them.
      const fresh = results.filter((r) => {
        if (seenPlaceIds.has(r.place_id)) return false;
        seenPlaceIds.add(r.place_id);
        return true;
      });

      const detailed = await mapWithConcurrency<
        (typeof fresh)[number],
        RawTradeLead | null
      >(fresh, 5, async (r) => {
        const details = await fetchDetails(r.place_id);
        if (!details?.phone) return null; // No number: useless for calling.
        return {
          company_name: r.name,
          location: details.address || r.address,
          phone: details.phone,
          website: details.website,
          place_id: r.place_id,
          grid_cell: cell.id,
        };
      });

      const batch = detailed.filter((d): d is RawTradeLead => d !== null);

      if (batch.length > 0) {
        const summary = await importTradeLeads(pb, batch);
        await bumpProgress(pb, run.id, {
          cellsDone: 1,
          found: results.length,
          imported: summary.imported,
          duplicates: summary.duplicates,
          blocked: summary.tpsBlocked + summary.invalid,
        });
      } else {
        await bumpProgress(pb, run.id, { cellsDone: 1, found: results.length });
      }
    }

      await completeRun(pb, run.id);
    } catch (err) {
      /* A scrape you started and walked away from is exactly the kind of
         thing you would otherwise discover hours later. */
      const reason = err instanceof Error ? err.message : "unknown error";
      await failRun(pb, run.id, err);
      await sendInternalAlert("system_error", {
        subject: "Trades scrape failed",
        summary: `The grid scrape for "${keyword}" near ${label} stopped early.`,
        facts: { Reason: reason, "Cells planned": cells.length },
        link: "/trades",
        linkLabel: "Open trades board",
      });
    }
  });

  return ok({
    run_id: run.id,
    cells: cells.length,
    centre: { lat, lng, label },
    estimate: estimateApiCalls(cells.length),
  });
}

/** Progress for the UI's polling loop. */
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("run_id");
  if (!runId) return fail("run_id is required.");

  try {
    const pb = createPublicClient();
    const run = await pb
      .collection(COLLECTIONS.scrapeRuns)
      .getOne<ScrapeRun>(runId);
    return ok({ run });
  } catch (err) {
    const reason = describePocketBaseError(err, COLLECTIONS.scrapeRuns);
    return fail(reason, 502);
  }
}
