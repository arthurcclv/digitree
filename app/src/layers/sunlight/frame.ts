import { lngLatToMercator, metreInMercator, type MercatorPoint } from "../../lib/tiles";
import { MIN_SUN_ELEVATION_DEG } from "./sun";

/**
 * The geometry of the computation, free of three.js and MapLibre so all of it
 * can be tested: the domain grids, the local metre frame, the shadow shear, and
 * the footprint polygon helpers. See *The domain* and *The light pass* in
 * `specs/spec.md`.
 *
 * The local frame is `x` east, `y` north, `z` up, in metres, with its origin
 * at the domain centre.
 */

/** The near grid: side in metres, and cells per side — 0.5 m cells. */
export const DOMAIN_M = 2048;
export const GRID_SIZE = 4096;

/** Below `NEAR_FINE_MIN_ZOOM` the near grid widens to this — 1 m cells. */
export const WIDE_DOMAIN_M = 4096;
export const NEAR_FINE_MIN_ZOOM = 15;

/**
 * The near grid for a zoom. At z14 a flat view is ~4 km across, so a 2 km
 * grid would leave most of it on the 8 m far grid; below z15 the near grid
 * doubles, in the same 4096² target. See *The domain*.
 */
export function nearGridFor(zoom: number): { domainM: number; size: number } {
  return zoom >= NEAR_FINE_MIN_ZOOM ? { domainM: DOMAIN_M, size: GRID_SIZE } : { domainM: WIDE_DOMAIN_M, size: GRID_SIZE };
}

/** The finest cell an export pass uses, in metres: the near grid's. See *The export pass*. */
export const EXPORT_MIN_CELL_M = 0.5;
/** An export pass's most cells per side: one 4096² target, as the near grid's. */
export const EXPORT_MAX_CELLS = 4096;

/**
 * An export pass's grid for a side: 0.5 m cells up to a 2,048 m side, then as
 * many cells as allowed (`maxCells`: `EXPORT_MAX_CELLS` within the GPU's
 * texture limit) stretched over it.
 */
export function exportGridFor(sideM: number, maxCells: number): { domainM: number; size: number } {
  const size = Math.min(Math.ceil(sideM / EXPORT_MIN_CELL_M - 1e-9), maxCells);
  return { domainM: sideM, size };
}

/** The far grid, for the distant ground of a pitched view — 8 m cells. */
export const FAR_DOMAIN_M = 16_384;
export const FAR_GRID_SIZE = 2048;

/** How tall an unseen occluder outside the fetched tiles is assumed able to be. */
export const SHADOW_REACH_M = 150;

/** How far a `SHADOW_REACH_M` occluder reaches at the lowest sun: ~1,714 m. */
export const MIN_SUN_ELEVATION_REACH_M =
  SHADOW_REACH_M / Math.tan((MIN_SUN_ELEVATION_DEG * Math.PI) / 180);

export type Vec2 = [number, number];

/** A unit vector pointing *towards* the sun, in the ground plane (east, north). */
export function towardSun(azimuthDeg: number): Vec2 {
  const az = (azimuthDeg * Math.PI) / 180;
  return [Math.sin(az), Math.cos(az)];
}

/**
 * Where a point at height `z` lands on the ground, cast along the sun ray.
 * This is the shear the light pass applies to every occluder vertex.
 */
export function castToGround(
  x: number,
  y: number,
  z: number,
  azimuthDeg: number,
  elevationDeg: number,
): Vec2 {
  const [ux, uy] = towardSun(azimuthDeg);
  const k = 1 / Math.tan((elevationDeg * Math.PI) / 180);
  return [x - z * k * ux, y - z * k * uy];
}

/**
 * The light pass's projection as a row-major 4×4 (what `Matrix4.set` takes):
 * the shear onto the ground, then the domain square onto clip space. `z` in
 * clip space is always 0 — there is no depth.
 *
 * With `straightDown` the shear is dropped, which is the footprint pass.
 */
export function lightMatrixRowMajor(
  azimuthDeg: number,
  elevationDeg: number,
  domainM: number,
  straightDown = false,
): number[] {
  const [ux, uy] = towardSun(azimuthDeg);
  const k = straightDown ? 0 : 1 / Math.tan((elevationDeg * Math.PI) / 180);
  const s = 2 / domainM;
  return [s, 0, -k * ux * s, 0, 0, s, -k * uy * s, 0, 0, 0, 0, 0, 0, 0, 0, 1];
}

/** Apply a row-major 4×4 to a point, for the tests. */
export function applyRowMajor(m: number[], x: number, y: number, z: number): Vec2 {
  const w = m[12] * x + m[13] * y + m[14] * z + m[15];
  return [(m[0] * x + m[1] * y + m[2] * z + m[3]) / w, (m[4] * x + m[5] * y + m[6] * z + m[7]) / w];
}

// ---------------------------------------------------------------------------
// Web Mercator. The formulas shared with the other self-fetching layers live in
// `src/lib/tiles`; this file adds the inverse and the export's own sphere.

export { lngLatToMercator, metreInMercator, type MercatorPoint };

/** EPSG:3857's sphere, which is not MapLibre's — used only for export. */
const WEB_MERCATOR_EXTENT_M = 2 * Math.PI * 6_378_137;

export function mercatorToLngLat(p: MercatorPoint): [number, number] {
  const lng = p.x * 360 - 180;
  const y2 = 180 - p.y * 360;
  const lat = (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
  return [lng, lat];
}

/**
 * One computed domain: where it sits on the map, and how big a cell is.
 * `metre` is fixed at the centre's latitude — across 2 km the scale changes by
 * well under 0.1%.
 */
export interface Domain {
  centre: [number, number];
  origin: MercatorPoint;
  metre: number;
  domainM: number;
  size: number;
}

export function makeDomain(lng: number, lat: number, size = GRID_SIZE, domainM = DOMAIN_M): Domain {
  return {
    centre: [lng, lat],
    origin: lngLatToMercator(lng, lat),
    metre: metreInMercator(lat),
    domainM,
    size,
  };
}

export const cellM = (d: Domain) => d.domainM / d.size;

/** lng/lat → the local frame. */
export function toLocal(d: Domain, lng: number, lat: number): Vec2 {
  const p = lngLatToMercator(lng, lat);
  return [(p.x - d.origin.x) / d.metre, -(p.y - d.origin.y) / d.metre];
}

/** The local frame → lng/lat. */
export function fromLocal(d: Domain, x: number, y: number): [number, number] {
  return mercatorToLngLat({ x: d.origin.x + x * d.metre, y: d.origin.y - y * d.metre });
}

/**
 * The cell holding a local point, as `[column, row]` with row 0 at the
 * **south** edge — the render target's own orientation. `null` outside.
 */
export function cellOf(d: Domain, x: number, y: number): Vec2 | null {
  const half = d.domainM / 2;
  const col = Math.floor(((x + half) / d.domainM) * d.size);
  const row = Math.floor(((y + half) / d.domainM) * d.size);
  if (col < 0 || row < 0 || col >= d.size || row >= d.size) return null;
  return [col, row];
}

/** Where a point falls on one of two nested grids. */
export interface LevelHit {
  level: "near" | "far";
  domain: Domain;
  point: Vec2;
  cell: Vec2;
}

/**
 * The finest of two nested grids holding a point: `near` when it is inside
 * it, else `far`, else `null`. Every coordinate comes from the grids passed
 * in, so a caller reading back a result must pass that result's grids — not
 * the ones a later plan has already recentred.
 */
export function levelOf(near: Domain, far: Domain, lng: number, lat: number): LevelHit | null {
  for (const [level, domain] of [["near", near], ["far", far]] as const) {
    const point = toLocal(domain, lng, lat);
    const cell = cellOf(domain, point[0], point[1]);
    if (cell) return { level, domain, point, cell };
  }
  return null;
}

/** A cell's centre in the local frame. */
export function cellCentre(d: Domain, col: number, row: number): Vec2 {
  const c = cellM(d);
  const half = d.domainM / 2;
  return [-half + (col + 0.5) * c, -half + (row + 0.5) * c];
}

/**
 * The export's EPSG:3857 geotransform: the north-west corner of cell (0, 0) of
 * the *north-up* image, and the pixel size in 3857 metres.
 */
export function geoTransform3857(d: Domain): { originX: number; originY: number; pixel: number } {
  const half = d.domainM / 2;
  const west = d.origin.x - half * d.metre;
  const north = d.origin.y - half * d.metre;
  return {
    originX: (west - 0.5) * WEB_MERCATOR_EXTENT_M,
    originY: (0.5 - north) * WEB_MERCATOR_EXTENT_M,
    pixel: cellM(d) * d.metre * WEB_MERCATOR_EXTENT_M,
  };
}

// ---------------------------------------------------------------------------
// Coverage

/** Twice the signed area; positive when counter-clockwise. */
function signedArea2(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a;
}

/** The same polygon, counter-clockwise — what the shader's inside test expects. */
export function counterClockwise(poly: Vec2[]): Vec2[] {
  return signedArea2(poly) < 0 ? [...poly].reverse() : poly;
}

/** Sutherland–Hodgman against the square `|x|, |y| ≤ half`. */
export function clipToSquare(poly: Vec2[], half: number): Vec2[] {
  type Edge = { inside: (p: Vec2) => boolean; cut: (a: Vec2, b: Vec2) => Vec2 };
  const at = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const edges: Edge[] = [
    { inside: (p) => p[0] <= half, cut: (a, b) => at(a, b, (half - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[0] >= -half, cut: (a, b) => at(a, b, (-half - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[1] <= half, cut: (a, b) => at(a, b, (half - a[1]) / (b[1] - a[1])) },
    { inside: (p) => p[1] >= -half, cut: (a, b) => at(a, b, (-half - a[1]) / (b[1] - a[1])) },
  ];
  let out = poly;
  for (const edge of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (edge.inside(cur)) {
        if (!edge.inside(prev)) out.push(edge.cut(prev, cur));
        out.push(cur);
      } else if (edge.inside(prev)) {
        out.push(edge.cut(prev, cur));
      }
    }
    if (out.length === 0) break;
  }
  return out;
}

/** Inside (or on) a counter-clockwise convex polygon. */
export function insideConvex(poly: Vec2[], p: Vec2): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    if ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) < 0) return false;
  }
  return true;
}

/** How far, towards the sun, an unseen occluder could still shade from. */
export function reachVector(azimuthDeg: number, elevationDeg: number): Vec2 {
  const [ux, uy] = towardSun(azimuthDeg);
  const r = SHADOW_REACH_M / Math.tan((elevationDeg * Math.PI) / 180);
  return [ux * r, uy * r];
}

