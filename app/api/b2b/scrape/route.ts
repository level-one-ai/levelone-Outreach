import {
  ApifyError,
  fetchDataset,
  getRun,
  isTerminal,
  normalizeDataset,
  startRun,
} from "@/lib/apify";
import { findProfile, listProfilesForClient, resolveActorId } from "@/lib/apify-actors";
import { fail, ok, parseBody } from "@/lib/api";
import { importB2BLeads } from "@/lib/b2b-import";
import {
  completeRun,
  createRun,
  bumpProgress,
  failRun,
  runDetached,
} from "@/lib/jobs";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { b2bScrapeSchema } from "@/lib/schema";
import type { ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_INTERVAL_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs an Apify scrape and drops the results into the B2B LEAD POOL.
 *
 * Deliberately campaign-free. Scraping and campaigning are separate jobs: you
 * fill the pool here, browse it on /leads, and decide later who goes into
 * which campaign. Nothing on this path enrols anyone or sends an email.
 *
 * Scraping happens inside this app, not in n8n. The actor run itself takes
 * minutes, so this follows the same pattern as the trades grid scrape: create
 * a `scrape_runs` record, return its id, and do the work detached while the
 * UI polls.
 *
 * `cells_total`/`cells_done` are reused as a two-phase progress signal here
 * (1 = actor finished, 2 = pool write finished) so one progress panel
 * component serves both scrapers.
 */
export async function POST(request: Request) {
  if (!process.env.APIFY_TOKEN) {
    return fail("APIFY_TOKEN is not configured.", 503);
  }

  const parsed = await parseBody(request, b2bScrapeSchema);
  if (!parsed.success) return parsed.response;
  const { actor_profile, form_values, niche, allow_unverified } = parsed.data;

  const profile = findProfile(actor_profile);
  if (!profile) {
    return fail(`Unknown actor profile "${actor_profile}".`, 400);
  }

  const actorId = resolveActorId(profile, form_values);
  if (!actorId) {
    return fail(
      "No Apify actor to run — set APIFY_LINKEDIN_ACTOR_ID, or supply an actor id.",
      503
    );
  }

  /* buildInput throws on malformed custom JSON. Catching it here means the
     user gets a 400 they can fix, rather than a run that fails minutes later. */
  let actorInput: Record<string, unknown>;
  try {
    actorInput = profile.buildInput(form_values);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Invalid actor input.", 400);
  }

  const pb = createPublicClient();

  let run: ScrapeRun;
  try {
    run = await createRun(
      pb,
      "b2b",
      { actor_profile, actor_id: actorId, niche, form_values },
      2
    );
  } catch (err) {
    return fail(
      `Could not start the scrape. ${describePocketBaseError(err, COLLECTIONS.scrapeRuns)}`,
      502
    );
  }

  runDetached(pb, run.id, async () => {
    try {
      // ---- Phase 1: run the actor ---------------------------------
      const started = await startRun(actorInput, actorId);

      let status = started.status;
      const deadline =
        Date.now() + Number(process.env.APIFY_RUN_TIMEOUT_SECONDS ?? 600) * 1000;

      while (!isTerminal(status)) {
        if (Date.now() > deadline) {
          throw new ApifyError("The Apify run exceeded APIFY_RUN_TIMEOUT_SECONDS.");
        }
        await sleep(POLL_INTERVAL_MS);
        status = (await getRun(started.id)).status;
      }

      if (status !== "SUCCEEDED") {
        throw new ApifyError(`The Apify run finished with status ${status}.`);
      }

      const items = await fetchDataset(started.defaultDatasetId);
      const scraped = normalizeDataset(items);

      await bumpProgress(pb, run.id, { cellsDone: 1, found: items.length });

      /* Results with no email are dropped by normalizeDataset. A run that
         found plenty but normalised to nothing means the actor does not
         return addresses — worth saying plainly, because the alternative is
         staring at an empty pool wondering what broke. */
      if (scraped.length === 0) {
        if (items.length > 0) {
          await failRun(
            pb,
            run.id,
            new Error(
              `The actor returned ${items.length} results, but none had an email address. ` +
                "Check the actor's output fields — this actor may not provide emails."
            )
          );
          return;
        }
        await completeRun(pb, run.id);
        return;
      }

      // ---- Phase 2: verify, dedupe, write to the pool --------------
      const result = await importB2BLeads(
        pb,
        scraped,
        { niche, source: "apify", scrape_run: run.id },
        { allowUnverified: allow_unverified }
      );

      await bumpProgress(pb, run.id, {
        cellsDone: 1,
        imported: result.summary.contactsCreated,
        duplicates: result.summary.contactsReused,
        blocked: result.summary.rejected,
      });

      await completeRun(pb, run.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      await failRun(pb, run.id, err);
      await sendInternalAlert("system_error", {
        subject: `B2B scrape failed — ${niche || "untitled"}`,
        summary: "The Apify scrape did not complete. No leads were added to the pool.",
        facts: { Reason: reason, Niche: niche || "—", Actor: actorId },
        link: "/leads",
        linkLabel: "Open lead pool",
      });
    }
  });

  return ok({ run_id: run.id, actor_id: actorId });
}

/**
 * Progress for the UI's polling loop, and the actor-profile catalogue the
 * scrape form renders itself from.
 */
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("run_id");

  if (!runId) {
    return ok({
      profiles: listProfilesForClient(),
      configured: Boolean(process.env.APIFY_TOKEN),
      default_actor: process.env.APIFY_LINKEDIN_ACTOR_ID ?? "",
    });
  }

  try {
    const pb = createPublicClient();
    const run = await pb
      .collection(COLLECTIONS.scrapeRuns)
      .getOne<ScrapeRun>(runId);
    return ok({ run });
  } catch (err) {
    return fail(describePocketBaseError(err, COLLECTIONS.scrapeRuns), 502);
  }
}
