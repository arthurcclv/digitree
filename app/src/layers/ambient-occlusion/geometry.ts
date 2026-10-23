/**
 * Which tiles the layer wants, and its building prisms placed in its frame.
 * Pure — see *Geometry* in `specs/spec.md`.
 */
import { meetsMinHeight } from "../buildings";
import {
  placeTile,
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
 * The prisms of every building at least `minHeight` real metres tall, with
 * heights exaggerated by `heightScale`, in the frame's local metres. The
 * filter is the buildings schema's own (`meetsMinHeight`), on true height, so
 * it keeps what the extrusion keeps.
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
      if (!meetsMinHeight(f.heightM, minHeight)) continue;
      size += f.end - f.start;
      buildings++;
    }
  }
  const positions = new Float32Array(size);
  let at = 0;
  for (const { tile, prisms } of parts) {
    for (const f of prisms.features) {
      if (!meetsMinHeight(f.heightM, minHeight)) continue;
      at = placeTile(frame, tile, prisms.prism, positions, at, heightScale, f.start, f.end);
    }
  }
  return { positions, buildings };
}
