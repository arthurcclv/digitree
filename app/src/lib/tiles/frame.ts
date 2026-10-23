import { lngLatToMercator, metreInMercator, TILE_ZOOM, type MercatorPoint, type TileId } from "./grid";

/**
 * A local metre frame: x east, y north, z up, origin at `origin`. Every
 * self-placing layer builds one (the sunlight layer's `Domain`, AO's frame,
 * the tree layer's anchor, the splat layer's anchor) and converts through it.
 * Mercator y grows south, so the local y is its negation: that sign lives here
 * only. `mercatorFrame` in `src/lib/three` is the same frame as a matrix.
 */
export interface LocalFrame {
  origin: MercatorPoint;
  /** Mercator units per metre, fixed at the origin's latitude. */
  metre: number;
}

/** The frame at a lng/lat, its metre taken there. */
export function frameAt(lng: number, lat: number): LocalFrame {
  return { origin: lngLatToMercator(lng, lat), metre: metreInMercator(lat) };
}

/** A Mercator point in the frame's metres: `[east, north]`. */
export function mercatorToLocal(f: LocalFrame, p: MercatorPoint): [number, number] {
  return [(p.x - f.origin.x) / f.metre, -(p.y - f.origin.y) / f.metre];
}

/** lng/lat in the frame's metres: `[east, north]`. */
export function toLocal(f: LocalFrame, lng: number, lat: number): [number, number] {
  return mercatorToLocal(f, lngLatToMercator(lng, lat));
}

/** A point in the frame's metres back to Mercator. */
export function localToMercator(f: LocalFrame, x: number, y: number): MercatorPoint {
  return { x: f.origin.x + x * f.metre, y: f.origin.y - y * f.metre };
}

/**
 * The z14 tiles meeting the footprint's bounding box, clipped to `halfM`
 * metres around the frame's origin, plus one ring of neighbours, so a feature
 * anchored just outside the view still arrives. None for a footprint of fewer
 * than three points.
 */
export function planTiles(f: LocalFrame, footprint: [number, number][], halfM: number): TileId[] {
  if (footprint.length < 3) return [];
  const pts = footprint.map(([lng, lat]) => lngLatToMercator(lng, lat));
  const lim = halfM * f.metre;
  const clampX = (v: number) => Math.max(f.origin.x - lim, Math.min(f.origin.x + lim, v));
  const clampY = (v: number) => Math.max(f.origin.y - lim, Math.min(f.origin.y + lim, v));
  const n = 2 ** TILE_ZOOM;
  const x0 = Math.floor(clampX(Math.min(...pts.map((p) => p.x))) * n) - 1;
  const x1 = Math.floor(clampX(Math.max(...pts.map((p) => p.x))) * n) + 1;
  const y0 = Math.floor(clampY(Math.min(...pts.map((p) => p.y))) * n) - 1;
  const y1 = Math.floor(clampY(Math.max(...pts.map((p) => p.y))) * n) + 1;
  const tiles: TileId[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y, z: TILE_ZOOM });
  return tiles;
}
