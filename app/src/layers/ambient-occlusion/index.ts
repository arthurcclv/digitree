// Only what the app reads. Tests import the folder's modules directly.
export { AO_NATIVE_LAYER_ID, ThreeAoLayer, type AoParams } from "./aoLayer";
export { AO_MIN_ZOOM, type AoState } from "./state";
export { AO_INTENSITY_MAX } from "./kernel";

export { AO_LAYER_ID, ambientOcclusionRecord } from "./records";
/** The layer attached to a map. See `src/lib/mount/specs/spec.md`. */
export {
  mountAmbientOcclusion,
  type AmbientOcclusionMount,
  type AmbientOcclusionMountSettings,
} from "./mount";

export interface AmbientOcclusionSettings {
  enabled: boolean;
  /**
   * How strongly occlusion darkens, 0 to `AO_INTENSITY_MAX`: 0 has no effect,
   * 1 multiplies by the occlusion, 2 doubles the darkening (clamped at black).
   */
  intensity: number;
  /** The reach of the occlusion, in ground metres. */
  radiusM: number;
}

export const DEFAULT_AO_SETTINGS: AmbientOcclusionSettings = {
  enabled: true,
  intensity: 1,
  radiusM: 6,
};

/** The panel's radius range, in metres. */
export const AO_RADIUS_MIN_M = 2;
export const AO_RADIUS_MAX_M = 20;
