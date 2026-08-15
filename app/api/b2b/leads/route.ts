import { fail, ok, parseBody } from "@/lib/api";
import {
  COLLECTIONS,
  createPublicClient,
  describePocketBaseError,
  getAll,
} from "@/lib/pocketbase";
import { b2bLeadUpdateSchema } from "@/lib/schema";
import type { B2BContact } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

/**
 * The B2B lead pool.
 *
 * Contacts here belong to no campaign. They are raw material: scraped, stored,
 * and browsed until you decide who to put in front of which offer. That
 * separation is the whole reason /leads exists apart from /b2b.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const page = Math.max(1, Number(params.get("page") ?? 1));
  const niche = params.get("niche") ?? "";
  const status = params.get("pool_status") ?? "";
  const scrapeRun = params.get("scrape_run") ?? "";
  const search = params.get("q") ?? "";

  try {
    const pb = createPublicClient();

    const clauses: string[] = [];
    if (niche) clauses.push(pb.filter("niche = {:n}", { n: niche }));
    if (status) clauses.push(pb.filter("pool_status = {:s}", { s: status }));
    if (scrapeRun) clauses.push(pb.filter("scrape_run = {:r}", { r: scrapeRun }));
    if (search) {
      clauses.push(
        pb.filter(
          "(email ~ {:q} || contact_name ~ {:q} || company_name ~ {:q})",
          { q: search }
        )
      );
    }

    const filter = clauses.join(" && ");

    const result = await pb
      .collection(COLLECTIONS.b2bContacts)
      .getList<B2BContact>(page, PAGE_SIZE, {
        filter,
        sort: "-created",
      });

    /* The niche list powers the filter dropdown. Read from the whole pool, not
       the current page, or the dropdown would change as you paginate. */
    const all = await getAll<B2BContact>(pb, COLLECTIONS.b2bContacts, {
      filter: "niche != ''",
    });
    const niches = [...new Set(all.map((c) => c.niche).filter(Boolean))].sort();

    return ok({
      leads: result.items,
      page: result.page,
      total_pages: result.totalPages,
      total: result.totalItems,
      niches,
    });
  } catch (err) {
    return fail(describePocketBaseError(err, COLLECTIONS.b2bContacts), 502);
  }
}

/** Inline edits from the pool table — fix a name, retag a niche, suppress. */
export async function PATCH(request: Request) {
  const parsed = await parseBody(request, b2bLeadUpdateSchema);
  if (!parsed.success) return parsed.response;

  const { id, ...patch } = parsed.data;
  const fields = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  );

  if (Object.keys(fields).length === 0) {
    return fail("No fields to update.");
  }

  try {
    const pb = createPublicClient();
    const lead = await pb
      .collection(COLLECTIONS.b2bContacts)
      .update<B2BContact>(id, fields);
    return ok({ lead });
  } catch (err) {
    return fail(describePocketBaseError(err, COLLECTIONS.b2bContacts), 502);
  }
}
