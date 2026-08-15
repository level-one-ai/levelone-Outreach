/**
 * The app's own clock.
 *
 * Next 15 calls `register()` once when the server process boots. That is the
 * only hook this app needs to be its own scheduler: n8n stays a mail
 * transport, and nothing external has to poke a cron URL for emails to go out.
 *
 * The ticker fires every minute and asks the dispatcher "is anything due?".
 * Almost every tick answers no after one filtered read — the campaign's
 * `send_time` and `last_dispatch_date` do the real deciding, not the interval.
 * A minute is simply fine enough resolution to hit a chosen send time.
 *
 * Runs on Coolify, where the Node process is long-lived (docs/OPERATIONS.md
 * §9). On a serverless host there is no persistent process to hold an
 * interval — there, set DISPATCH_TICKER_ENABLED=false and POST
 * /api/b2b/dispatch from a platform cron instead.
 */

const TICK_MS = 60_000;

/** Module-level, so dev-mode HMR cannot stack a second interval. */
let started = false;

export async function register() {
  // Next also runs this in the edge runtime, which has no PocketBase client
  // and no business scheduling anything.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.DISPATCH_TICKER_ENABLED === "false") {
    console.info("[ticker] disabled by DISPATCH_TICKER_ENABLED=false.");
    return;
  }

  /* Two replicas would each run a ticker. The day lock in b2b-dispatch means
     that is safe rather than duplicating sends, but it is still wasted reads —
     hence the env switch above for the second replica. */
  if (started) return;
  started = true;

  const { dispatchDueCampaigns } = await import("@/lib/b2b-dispatch");

  const tick = async () => {
    try {
      const results = await dispatchDueCampaigns();
      for (const r of results) {
        if (r.sent > 0) {
          console.info(`[ticker] sent ${r.sent} to "${r.campaign_title}".`);
        }
        if (r.error) {
          console.error(`[ticker] "${r.campaign_title}": ${r.error}`);
        }
      }
    } catch (err) {
      /* Never rethrow: an unhandled rejection here would take the server down
         and stop every future tick over one bad minute. */
      console.error("[ticker] dispatch pass failed:", err);
    }
  };

  const timer = setInterval(tick, TICK_MS);
  /* Do not hold the process open on shutdown just because a timer exists. */
  if (typeof timer.unref === "function") timer.unref();

  console.info(`[ticker] daily B2B dispatch check running every ${TICK_MS / 1000}s.`);
}
