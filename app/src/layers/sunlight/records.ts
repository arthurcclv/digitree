import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { SUNLIGHT_NATIVE_LAYER_ID } from "./sunlightLayer";
import type { SunlightSettings } from "./index";

/** GeoLibre record id. */
export const SUNLIGHT_LAYER_ID = "sunlight";

/**
 * The external-native record, on the tree mesh's pattern: GeoLibre moves and
 * shows the custom layer we add, and routes opacity to it through the paint
 * bridge.
 *
 * `demanded`: the `sunlight.lpi` node is wanted, by the overlay or a
 * dependent. It is what MapLibre's visibility follows, because MapLibre runs no
 * `prerender` for a hidden layer and the light pass lives there. Whether the
 * overlay is *drawn* is `ThreeSunlightLayer.setVisibility`, set by the mount.
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
