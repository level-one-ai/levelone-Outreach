import type { GridCell } from "@/lib/grid";

/**
 * Google Places API client — the trades scraper's data source.
 *
 * Runs entirely server-side inside this app; n8n is not involved in scraping.
 *
 * What Places gives us: business name, address, phone number, website.
 * What it does NOT give us: email addresses. Google simply does not hold them.
 * That is why every lead card has an inline email field — you fill those in
 * from the business's website as you work the list.
 */

const API_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

const NEARBY_URL =
  "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
const DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export function isPlacesConfigured(): boolean {
  return Boolean(API_KEY);
}

export interface PlaceResult {
  place_id: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  /** The grid cell that surfaced this result. */
  grid_cell: string;
}

interface NearbyResponse {
  status: string;
  error_message?: string;
  next_page_token?: string;
  results?: Array<{
    place_id: string;
    name: string;
    vicinity?: string;
    formatted_address?: string;
  }>;
}

interface DetailsResponse {
  status: string;
  error_message?: string;
  result?: {
    formatted_phone_number?: string;
    international_phone_number?: string;
    website?: string;
    formatted_address?: string;
    name?: string;
  };
}

/** Places answers with 200 and a status string; only these two mean "fine". */
function isOkStatus(status: string): boolean {
  return status === "OK" || status === "ZERO_RESULTS";
}

class PlacesError extends Error {}

async function getJson<T>(url: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ ...params, key: API_KEY });
  const res = await fetch(`${url}?${qs}`, { cache: "no-store" });
  if (!res.ok) {
    throw new PlacesError(`Places HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Turns a place name or postcode into coordinates, so you can start a run by
 * typing "Manchester" or "M1 4BT" instead of hunting for a lat/lng.
 */
export async function geocode(
  query: string
): Promise<{ lat: number; lng: number; label: string } | null> {
  if (!API_KEY) throw new PlacesError("GOOGLE_PLACES_API_KEY is not configured.");

  const data = await getJson<{
    status: string;
    error_message?: string;
    results?: Array<{
      formatted_address: string;
      geometry: { location: { lat: number; lng: number } };
    }>;
  }>(GEOCODE_URL, { address: query, region: "uk" });

  if (data.status === "ZERO_RESULTS") return null;
  if (data.status !== "OK") {
    throw new PlacesError(
      `Geocoding failed (${data.status})${data.error_message ? `: ${data.error_message}` : ""}`
    );
  }

  const hit = data.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.geometry.location.lat,
    lng: hit.geometry.location.lng,
    label: hit.formatted_address,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one grid cell: up to 3 pages of Nearby Search.
 *
 * Google issues `next_page_token` before the page it refers to is queryable —
 * using it immediately returns INVALID_REQUEST. The documented remedy is a
 * short delay, hence the sleep before each subsequent page.
 */
export async function searchCell(
  cell: GridCell,
  keyword: string
): Promise<Array<{ place_id: string; name: string; address: string }>> {
  if (!API_KEY) throw new PlacesError("GOOGLE_PLACES_API_KEY is not configured.");

  const out: Array<{ place_id: string; name: string; address: string }> = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 3; page++) {
    const params: Record<string, string> = pageToken
      ? { pagetoken: pageToken }
      : {
          location: `${cell.lat},${cell.lng}`,
          radius: String(cell.radius),
          keyword,
        };

    if (pageToken) await sleep(2000);

    const data = await getJson<NearbyResponse>(NEARBY_URL, params);

    if (!isOkStatus(data.status)) {
      throw new PlacesError(
        `Places search failed (${data.status})${data.error_message ? `: ${data.error_message}` : ""}`
      );
    }

    for (const r of data.results ?? []) {
      out.push({
        place_id: r.place_id,
        name: r.name,
        address: r.formatted_address ?? r.vicinity ?? "",
      });
    }

    pageToken = data.next_page_token;
    if (!pageToken) break;
  }

  return out;
}

/**
 * Fetches the phone number and website for one place.
 *
 * Only the four fields we actually use are requested — Places bills by field
 * category, and asking for the default set costs several times more per call.
 *
 * A failure here is not fatal to the run: a lead without a phone number is
 * useless for cold calling and is dropped by the caller, but one bad Details
 * call must not abort a 60-cell scrape.
 */
export async function fetchDetails(
  placeId: string
): Promise<{ phone: string; website: string; address: string } | null> {
  try {
    const data = await getJson<DetailsResponse>(DETAILS_URL, {
      place_id: placeId,
      fields: "formatted_phone_number,international_phone_number,website,formatted_address",
    });

    if (data.status !== "OK" || !data.result) return null;

    return {
      phone:
        data.result.international_phone_number ??
        data.result.formatted_phone_number ??
        "",
      website: data.result.website ?? "",
      address: data.result.formatted_address ?? "",
    };
  } catch (err) {
    console.error(`[places] details failed for ${placeId}:`, err);
    return null;
  }
}

/** Small concurrency pool — Places rate-limits, and a burst of 60 gets 429s. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}
