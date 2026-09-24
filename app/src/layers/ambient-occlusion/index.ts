import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { BuildingSettings } from "../buildings";
import { AO_NATIVE_LAYER_ID } from "./aoLayer";

// Only what the app reads. Tests import the folder's modules directly.
export { AO_NATIVE_LAYER_ID, ThreeAoLayer, type AoParams } from "./aoLayer";
export { AO_MIN_ZOOM, type AoState } from "./state";
export { AO_INTENSITY_MAX } from "./kernel";

/** GeoLibre record id. */
export const AO_LAYER_ID = "ambient-occlusion";

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

/**
 * The external-native record, on the sunlight record's pattern. It is shown
 * only while the buildings are: the shading belongs to what is drawn.
 */
export function ambientOcclusionRecord(
  settings: AmbientOcclusionSettings,
  buildings: Pick<BuildingSettings, "visible">,
): GeoLibreLayer {
  return {
    id: AO_LAYER_ID,
    name: "Ambient occlusion · three.js",
    // Inert on the external-native path, as for the tree mesh.
    type: "3d-tiles",
    // Empty on purpose: the layer fetches its own building tiles.
    source: {},
    visible: settings.enabled && buildings.visible,
    // Unused: `intensity` is the strength, set on the layer directly.
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "threejs",
      nativeLayerIds: [AO_NATIVE_LAYER_ID],
      paintMode: "plugin",
    },
  };
}
