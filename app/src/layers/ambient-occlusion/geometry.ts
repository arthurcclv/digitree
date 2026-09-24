/**
 * Which tiles the layer wants, and its building prisms placed in its frame.
 * Pure — see *Geometry* in `specs/spec.md`.
 */
import {
  lngLatToMercator,
  placeTile,
  TILE_ZOOM,
  type LocalFrame,
  type TileId,
  type TilePrisms,
} from "../../lib/tiles";

/**
 * Tiles are planned no further than this from the centre, in metres, and the
 * ground plane is this half-width. Beyond it a pitched view's ground is a few
 * pixels per building and draws without occlusion.
 */
export const AO_FETCH_HALF_M = 4096;

/**
 * Every z14 tile meeting the footprint's bounding box — clipped to
 * `halfM` around the centre — plus one ring of neighbours.
 */
export function planAoTiles(frame: LocalFrame, footprint: [number, number][], halfM = AO_FETCH_HALF_M): TileId[] {
  if (footprint.length < 3) return [];
  const pts = footprint.map(([lng, lat]) => lngLatToMercator(lng, lat));
  const lim = halfM * frame.metre;
  const clampX = (v: number) => Math.max(frame.origin.x - lim, Math.min(frame.origin.x + lim, v));
  const clampY = (v: number) => Math.max(frame.origin.y - lim, Math.min(frame.origin.y + lim, v));
  const n = 2 ** TILE_ZOOM;
  const x0 = Math.floor(clampX(Math.min(...pts.map((p) => p.x))) * n) - 1;
  const x1 = Math.floor(clampX(Math.max(...pts.map((p) => p.x))) * n) + 1;
  const y0 = Math.floor(clampY(Math.min(...pts.map((p) => p.y))) * n) - 1;
  const y1 = Math.floor(clampY(Math.max(...pts.map((p) => p.y))) * n) + 1;
  const tiles: TileId[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y, z: TILE_ZOOM });
  return tiles;
}

/**
 * The prisms of every building at least `minHeight` real metres tall, with
 * heights exaggerated by `heightScale`, in the frame's local metres. The
 * filter reads true height, as the extrusion's does.
 */
export function placeAoPrisms(
  frame: LocalFrame,
  parts: { tile: TileId; prisms: TilePrisms }[],
  heightScale: number,
  minHeight: number,
): { positions: Float32Array; buildings: number } {
  let size = 0;
  let buildings = 0;
  for (const { prisms } of parts) {
    for (const f of prisms.features) {
      if (f.heightM < minHeight) continue;
      size += f.end - f.start;
      buildings++;
    }
  }
  const positions = new Float32Array(size);
  let at = 0;
  for (const { tile, prisms } of parts) {
    for (const f of prisms.features) {
      if (f.heightM < minHeight) continue;
      at = placeTile(frame, tile, prisms.prism, positions, at, heightScale, f.start, f.end);
    }
  }
  return { positions, buildings };
}
