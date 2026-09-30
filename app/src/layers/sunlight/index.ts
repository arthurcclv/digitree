// Only what the app reads. Tests import the folder's modules directly.
export {
  SUNLIGHT_NATIVE_LAYER_ID,
  ThreeSunlightLayer,
  type ProbeResult,
  type SunlightStatus,
} from "./sunlightLayer";
export { SUNLIGHT_MIN_ZOOM, type SunlightState } from "./state";
// The DAG node, for the layers that derive from the index.
export { LPI_NODE, LPI_SAMPLE_GLSL, type LpiField, type LpiLevel, type NearGrid, type NearRead } from "./lpi";
// A read of the export pass as a USD raster, for a derived layer's package.
export { nearRaster } from "./usd";
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

/**
 * Everything but the moment. Which noon is "today" depends on where the host
 * is, so the host supplies `sunTime`; see `src/lib/place/specs/spec.md`.
 */
export const DEFAULT_SUNLIGHT_SETTINGS: Omit<SunlightSettings, "sunTime"> = {
  visible: false,
  opacity: 0.8,
};
