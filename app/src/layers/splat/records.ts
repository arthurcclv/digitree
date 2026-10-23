import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { SPLAT_LAYER_ID, SPLAT_NATIVE_LAYER_ID } from "./constants";
import type { SplatSettings } from "./index";

/**
 * The external-native record, on the tree mesh's pattern: GeoLibre only moves
 * and shows the custom layer. One record for every capture, because Spark
 * sorts them together in one draw.
 */
export function splatRecord(settings: SplatSettings): GeoLibreLayer {
  return {
    id: SPLAT_LAYER_ID,
    name: "Gaussian splats · three.js",
    // The real LayerType at last; still inert on the external-native path.
    type: "gaussian-splat",
    // Empty on purpose: the layer fetches its own tiles and files.
    source: {},
    visible: settings.visible,
    opacity: settings.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "threejs",
      nativeLayerIds: [SPLAT_NATIVE_LAYER_ID],
      paintMode: "plugin",
    },
  };
}
