// Only what the app reads. Tests import the folder's modules directly.
export {
  SUNLIGHT_NATIVE_LAYER_ID,
  ThreeSunlightLayer,
  type ProbeResult,
  type SunlightStatus,
} from "./sunlightLayer";
export { SUNLIGHT_MIN_ZOOM, type SunlightState } from "./state";
// The DAG node, for the layers that derive from the index.
export { LPI_NODE, LPI_SAMPLE_GLSL, type LpiField, type LpiLevel } from "./lpi";
export type { Domain } from "./frame";
export { MIN_SUN_ELEVATION_DEG } from "./sun";
export type { TileCounts } from "../../lib/tiles";
export { SUNLIGHT_LAYER_ID, sunlightRecord } from "./records";
/** The layer attached to a map. See `src/lib/mount/specs/spec.md`. */
export { mountSunlight, type SunlightMount } from "./mount";

export interface SunlightSettings {
  /**
   * Overlay on/off. Off means nothing is fetched or computed, unless a
   * dependent (the temperature layer) wants the index.
   */
  visible: boolean;
  opacity: number;
  /** The moment, in epoch milliseconds. */
  sunTime: number;
}

// ---------------------------------------------------------------------------
// Asia/Taipei is UTC+8 all year, with no daylight saving — so local time is an
// offset, not a time-zone lookup.

const TAIPEI_OFFSET_MS = 8 * 3600_000;

/** `YYYY-MM-DD` in Asia/Taipei. */
export function taipeiDate(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes past midnight in Asia/Taipei. */
export function taipeiMinutes(ms: number): number {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** The epoch ms of a Taipei date and minute of day. */
export function fromTaipei(date: string, minutes: number): number {
  return Date.parse(`${date}T00:00:00Z`) - TAIPEI_OFFSET_MS + minutes * 60_000;
}

/** Today at noon, Taipei time. */
export function defaultSunTime(now = Date.now()): number {
  return fromTaipei(taipeiDate(now), 12 * 60);
}

/** The panel's time-of-day range, in Taipei minutes. */
export const SUN_TIME_MIN = 5 * 60;
export const SUN_TIME_MAX = 19 * 60;
export const SUN_TIME_STEP = 15;

export const DEFAULT_SUNLIGHT_SETTINGS: SunlightSettings = {
  visible: false,
  opacity: 0.8,
  sunTime: defaultSunTime(),
};
