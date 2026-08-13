import {
  ApifyError,
  fetchDataset,
  getRun,
  isApifyConfigured,
  isTerminal,
  normalizeDataset,
  startRun,
} from "@/lib/apify";
import { fail, ok, parseBody } from "@/lib/api";
import { importB2BContacts } from "@/lib/b2b-import";
import {
  completeRun,
  createRun,
  bumpProgress,
  failRun,
  runDetached,
} from "@/lib/jobs";
import { dispatchB2BSequence } from "@/lib/n8n";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
} from "@/lib/pocketbase";
import { sendInternalAlert } from "@/lib/resend";
import { b2bScrapeSchema } from "@/lib/schema";
import type { B2BCampaign, ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_INTERVAL_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs an Apify LinkedIn scrape and imports the results into a campaign.
 *
 * Scraping happens inside this app, not in n8n. The actor run itself takes
 * minutes, so this follows the same pattern as the trades grid scrape: create
 * a `scrape_runs` record, return its id, and do the work detached while the
 * UI polls.
 *
 * `cells_total`/`cells_done` are reused as a two-phase progress signal here
 * (1 = actor finished, 2 = import finished) so one progress panel component
 * serves both scrapers.
 */
export async function POST(request: Request) {
  if (!isApifyConfigured()) {
    return fail(
      "APIFY_TOKEN and APIFY_LINKEDIN_ACTOR_ID must both be configured.",
      503
    );
  }

  const parsed = await parseBody(request, b2bScrapeSchema);
  if (!parsed.success) return parsed.response;
  const { campaign_id, actor_input } = parsed.data;

  const pb = createPublicClient();

  let campaign: B2BCampaign;
  try {
    campaign = await pb
      .collection(COLLECTIONS.b2bCampaigns)
      .getOne<B2BCampaign>(campaign_id);
  } catch (err) {
    return fail(
      `Campaign not found. ${describePocketBaseError(err, COLLECTIONS.b2bCampaigns)}`,
      404
    );
  }

  let run: ScrapeRun;
  try {
    run = await createRun(pb, "b2b", { campaign_id, actor_input }, 2);
  } catch (err) {
    return fail(
      `Could not start the scrape. ${describePocketBaseError(err, COLLECTIONS.scrapeRuns)}`,
      502
    );
  }

  runDetached(pb, run.id, async () => {
    try {
      // ---- Phase 1: run the actor ---------------------------------
      const started = await startRun(actor_input);

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

      if (scraped.length === 0) {
        await completeRun(pb, run.id);
        return;
      }

      // ---- Phase 2: verify, dedupe, enrol -------------------------
      const result = await importB2BContacts(pb, campaign_id, scraped);

      await bumpProgress(pb, run.id, {
        cellsDone: 1,
        imported: result.summary.enrolled,
        duplicates: result.summary.alreadyInCampaign,
        blocked: result.summary.rejected,
      });

      // ---- Phase 3: hand the batch to n8n -------------------------
      if (result.enrolled.length > 0) {
        const dispatch = await dispatchB2BSequence(campaign, result.enrolled);
        if (!dispatch.ok) {
          await sendInternalAlert("system_error", {
            subject: `Sequence not started — ${campaign.title}`,
            summary: `${result.enrolled.length} contacts were enrolled from an Apify scrape, but the n8n sequence webhook failed. Nothing has been emailed.`,
            facts: { Reason: dispatch.error ?? "unknown", Campaign: campaign.title },
            link: "/b2b",
            linkLabel: "Open B2B board",
          });
        }
      }

      await completeRun(pb, run.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      await failRun(pb, run.id, err);
      await sendInternalAlert("system_error", {
        subject: `B2B scrape failed — ${campaign.title}`,
        summary: "The Apify LinkedIn scrape did not complete.",
        facts: { Reason: reason, Campaign: campaign.title },
        link: "/b2b",
        linkLabel: "Open B2B board",
      });
    }
  });

  return ok({ run_id: run.id });
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
    return fail(describePocketBaseError(err, COLLECTIONS.scrapeRuns), 502);
  }
}
