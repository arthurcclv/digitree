import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { SUNLIGHT_NATIVE_LAYER_ID } from "./sunlightLayer";

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

/** GeoLibre record id. */
export const SUNLIGHT_LAYER_ID = "sunlight";

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

/**
 * The external-native record, on the tree mesh's pattern: GeoLibre moves and
 * shows the custom layer we add, and routes opacity and visibility to it
 * through the paint bridge.
 */
/**
 * `demanded`: the `sunlight.lpi` node is wanted, by the overlay or a
 * dependent. It is what MapLibre's visibility follows, because MapLibre runs no
 * `prerender` for a hidden layer and the light pass lives there. Whether the
 * overlay is *drawn* is `ThreeSunlightLayer.setVisibility`, set by the engine.
 */
export function sunlightRecord(settings: SunlightSettings, demanded = settings.visible): GeoLibreLayer {
  return {
    id: SUNLIGHT_LAYER_ID,
    name: "Direct sun · three.js",
    // Inert on the external-native path, as for the tree mesh.
    type: "3d-tiles",
    // Empty on purpose: the layer fetches its own tree and building tiles
    // (tiles.ts), which GeoLibre has no part in.
    source: {},
    visible: demanded,
    opacity: settings.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "threejs",
      nativeLayerIds: [SUNLIGHT_NATIVE_LAYER_ID],
      paintMode: "plugin",
    },
  };
}
