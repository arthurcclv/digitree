import { lngLatToMercator, metreInMercator, TILE_ZOOM, type TileId } from "../tiles";

/**
 * The one frame every exported file shares: `x` east, `y` north, `z` up, in
 * metres, origin at the frame centre on the ground. See *The export frame* in
 * `specs/spec.md`.
 */
export interface ExportFrame {
  centre: { lng: number; lat: number };
  /** The square's side in metres: the USD export card's *Side*. */
  sizeM: number;
}

/** The frame the host exports: a `sizeM` square centred on a point. */
export function exportFrame(lng: number, lat: number, sizeM: number): ExportFrame {
  if (!(sizeM > 0) || !Number.isFinite(sizeM)) throw new Error(`not an export side: ${sizeM}`);
  return { centre: { lng, lat }, sizeM };
}

/** A frame's projection, computed once. */
export interface FrameProjection {
  /** A lng/lat in the frame's metres. */
  toLocal(lng: number, lat: number): [number, number];
  /** Is a local point inside the square? */
  inside(x: number, y: number): boolean;
}

export function projection(frame: ExportFrame): FrameProjection {
  const o = lngLatToMercator(frame.centre.lng, frame.centre.lat);
  const metre = metreInMercator(frame.centre.lat);
  const half = frame.sizeM / 2;
  return {
    toLocal(lng, lat) {
      const p = lngLatToMercator(lng, lat);
      // Mercator y runs south; local y north.
      return [(p.x - o.x) / metre, -(p.y - o.y) / metre];
    },
    inside: (x, y) => Math.abs(x) <= half && Math.abs(y) <= half,
  };
}

/** The frame's square in Web Mercator units: west, north, east, south edges. */
export function mercatorBounds(frame: ExportFrame): { minX: number; minY: number; maxX: number; maxY: number } {
  const o = lngLatToMercator(frame.centre.lng, frame.centre.lat);
  const h = (frame.sizeM / 2) * metreInMercator(frame.centre.lat);
  return { minX: o.x - h, minY: o.y - h, maxX: o.x + h, maxY: o.y + h };
}

/** The frame's square as lng/lat: west, south, east, north. */
export function lngLatBounds(frame: ExportFrame): [number, number, number, number] {
  const b = mercatorBounds(frame);
  const lng = (x: number) => x * 360 - 180;
  const lat = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;
  return [lng(b.minX), lat(b.maxY), lng(b.maxX), lat(b.minY)];
}

/** Every tile on the shared grid the frame's square touches, row by row. */
export function frameTiles(frame: ExportFrame, z = TILE_ZOOM): TileId[] {
  const b = mercatorBounds(frame);
  const n = 2 ** z;
  const x0 = Math.floor(b.minX * n);
  const x1 = Math.floor(b.maxX * n);
  const y0 = Math.floor(b.minY * n);
  const y1 = Math.floor(b.maxY * n);
  const out: TileId[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y, z });
  return out;
}

/**
 * A yaw of `theta` radians about `+z`, as USD's `(real, i, j, k)`. The tree
 * layer yaws about its `+y`, which is this frame's `+z`, by the same angle.
 */
export function yawQuat(theta: number): [number, number, number, number] {
  return [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)];
}

/**
 * A Y-up vector in this Z-up frame: `(x, y, z)` → `(x, −z, y)`, which is a
 * `rotateX` of 90°. Each Y-up prototype carries that op instead of having its
 * points rewritten.
 */
export function yUpToZUp([x, y, z]: readonly [number, number, number]): [number, number, number] {
  return [x, -z, y];
}
export const Y_UP_TO_Z_UP_ROTATE_X_DEG = 90;

/**
 * Is a grid centred on the frame, within half a cell? Its side may differ: a
 * raster layer fits it to the frame first. One that is not centred rejects as
 * `failed`: see *Sunlight and temperature* in `specs/spec.md`.
 */
export function gridCentredOnFrame(centre: readonly [number, number], cellM: number, frame: ExportFrame): boolean {
  const [x, y] = projection(frame).toLocal(centre[0], centre[1]);
  return Math.abs(x) <= cellM / 2 && Math.abs(y) <= cellM / 2;
}
