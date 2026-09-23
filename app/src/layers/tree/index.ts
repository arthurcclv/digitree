import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { TREE_BASE_HEIGHT_M, TREE_NATIVE_LAYER_ID } from "./treeLayer";

/** The GeoLibre layer record's id — what appears in the `sync([...])` list. */
export const TREE_LAYER_ID = "threejs-tree";

export {
  ThreeTreeLayer,
  TREE_BASE_HEIGHT_M,
  TREE_LOCATION,
  TREE_NATIVE_LAYER_ID,
} from "./treeLayer";

export interface TreeSettings {
  visible: boolean;
  opacity: number;
  /** Rendered height in metres. */
  height: number;
}

export const DEFAULT_TREE_SETTINGS: TreeSettings = {
  visible: true,
  opacity: 1,
  height: TREE_BASE_HEIGHT_M,
};

/**
 * The GeoLibre record for the three.js layer.
 *
 * `metadata.customLayerType` is the flag `syncExternalNativeLayer` branches on:
 * GeoLibre then only *moves and shows* the native layer ids listed here, leaving
 * creation and painting to us. That is what lets the tree travel in the same
 * `sync([...])` call as the OSM buildings and still be drawn by three.js.
 */
export function treeLayerRecord(settings: TreeSettings): GeoLibreLayer {
  return {
    id: TREE_LAYER_ID,
    name: "Tree · three.js",
    // Inert on this path — the external-native branch never reads `type`.
    // "3d-tiles" is the closest LayerType for an externally rendered 3D mesh.
    type: "3d-tiles",
    source: {},
    visible: settings.visible,
    opacity: settings.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "threejs",
      nativeLayerIds: [TREE_NATIVE_LAYER_ID],
      // GeoLibre cannot apply MapLibre paint properties to a custom layer.
      paintMode: "plugin",
    },
  };
}
