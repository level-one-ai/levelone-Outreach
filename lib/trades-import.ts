import type PocketBase from "pocketbase";

import {
  COLLECTIONS,
  describePocketBaseError,
  getAll,
  isUniqueViolation,
} from "@/lib/pocketbase";
import { normalizeUkPhone } from "@/lib/phone";
import { BLOCK_LISTED, checkTpsBatch, isCallable } from "@/lib/tps";
import type { TradeLead } from "@/lib/types";

/**
 * The trades import pipeline: normalise → dedupe → TPS screen → save.
 *
 * Shared by /api/trades/import (batches posted in) and by the in-app grid
 * scraper, so a lead entering from either direction is subjected to exactly
 * the same checks. Splitting these would be how the two paths silently drift
 * apart and one of them starts saving TPS-listed numbers.
 */

export interface RawTradeLead {
  company_name: string;
  location?: string;
  phone: string;
  email?: string;
  website?: string;
  place_id?: string;
  grid_cell?: string;
}

export interface ImportSummary {
  received: number;
  imported: number;
  /** Already in the database, or repeated within this batch. */
  duplicates: number;
  /** Rejected by TPS screening. */
  tpsBlocked: number;
  /** Phone number could not be parsed as a real number. */
  invalid: number;
  errors: string[];
}

const EMPTY: ImportSummary = {
  received: 0,
  imported: 0,
  duplicates: 0,
  tpsBlocked: 0,
  invalid: 0,
  errors: [],
};

/**
 * Loads the existing dedupe keys.
 *
 * One read of two columns beats one existence query per incoming lead: a
 * 500-lead batch would otherwise be 1,000 round trips to PocketBase.
 */
async function loadExistingKeys(
  pb: PocketBase
): Promise<{ phones: Set<string>; placeIds: Set<string> }> {
  const rows = await getAll<Pick<TradeLead, "phone" | "place_id">>(
    pb,
    COLLECTIONS.tradesLeads,
    { sort: "-created" }
  );

  return {
    phones: new Set(rows.map((r) => r.phone).filter(Boolean)),
    placeIds: new Set(rows.map((r) => r.place_id).filter(Boolean)),
  };
}

/**
 * Imports a batch of scraped trades.
 *
 * Order matters and is deliberate:
 *   1. Normalise the phone to E.164, because every later step keys off it.
 *   2. Dedupe, so we never pay a TPS provider to screen a number we already
 *      hold.
 *   3. Screen the survivors.
 *   4. Save.
 */
export async function importTradeLeads(
  pb: PocketBase,
  raw: RawTradeLead[]
): Promise<ImportSummary> {
  const summary: ImportSummary = { ...EMPTY, received: raw.length, errors: [] };
  if (raw.length === 0) return summary;

  const existing = await loadExistingKeys(pb);

  /* Step 1 + 2 — normalise and dedupe, both against the database and within
     this batch. Overlapping grid cells routinely return the same business
     several times in one run. */
  const seenPhones = new Set<string>();
  const seenPlaceIds = new Set<string>();
  const candidates: Array<RawTradeLead & { phone: string }> = [];

  for (const lead of raw) {
    const phone = normalizeUkPhone(lead.phone);
    if (!phone) {
      summary.invalid++;
      continue;
    }

    const placeId = lead.place_id ?? "";
    const isDuplicate =
      existing.phones.has(phone) ||
      seenPhones.has(phone) ||
      (placeId && (existing.placeIds.has(placeId) || seenPlaceIds.has(placeId)));

    if (isDuplicate) {
      summary.duplicates++;
      continue;
    }

    seenPhones.add(phone);
    if (placeId) seenPlaceIds.add(placeId);
    candidates.push({ ...lead, phone });
  }

  if (candidates.length === 0) return summary;

  /* Step 3 — TPS/CTPS. With no provider configured this returns "unchecked"
     for everything, which is stored honestly rather than as a false clear. */
  const checks = await checkTpsBatch(candidates.map((c) => c.phone));

  /* Step 4 — save. */
  for (let i = 0; i < candidates.length; i++) {
    const lead = candidates[i];
    const check = checks[i];

    if (BLOCK_LISTED && !isCallable(check)) {
      summary.tpsBlocked++;
      continue;
    }

    try {
      await pb.collection(COLLECTIONS.tradesLeads).create<TradeLead>({
        company_name: lead.company_name,
        location: lead.location ?? "",
        phone: lead.phone,
        tps_verified: check.verified,
        tps_status: check.status,
        email: lead.email ?? "",
        website: lead.website ?? "",
        call_date_time: "",
        status: "scraped",
        meeting_sent: false,
        place_id: lead.place_id ?? "",
        grid_cell: lead.grid_cell ?? "",
      });
      summary.imported++;
    } catch (err) {
      /* Two concurrent imports can both clear the in-memory check and race to
         the same phone number. The UNIQUE index settles it, and that is a
         duplicate, not a failure. */
      if (isUniqueViolation(err)) {
        summary.duplicates++;
        continue;
      }
      const reason = describePocketBaseError(err, COLLECTIONS.tradesLeads);
      console.error(`[trades-import] save failed for ${lead.phone}:`, reason);
      if (summary.errors.length < 5) summary.errors.push(reason);
    }
  }

  return summary;
}
