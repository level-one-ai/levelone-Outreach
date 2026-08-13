import PocketBase from "pocketbase";

export const POCKETBASE_URL =
  process.env.NEXT_PUBLIC_POCKETBASE_URL ?? "http://127.0.0.1:8090";

/**
 * Collection names, in one place. Referenced by every route and by
 * /api/health/pocketbase, which checks each one actually resolves.
 */
export const COLLECTIONS = {
  tradesLeads: "trades_leads",
  b2bContacts: "b2b_contacts",
  b2bCampaigns: "b2b_campaigns",
  b2bOutreach: "b2b_outreach",
  messages: "messages",
  scrapeRuns: "scrape_runs",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/**
 * Standard public PocketBase client — the only client this app uses.
 *
 * Matching the Level One Proposal Engine's architecture, every collection is
 * configured with open API rules, so no superuser authentication happens
 * anywhere in this codebase. When a login is added later, this is the single
 * function that needs to learn about auth.
 */
export function createPublicClient(): PocketBase {
  const pb = new PocketBase(POCKETBASE_URL);
  // Next.js fires overlapping requests from server components and route
  // handlers alike; PocketBase's default auto-cancellation would abort the
  // earlier of two concurrent reads on the same collection.
  pb.autoCancellation(false);
  return pb;
}

interface PocketBaseErrorShape {
  status?: number;
  message?: string;
  response?: {
    message?: string;
    data?: Record<string, { message?: string; code?: string }>;
  };
}

/** True when PocketBase answered "nothing matched", not "something broke". */
export function isNotFound(err: unknown): boolean {
  return (err as PocketBaseErrorShape)?.status === 404;
}

/**
 * True when the write was rejected by a UNIQUE index.
 *
 * This is the load-bearing check for deduplication: we look before we write,
 * but two concurrent imports can both pass that check and race. PocketBase
 * settles it at the index, and this turns that into "duplicate" rather than
 * a failed import.
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as PocketBaseErrorShape;
  if (e?.status !== 400) return false;
  return Object.values(e?.response?.data ?? {}).some(
    (d) =>
      d?.code === "validation_not_unique" ||
      /not unique|already exists/i.test(d?.message ?? "")
  );
}

/**
 * Turns a PocketBase failure into a sentence that names the real cause —
 * a blocked API rule, a rejected field, or an unreachable host — instead of
 * a generic "could not save". Without this the actual reason only ever
 * reaches the server log.
 */
export function describePocketBaseError(
  err: unknown,
  collection?: string
): string {
  const e = err as PocketBaseErrorShape;
  const status = e?.status ?? 0;
  const where = collection ? `"${collection}"` : "the collection";

  const fieldErrors = Object.entries(e?.response?.data ?? {})
    .map(([field, detail]) => `${field}: ${detail?.message ?? "invalid"}`)
    .join("; ");

  if (status === 0) {
    return `Could not reach PocketBase at ${POCKETBASE_URL}. Check NEXT_PUBLIC_POCKETBASE_URL and that the server is running.`;
  }
  if (status === 401 || status === 403) {
    return `PocketBase refused the request (${status}). ${where}'s API rules must allow this operation without authentication — set its List, View, Create and Update rules to public (empty).`;
  }
  if (status === 404) {
    return `PocketBase returned 404. Check that ${where} exists at ${POCKETBASE_URL} and that its List/View rules are public.`;
  }
  if (status === 400) {
    return `PocketBase rejected the record (400)${fieldErrors ? ` — ${fieldErrors}` : ""}.`;
  }
  return `PocketBase error ${status}${fieldErrors ? ` — ${fieldErrors}` : ""}: ${
    e?.response?.message ?? e?.message ?? "unknown error"
  }`;
}

/**
 * Fetches every record matching a filter, following pagination.
 *
 * getFullList caps at 500 per page by default and the trades table is
 * expected to grow past that within a single county.
 */
export async function getAll<T>(
  pb: PocketBase,
  collection: CollectionName,
  options: { filter?: string; sort?: string; expand?: string } = {}
): Promise<T[]> {
  return await pb.collection(collection).getFullList<T>({
    batch: 500,
    ...options,
  });
}
