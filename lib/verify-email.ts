/**
 * Email deliverability verification — the B2B pipeline's quality gate.
 *
 * Cold email lives or dies on bounce rate. A list with 8% invalid addresses
 * will torch a sending domain's reputation inside a week, and no amount of
 * copywriting recovers from that. So every address is scored before it enters
 * the pipeline, and anything under the threshold never reaches a campaign.
 *
 * Two providers are supported out of the box. Both are score-based, so the
 * adapter's job is to normalise their differing vocabularies onto 0–100.
 * With `none`, addresses are imported but flagged unverified — the same
 * honesty rule as TPS: never claim a check that did not happen.
 */

const PROVIDER = (process.env.EMAIL_VERIFIER_PROVIDER ?? "none").toLowerCase();
const API_KEY = process.env.EMAIL_VERIFIER_API_KEY ?? "";
export const MIN_SCORE = Number(process.env.EMAIL_VERIFIER_MIN_SCORE ?? 80);

export interface VerificationResult {
  /** 0–100. Zero when unverified or invalid. */
  score: number;
  /** True only when a provider actually confirmed deliverability. */
  verified: boolean;
  /** Provider's own verdict, kept for the UI tooltip. */
  reason: string;
}

const UNVERIFIED: VerificationResult = {
  score: 0,
  verified: false,
  reason: "no verifier configured",
};

export function isVerifierConfigured(): boolean {
  return PROVIDER !== "none" && Boolean(API_KEY);
}

/** Cheap structural check. Runs before any paid API call is made. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** Role addresses convert terribly and often trip spam traps. */
export function isRoleAddress(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return [
    "info", "sales", "support", "admin", "contact", "hello", "enquiries",
    "office", "help", "noreply", "no-reply", "webmaster", "postmaster",
    "abuse", "billing", "accounts",
  ].includes(local);
}

interface EmailAwesomeResponse {
  status?: string;
  result?: string;
  score?: number;
  deliverable?: boolean;
}

interface MyEmailVerifierResponse {
  Status?: string;
  status?: string;
  Diagnosis?: string;
}

/**
 * Verifies one address.
 *
 * Never throws — a verifier outage mid-import degrades that contact to
 * "unverified" rather than failing the whole batch. Unverified contacts are
 * still stored, just visibly flagged, so nothing scraped is ever silently
 * lost to a third party being down.
 */
export async function verifyEmail(email: string): Promise<VerificationResult> {
  const normalized = email.trim().toLowerCase();

  if (!isPlausibleEmail(normalized)) {
    return { score: 0, verified: false, reason: "malformed address" };
  }
  if (!isVerifierConfigured()) return UNVERIFIED;

  try {
    if (PROVIDER === "emailawesome") {
      const res = await fetch(
        `https://api.emailawesome.com/v1/verify?email=${encodeURIComponent(normalized)}`,
        {
          headers: { Authorization: `Bearer ${API_KEY}` },
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!res.ok) return failure(`provider replied ${res.status}`);

      const body = (await res.json()) as EmailAwesomeResponse;
      const verdict = (body.result ?? body.status ?? "").toLowerCase();
      // Prefer the provider's own score; fall back to mapping its verdict.
      const score =
        typeof body.score === "number" ? body.score : verdictToScore(verdict);
      return { score, verified: score >= MIN_SCORE, reason: verdict || "unknown" };
    }

    if (PROVIDER === "myemailverifier") {
      const res = await fetch(
        `https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(
          normalized
        )}/${API_KEY}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!res.ok) return failure(`provider replied ${res.status}`);

      const body = (await res.json()) as MyEmailVerifierResponse;
      const verdict = (body.Status ?? body.status ?? "").toLowerCase();
      const score = verdictToScore(verdict);
      return {
        score,
        verified: score >= MIN_SCORE,
        reason: body.Diagnosis ?? verdict ?? "unknown",
      };
    }

    console.warn(`[verify-email] unknown provider "${PROVIDER}" — skipping.`);
    return UNVERIFIED;
  } catch (err) {
    console.error(`[verify-email] check failed for ${normalized}:`, err);
    return failure(err instanceof Error ? err.message : "unknown error");
  }
}

function failure(reason: string): VerificationResult {
  return { score: 0, verified: false, reason };
}

/**
 * Maps the shared vocabulary both providers use onto a score.
 *
 * "catch_all" sits deliberately just under the default 80 threshold: the
 * domain accepts everything, so the address is unproven. Lower the threshold
 * if you are willing to gamble on those.
 */
function verdictToScore(verdict: string): number {
  if (/^(valid|deliverable|ok)$/.test(verdict)) return 100;
  if (/(catch|accept.?all|unknown)/.test(verdict)) return 70;
  if (/(risky|disposable|role)/.test(verdict)) return 40;
  if (/(invalid|undeliverable|bad)/.test(verdict)) return 0;
  return 50;
}

/** Verifies a batch with bounded concurrency. Order is preserved. */
export async function verifyEmailBatch(
  emails: string[],
  concurrency = 5
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = new Array(emails.length);
  let cursor = 0;

  async function worker() {
    while (cursor < emails.length) {
      const i = cursor++;
      results[i] = await verifyEmail(emails[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, emails.length) }, worker)
  );
  return results;
}
