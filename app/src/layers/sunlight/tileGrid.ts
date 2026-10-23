/**
 * The z14 tile grid the layer fetches on, and the tile-based coverage test.
 * Pure — no fetch, no GL. See *Data* and *Coverage* in `specs/spec.md`.
 */
import { localToMercator, mercatorToLocal, TILE_ZOOM, tileKey, tileOfMercator, type TileId } from "../../lib/tiles";
import { makeDomain, MIN_SUN_ELEVATION_REACH_M, type Domain, type Vec2 } from "./frame";

// The grid itself is shared with the ambient-occlusion layer.
export { TILE_ZOOM, tileIntersects, tileKey, tileOfLngLat, tileOfMercator, type TileId } from "../../lib/tiles";

/** Margin fetched on every side: the reach of a 150 m occluder at the lowest sun. */
export const FETCH_MARGIN_M = MIN_SUN_ELEVATION_REACH_M;

/** A tile's square in a domain's local frame: `[west, south, east, north]` in metres. */
export function tileSquareLocal(d: Domain, t: TileId): [number, number, number, number] {
  const n = 2 ** t.z;
  const [west, north] = mercatorToLocal(d, { x: t.x / n, y: t.y / n });
  const [east, south] = mercatorToLocal(d, { x: (t.x + 1) / n, y: (t.y + 1) / n });
  return [west, south, east, north];
}

/**
 * The tiles to fetch: the bounding box of the footprint and the near domain,
 * grown by the fetch margin on every side, clipped to the far domain.
 * See *Which tiles*.
 */
export function planTiles(
  far: Domain,
  footprint: Vec2[],
  nearHalfM: number,
  marginM = FETCH_MARGIN_M,
): TileId[] {
  const xs = [...footprint.map((p) => p[0]), -nearHalfM, nearHalfM];
  const ys = [...footprint.map((p) => p[1]), -nearHalfM, nearHalfM];
  const farHalf = far.domainM / 2;
  const clamp = (v: number) => Math.max(-farHalf, Math.min(farHalf, v));
  const west = clamp(Math.min(...xs) - marginM);
  const east = clamp(Math.max(...xs) + marginM);
  const south = clamp(Math.min(...ys) - marginM);
  const north = clamp(Math.max(...ys) + marginM);

  // A tile touching the east or south edge exactly is not wanted: step in by
  // a millimetre before flooring.
  const eps = 1e-3;
  const nw = tileOfMercator(localToMercator(far, west, north));
  const se = tileOfMercator(localToMercator(far, east - eps, south + eps));
  const tiles: TileId[] = [];
  for (let y = nw.y; y <= se.y; y++) {
    for (let x = nw.x; x <= se.x; x++) tiles.push({ x, y, z: TILE_ZOOM });
  }
  return tiles;
}

export type Coverage = "complete" | "incomplete" | "outside";

/**
 * *Coverage* for one local point: is its own tile covered, and is the point
 * `reach` metres towards the sun covered too. `covered` is the set of tile
 * keys fetched for both sources.
 */
export function classifyByTiles(d: Domain, covered: ReadonlySet<string>, reach: Vec2, p: Vec2): Coverage {
  const at = (x: number, y: number) => covered.has(tileKey(tileOfMercator(localToMercator(d, x, y))));
  if (!at(p[0], p[1])) return "outside";
  return at(p[0] + reach[0], p[1] + reach[1]) ? "complete" : "incomplete";
}

/**
 * An export pass's tiles: every tile within its grid grown by the fetch margin
 * on every side, so nothing that could shade the grid is missing. See *The
 * export pass*.
 */
export function exportTiles(d: Domain): TileId[] {
  const reach = makeDomain(d.centre[0], d.centre[1], 1, d.domainM + 2 * FETCH_MARGIN_M);
  return planTiles(reach, [], d.domainM / 2, FETCH_MARGIN_M);
}
