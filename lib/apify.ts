/**
 * Apify client — the B2B scraper's data source.
 *
 * Runs inside this app: we start an actor run, poll it to completion, then
 * pull its dataset. n8n is not involved.
 *
 * The actor itself is yours to choose (APIFY_LINKEDIN_ACTOR_ID). Every
 * LinkedIn/Sales Navigator actor emits slightly different field names, so
 * `normalizeItem` accepts the common spellings rather than locking you to one
 * actor. If you switch actors and a field stops arriving, add its spelling to
 * the candidate lists below — that is the only change needed.
 */

const TOKEN = process.env.APIFY_TOKEN ?? "";
const ACTOR_ID = process.env.APIFY_LINKEDIN_ACTOR_ID ?? "";
const RUN_TIMEOUT_SECONDS = Number(process.env.APIFY_RUN_TIMEOUT_SECONDS ?? 600);

const API = "https://api.apify.com/v2";

export function isApifyConfigured(): boolean {
  return Boolean(TOKEN && ACTOR_ID);
}

export class ApifyError extends Error {}

export interface ScrapedContact {
  email: string;
  contact_name: string;
  company_name: string;
  website: string;
  linkedin_url: string;
}

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMING-OUT"
  | "TIMED-OUT"
  | "ABORTING"
  | "ABORTED";

interface ApifyRun {
  id: string;
  status: ApifyRunStatus;
  defaultDatasetId: string;
  stats?: { itemCount?: number };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApifyError(
      `Apify replied ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`
    );
  }
  return (await res.json()) as T;
}

/**
 * Starts an actor run and returns immediately.
 *
 * Deliberately asynchronous: a LinkedIn scrape of a few hundred profiles takes
 * minutes, far longer than an HTTP request should be held open. The caller
 * records the run id and polls.
 */
export async function startRun(
  input: Record<string, unknown>,
  /** Overrides APIFY_LINKEDIN_ACTOR_ID, so one deployment can drive several
   *  actors — a Sales Navigator scraper and a company scraper, say. */
  actorId?: string
): Promise<ApifyRun> {
  const actor = actorId || ACTOR_ID;

  if (!TOKEN) {
    throw new ApifyError("APIFY_TOKEN is not configured.");
  }
  if (!actor) {
    throw new ApifyError(
      "No Apify actor configured — set APIFY_LINKEDIN_ACTOR_ID or pass an actor id."
    );
  }

  /* Apify's REST path wants `user~actor`, but every actor URL and most docs
     show `user/actor`. Accept both rather than failing with a 404 that gives
     no hint which of the two you got wrong. */
  const normalised = actor.replace("/", "~");

  const body = await apiFetch<{ data: ApifyRun }>(
    `/acts/${encodeURIComponent(normalised)}/runs?timeout=${RUN_TIMEOUT_SECONDS}`,
    { method: "POST", body: JSON.stringify(input) }
  );
  return body.data;
}

export async function getRun(runId: string): Promise<ApifyRun> {
  const body = await apiFetch<{ data: ApifyRun }>(`/actor-runs/${runId}`);
  return body.data;
}

/** True once the run has stopped, whether it succeeded or not. */
export function isTerminal(status: ApifyRunStatus): boolean {
  return !["READY", "RUNNING", "ABORTING", "TIMING-OUT"].includes(status);
}

/** Pulls the run's dataset. Apify caps a page at 1000 items, so we page. */
export async function fetchDataset(
  datasetId: string
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let offset = 0;

  for (;;) {
    const page = await apiFetch<Record<string, unknown>[]>(
      `/datasets/${datasetId}/items?clean=true&format=json&limit=1000&offset=${offset}`
    );
    if (!Array.isArray(page) || page.length === 0) break;
    items.push(...page);
    if (page.length < 1000) break;
    offset += page.length;
  }

  return items;
}

/** Reads the first present, non-empty string from a list of candidate keys. */
function pick(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Flattens one actor result into our contact shape.
 *
 * Returns null when there is no email — an address is the whole point of a B2B
 * cold-email lead, and a record without one would just be dead weight in the
 * contacts table with nothing to dedupe on.
 */
export function normalizeItem(
  item: Record<string, unknown>
): ScrapedContact | null {
  const email = pick(item, [
    "email", "workEmail", "work_email", "emailAddress",
    "email_address", "professionalEmail", "primaryEmail",
  ]).toLowerCase();

  if (!email) return null;

  const first = pick(item, ["firstName", "first_name"]);
  const last = pick(item, ["lastName", "last_name"]);
  const contact_name =
    pick(item, ["fullName", "full_name", "name", "contactName"]) ||
    [first, last].filter(Boolean).join(" ");

  return {
    email,
    contact_name,
    company_name: pick(item, [
      "companyName", "company_name", "company", "organization",
      "organizationName", "currentCompany",
    ]),
    website: pick(item, [
      "companyWebsite", "website", "company_website", "companyUrl", "domain",
    ]),
    linkedin_url: pick(item, [
      "linkedinUrl", "profileUrl", "linkedin_url", "profile_url",
      "publicProfileUrl", "url",
    ]),
  };
}

/** Normalises a whole dataset, dropping items with no usable email. */
export function normalizeDataset(
  items: Record<string, unknown>[]
): ScrapedContact[] {
  return items
    .map(normalizeItem)
    .filter((c): c is ScrapedContact => c !== null);
}
