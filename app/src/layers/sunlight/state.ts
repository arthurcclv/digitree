import { MIN_SUN_ELEVATION_DEG } from "./sun";

/**
 * The layer's state machine, free of three.js and MapLibre so it can be
 * tested. See *Readouts, probe and export* and *Recompute* in `specs/spec.md`.
 */

/** Below this a flat view outgrows the grids. See *Recompute*. */
export const SUNLIGHT_MIN_ZOOM = 12;

export type SunlightState = "off" | "zoom" | "low-sun" | "unsupported" | "waiting" | "ready";

/**
 * The state that stops all work, or `null` when the layer may plan, fetch and
 * compute. It is decided before any of that, so a blocked layer does none of it.
 */
export function blockedState(c: {
  visible: boolean;
  supported: boolean;
  zoom: number;
  elevationDeg: number;
}): SunlightState | null {
  if (!c.visible) return "off";
  if (!c.supported) return "unsupported";
  if (c.zoom < SUNLIGHT_MIN_ZOOM) return "zoom";
  if (c.elevationDeg < MIN_SUN_ELEVATION_DEG) return "low-sun";
  return null;
}

type Sun = { azimuthDeg: number; elevationDeg: number };

/**
 * The sun the readout shows: the drawn result's while `ready`, else the sun at
 * the set time — a sun that has just set must not read as the last one drawn.
 */
export function readoutSun(state: SunlightState, drawn: Sun | null, now: Sun | null): Sun | null {
  return state === "ready" && drawn ? drawn : now;
}

/**
 * What the layer does with its DAG node on a state change: publish after a
 * pass that reached `ready`, clear on leaving `ready`. See *The LPI node*.
 */
export function lpiNodeAction(prev: SunlightState, next: SunlightState, passed: boolean): "publish" | "clear" | null {
  if (next === "ready") return passed ? "publish" : null;
  return prev === "ready" ? "clear" : null;
}
