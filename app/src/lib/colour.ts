/**
 * Colours as the ramps and the USD export read them: an sRGB hex as 0–1
 * components, sRGB to linear, and a ramp of stops interpolated in sRGB. Pure;
 * shared by the layers' ramps and `src/lib/usd`.
 */

/** Red, green, blue, each 0–1. */
export type Rgb = [number, number, number];

/** A `#rrggbb` colour as sRGB 0–1 components. */
export function hexRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
}

/** sRGB 0–1 components as linear RGB, by the sRGB transfer function. */
export function srgbToLinear([r, g, b]: Readonly<Rgb>): Rgb {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [f(r), f(g), f(b)];
}

/**
 * A ramp at `x`: linear between the two stops around it, the end colour
 * beyond either end. `stops` are `[position, colour]`, positions ascending.
 */
export function interpolateStops(stops: readonly (readonly [number, Readonly<Rgb>])[], x: number): Rgb {
  if (x <= stops[0][0]) return [...stops[0][1]];
  for (let i = 0; i < stops.length - 1; i++) {
    const [x0, a] = stops[i];
    const [x1, b] = stops[i + 1];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return [...stops[stops.length - 1][1]];
}
