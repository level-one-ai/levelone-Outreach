import type { TpsStatus } from "@/lib/types";
import { isUkMobile } from "@/lib/phone";

/**
 * TPS / CTPS screening — UK cold-calling compliance.
 *
 * ===========================================================================
 *  READ THIS BEFORE YOU RELY ON IT
 * ===========================================================================
 * There is no free or official public TPS lookup API. The register is licensed
 * commercially, and real screening requires a paid provider — Data8, TPS
 * Services, or a DMA TPS Assured feed.
 *
 * So this module is deliberately built as a pluggable adapter with an honest
 * default. With TPS_PROVIDER=none, every lead is saved as `unchecked` and the
 * UI shows an amber "UNSCREENED" badge. The system will never mark a number
 * TPS-clear that has not actually been screened, because a false "clear" is
 * how you end up making an unlawful call believing you were compliant.
 *
 * Calling a TPS-registered number without prior consent breaches PECR
 * (regulation 21) and is enforced by the ICO with fines. Screening is your
 * legal obligation, not a nice-to-have.
 */

const PROVIDER = (process.env.TPS_PROVIDER ?? "none").toLowerCase();
const API_URL = process.env.TPS_API_URL ?? "";
const API_KEY = process.env.TPS_API_KEY ?? "";

/** When true, listed numbers are discarded at import instead of stored. */
export const BLOCK_LISTED = (process.env.TPS_BLOCK_LISTED ?? "true") !== "false";

export interface TpsCheck {
  status: TpsStatus;
  /** True only when a real provider confirmed the number is NOT registered. */
  verified: boolean;
}

const UNCHECKED: TpsCheck = { status: "unchecked", verified: false };

export function isTpsConfigured(): boolean {
  return PROVIDER === "http" && Boolean(API_URL);
}

/**
 * Screens one number.
 *
 * Never throws. A provider outage during a 2,000-lead scrape must degrade to
 * "error" on the affected leads rather than kill the run — and an `error`
 * status is treated exactly like `unchecked` downstream: not safe to call.
 */
export async function checkTps(e164Phone: string): Promise<TpsCheck> {
  if (PROVIDER === "none" || !API_URL) return UNCHECKED;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        phone: e164Phone,
        // Landlines are TPS; business numbers are CTPS. Ask for both — a
        // scraped trade could be either, and we cannot tell from the number.
        registers: isUkMobile(e164Phone) ? ["tps"] : ["tps", "ctps"],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`[tps] provider replied ${res.status} for ${e164Phone}`);
      return { status: "error", verified: false };
    }

    const body = (await res.json()) as Record<string, unknown>;

    /* Providers disagree on field naming; accept the common spellings rather
       than forcing you to write an adapter for whichever one you sign with. */
    const listed =
      body.listed ?? body.isListed ?? body.onTps ?? body.tps ?? body.registered;

    if (typeof listed !== "boolean") {
      console.error(`[tps] unrecognised provider response for ${e164Phone}`, body);
      return { status: "error", verified: false };
    }

    return listed
      ? { status: "listed", verified: false }
      : { status: "clear", verified: true };
  } catch (err) {
    console.error(`[tps] check failed for ${e164Phone}:`, err);
    return { status: "error", verified: false };
  }
}

/** Screens a batch with bounded concurrency. Order is preserved. */
export async function checkTpsBatch(
  phones: string[],
  concurrency = 5
): Promise<TpsCheck[]> {
  if (!isTpsConfigured()) return phones.map(() => UNCHECKED);

  const results: TpsCheck[] = new Array(phones.length);
  let cursor = 0;

  async function worker() {
    while (cursor < phones.length) {
      const i = cursor++;
      results[i] = await checkTps(phones[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, phones.length) }, worker)
  );
  return results;
}

/** Whether a screened lead may enter the active calling list. */
export function isCallable(check: TpsCheck): boolean {
  return check.status !== "listed";
}
