import { hexRgb, interpolateStops, type Rgb } from "../../lib/colour";

/**
 * The direct-sun ramp: the spec's *Ramp* table, once. The overlay's shader
 * reads it as a uniform and the USD export through `sunlightRampAt`, so the
 * two cannot drift.
 */

/** `[index, sRGB hex]`, evenly spaced in index. Written raw, never colour-managed. */
export const SUNLIGHT_RAMP: readonly [number, string][] = [
  [0, "#2b2f6b"],
  [0.25, "#5a4f9c"],
  [0.5, "#a0679e"],
  [0.75, "#e39a6d"],
  [1, "#ffe3a1"],
];

/** Incomplete cells, drawn hatched whatever their value. */
export const INCOMPLETE_GREY = "#8a8f98";

const STOPS = SUNLIGHT_RAMP.map(([index, hex]) => [index, hexRgb(hex)] as const);

/** The ramp at an index, as sRGB 0–1: the shader's `ramp`, on the CPU. */
export function sunlightRampAt(index: number): Rgb {
  return interpolateStops(STOPS, index);
}
