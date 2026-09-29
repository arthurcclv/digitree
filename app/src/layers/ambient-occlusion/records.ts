import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { AO_NATIVE_LAYER_ID } from "./aoLayer";
import type { AmbientOcclusionSettings, ShadedExtrusion } from "./index";

/** GeoLibre record id. */
export const AO_LAYER_ID = "ambient-occlusion";

/**
 * The external-native record, on the sunlight record's pattern. It is shown
 * only while the extrusion it shades is: the shading belongs to what is drawn.
 */
export function ambientOcclusionRecord(
  settings: AmbientOcclusionSettings,
  extrusion: Pick<ShadedExtrusion, "visible">,
): GeoLibreLayer {
  return {
    id: AO_LAYER_ID,
    name: "Ambient occlusion · three.js",
    // Inert on the external-native path, as for the tree mesh.
    type: "3d-tiles",
    // Empty on purpose: the layer fetches its own building tiles.
    source: {},
    visible: settings.enabled && extrusion.visible,
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
