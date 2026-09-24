/**
 * The z14 tile grid the layer fetches on, and the tile-based coverage test.
 * Pure — no fetch, no GL. See *Data* and *Coverage* in `specs/spec.md`.
 */
import {
  lngLatToMercator,
  MIN_SUN_ELEVATION_REACH_M,
  type Domain,
  type MercatorPoint,
  type Vec2,
} from "./frame";

/** Both sources are fetched on this one grid. It is the buildings' max zoom. */
export const TILE_ZOOM = 14;

/** Margin fetched on every side: the reach of a 150 m occluder at the lowest sun. */
export const FETCH_MARGIN_M = MIN_SUN_ELEVATION_REACH_M;

export interface TileId {
  x: number;
  y: number;
  z: number;
}

export const tileKey = (t: TileId) => `${t.z}/${t.x}/${t.y}`;

/** The tile holding a Mercator point. */
export function tileOfMercator(p: MercatorPoint, z = TILE_ZOOM): TileId {
  const n = 2 ** z;
  return { x: Math.floor(p.x * n), y: Math.floor(p.y * n), z };
}

export function tileOfLngLat(lng: number, lat: number, z = TILE_ZOOM): TileId {
  return tileOfMercator(lngLatToMercator(lng, lat), z);
}

/** A tile's square in a domain's local frame: `[west, south, east, north]` in metres. */
export function tileSquareLocal(d: Domain, t: TileId): [number, number, number, number] {
  const n = 2 ** t.z;
  const west = (t.x / n - d.origin.x) / d.metre;
  const east = ((t.x + 1) / n - d.origin.x) / d.metre;
  // Mercator y grows southwards; the local frame's y grows north.
  const north = -(t.y / n - d.origin.y) / d.metre;
  const south = -((t.y + 1) / n - d.origin.y) / d.metre;
  return [west, south, east, north];
}

/** A local point → Mercator, for a domain. */
function localToMercator(d: Domain, x: number, y: number): MercatorPoint {
  return { x: d.origin.x + x * d.metre, y: d.origin.y - y * d.metre };
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

/** Is a tile inside a lng/lat box (`[west, south, east, north]`)? */
export function tileIntersects(t: TileId, bounds: [number, number, number, number]): boolean {
  const n = 2 ** t.z;
  const west = (t.x / n) * 360 - 180;
  const east = ((t.x + 1) / n) * 360 - 180;
  const lat = (y: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const north = lat(t.y);
  const south = lat(t.y + 1);
  return east > bounds[0] && west < bounds[2] && north > bounds[1] && south < bounds[3];
}
