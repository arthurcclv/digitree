import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { TEMPERATURE_NATIVE_LAYER_ID } from "./temperatureLayer";
import type { TemperatureSettings } from "./index";

/** GeoLibre record id. */
export const TEMPERATURE_LAYER_ID = "temperature";

/**
 * The external-native record, on the direct-sun record's pattern: GeoLibre
 * moves and shows the custom layer we add, and routes opacity and visibility to
 * it through the paint bridge.
 */
export function temperatureRecord(settings: TemperatureSettings): GeoLibreLayer {
  return {
    id: TEMPERATURE_LAYER_ID,
    name: "Felt temperature (PET) · three.js",
    // Inert on the external-native path, as for the tree mesh.
    type: "3d-tiles",
    // Empty on purpose: every input arrives through the DAG, not a source.
    source: {},
    visible: settings.visible,
    opacity: settings.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "threejs",
      nativeLayerIds: [TEMPERATURE_NATIVE_LAYER_ID],
      paintMode: "plugin",
    },
  };
}
