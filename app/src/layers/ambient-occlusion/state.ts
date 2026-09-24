/** Nothing is drawn below this: MapLibre then draws simplified z13 tiles. */
export const AO_MIN_ZOOM = 14;

export type AoState = "off" | "unsupported" | "zoom" | "ready";

/**
 * Whether the layer may work, decided before any planning. `off` covers both
 * the setting and hidden buildings. See *Recompute* in `specs/spec.md`.
 */
export function aoState(s: { visible: boolean; supported: boolean; zoom: number }): AoState {
  if (!s.visible) return "off";
  if (!s.supported) return "unsupported";
  if (s.zoom < AO_MIN_ZOOM) return "zoom";
  return "ready";
}
