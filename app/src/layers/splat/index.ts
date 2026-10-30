// Only what the app reads. Tests import the folder's modules directly.
import { SPLAT_MIN_ZOOM } from "./constants";

export { SPLAT_KEEP_M, SPLAT_LAYER_ID, SPLAT_MIN_ZOOM, SPLAT_NATIVE_LAYER_ID } from "./constants";
export { splatRecord } from "./records";

/** The layer attached to a map. See `src/lib/mount/specs/spec.md`. */
export { mountSplat, type SplatMount } from "./mount";

/** Where the captures are (the host's descriptor) and the one reading of one. See *`SplatSource`*. */
export { splatOf, type Splat, type SplatSource } from "./schema";
export type { SplatStatus } from "./state";

export interface SplatSettings {
  /** All captures, shown and hidden together. */
  visible: boolean;
  /** 0–1, applied to every capture. */
  opacity: number;
  /** Below it nothing new loads and nothing is drawn. */
  minZoom: number;
  /**
   * Spark's LoD splat budget per frame, across every loaded capture; `null`
   * keeps Spark's platform default (2.5 M on desktop). See *Settings*.
   */
  lodSplatCount: number | null;
  /** Multiplies the budget, whichever it is. */
  lodSplatScale: number;
  /**
   * Each capture lowered by its own ground (`true`), or all by the source's
   * `sharedGroundZ` (`false`). See *Settings*.
   */
  snapToGround: boolean;
}

export const DEFAULT_SPLAT_SETTINGS: SplatSettings = {
  // Off: nothing is fetched until asked for, and a capture is tens of MB.
  visible: false,
  opacity: 1,
  minZoom: SPLAT_MIN_ZOOM,
  lodSplatCount: null,
  lodSplatScale: 1,
  snapToGround: true,
};

/**
 * What the panel's budget slider starts from when "Platform budget" is
 * unchecked before Spark has loaded: Spark's desktop default, its
 * `defaultSplatTarget()`. Once Spark has loaded, the device's own is used.
 */
export const SPLAT_FALLBACK_BUDGET = 2_500_000;

/** The panel's ranges for the two LoD settings. */
export const SPLAT_BUDGET_RANGE = { min: 250_000, max: 10_000_000, step: 250_000 } as const;
export const SPLAT_BUDGET_SCALE_RANGE = { min: 0.1, max: 4, step: 0.05 } as const;
