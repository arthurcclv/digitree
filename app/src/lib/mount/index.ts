/**
 * How a layer with a custom (three.js) half is attached to a map, in any
 * GeoLibre host that owns a MapLibre map and a `LayerSync`. See
 * `specs/spec.md`.
 */
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import {
  clearExternalNativePaintBridge,
  setExternalNativePaintBridge,
  type ExternalNativePaintBridge,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { Graph } from "../dag";

export interface MountContext {
  /** The host's map; its style need not be loaded yet. */
  map: MapLibreMap;
  /** The host's one derived-layer DAG for this map. */
  graph: Graph;
}

export interface LayerMount<S> {
  /** The whole settings object, every time; only what changed reaches the layer. */
  update(settings: S): void;
  /**
   * The layer's records, in its own stack order. Call only once the style is
   * loaded, immediately before `sync`, after every pending `update`.
   */
  prepareSync(): GeoLibreLayer[];
  /** Map teardown only, in reverse mount order. */
  dispose(): void;
}

export interface NativeLayer {
  /** Add the custom layer if the style has dropped it (every `setStyle` does). */
  ensureAdded(): void;
  /** Clear the paint bridge. The custom layer's own teardown is the mount's. */
  dispose(): void;
}

/** The part every custom-layer mount shares: its paint bridge and its re-adding. */
export function nativeLayer(
  map: MapLibreMap,
  recordId: string,
  custom: CustomLayerInterface,
  bridge: ExternalNativePaintBridge,
): NativeLayer {
  setExternalNativePaintBridge(recordId, bridge);
  return {
    ensureAdded() {
      if (!map.getLayer(custom.id)) map.addLayer(custom);
    },
    dispose() {
      clearExternalNativePaintBridge(recordId);
    },
  };
}

/** Whether `key` differs between two settings objects; `prev` null means first. */
export function changed<S>(prev: S | null, next: S, ...keys: (keyof S)[]): boolean {
  return prev == null || keys.some((k) => prev[k] !== next[k]);
}
