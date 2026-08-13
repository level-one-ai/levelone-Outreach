/**
 * Geographic grid partitioning — the thing that beats Google's 120-result cap.
 *
 * A single Google Maps search returns at most 60 results (3 pages of 20), and
 * the Maps UI caps out around 120 no matter how you page it. That ceiling is
 * per-search, not per-area, so the way past it is to run many small searches
 * instead of one big one: carve the target area into a lattice of small
 * circles and search each one independently.
 *
 * A dense town centre might hold 200 plumbers within 5km. One search finds 60
 * of them. Forty 1.5km cells across the same area find nearly all of them,
 * because no single cell ever has more than 60 plumbers in it.
 */

export interface GridCell {
  lat: number;
  lng: number;
  /** Search radius for this cell, in metres. */
  radius: number;
  /** Stable identity, stored on each lead so a result traces to its cell. */
  id: string;
}

/** Mean metres per degree of latitude. Constant enough at any UK latitude. */
const METRES_PER_DEG_LAT = 111_320;

/** Longitude degrees shrink towards the poles. */
function metresPerDegLng(lat: number): number {
  return METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Great-circle distance in metres. Used to trim cells outside the radius. */
export function haversine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface GridOptions {
  /** Centre of the search area. */
  lat: number;
  lng: number;
  /** How far out from the centre to search, in metres. */
  searchRadius: number;
  /**
   * Radius of each individual cell, in metres. Smaller cells mean more API
   * calls but fewer missed results in dense areas. 1500m suits a town; drop
   * to 800m for a city centre, raise to 3000m for rural coverage.
   */
  cellRadius?: number;
  /** Hard ceiling, so a mistyped radius cannot burn the Places quota. */
  maxCells?: number;
}

/**
 * Builds the lattice of search cells covering the requested area.
 *
 * Cells are laid out on a square lattice with their spacing set to
 * `cellRadius * √2`, which is exactly the spacing at which neighbouring
 * circles touch at the corners of the squares they inscribe — full coverage
 * with no gaps. We then shrink the step by a further 10% so the seams
 * genuinely overlap, because a business sitting precisely on a boundary is
 * otherwise at the mercy of Google's own rounding.
 *
 * The resulting duplicate sightings are free to discard: `place_id` dedupes
 * them long before anything reaches the database.
 */
export function generateGrid({
  lat,
  lng,
  searchRadius,
  cellRadius = 1500,
  maxCells = 120,
}: GridOptions): GridCell[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  if (searchRadius <= 0 || cellRadius <= 0) return [];

  // A search area smaller than one cell is just one search.
  if (searchRadius <= cellRadius) {
    return [{ lat, lng, radius: searchRadius, id: cellId(lat, lng, searchRadius) }];
  }

  const step = cellRadius * Math.SQRT2 * 0.9;
  const stepsOut = Math.ceil(searchRadius / step);

  const latStep = step / METRES_PER_DEG_LAT;
  const lngStep = step / metresPerDegLng(lat);

  const cells: GridCell[] = [];

  for (let row = -stepsOut; row <= stepsOut; row++) {
    for (let col = -stepsOut; col <= stepsOut; col++) {
      const cellLat = lat + row * latStep;
      const cellLng = lng + col * lngStep;

      // Trim the square lattice back to the requested circle. The cell's own
      // radius is added so cells straddling the edge are kept — dropping them
      // would leave a ragged, under-searched boundary.
      if (haversine({ lat, lng }, { lat: cellLat, lng: cellLng }) > searchRadius + cellRadius) {
        continue;
      }

      cells.push({
        lat: round(cellLat),
        lng: round(cellLng),
        radius: cellRadius,
        id: cellId(cellLat, cellLng, cellRadius),
      });
    }
  }

  // Sort by distance from centre so a truncated run still covers the heart of
  // the target area rather than an arbitrary corner of it.
  cells.sort(
    (a, b) =>
      haversine({ lat, lng }, a) - haversine({ lat, lng }, b)
  );

  return cells.slice(0, maxCells);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function cellId(lat: number, lng: number, radius: number): string {
  return `${round(lat)},${round(lng)}@${Math.round(radius)}m`;
}

/**
 * Rough cost estimate shown in the UI before a run starts.
 *
 * Places bills per request, and a large grid gets expensive quickly: each cell
 * is up to 3 Nearby Search pages, and every unique result needs its own Place
 * Details call to obtain the phone number. Showing this up front is the
 * difference between a £4 run and a surprise £200 bill.
 */
export function estimateApiCalls(
  cells: number,
  avgResultsPerCell = 25
): { nearbyCalls: number; detailCalls: number; total: number } {
  const nearbyCalls = cells * Math.min(3, Math.ceil(avgResultsPerCell / 20));
  const detailCalls = cells * avgResultsPerCell;
  return { nearbyCalls, detailCalls, total: nearbyCalls + detailCalls };
}
