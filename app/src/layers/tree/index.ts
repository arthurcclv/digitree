import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  TREES_BOUNDS,
  TREES_MAX_ZOOM,
  TREES_MIN_ZOOM,
  TREES_SOURCE_LAYER,
  TREES_TILES,
  TREE_LAYER_ID,
  TREE_POINTS_LAYER_ID,
} from "./constants";
import { TREE_NATIVE_LAYER_ID } from "./treeLayer";

export {
  ThreeTreeLayer,
  TREE_BASE_HEIGHT_M,
  TREE_FALLBACK_HEIGHT_M,
  TREE_MESH_MIN_ZOOM,
  TREE_NATIVE_LAYER_ID,
  MAX_INSTANCES,
} from "./treeLayer";

export {
  TREES_ATTRIBUTION,
  TREES_MIN_ZOOM,
  TREES_SOURCE_LAYER,
  TREE_LAYER_ID,
  TREE_POINTS_LAYER_ID,
} from "./constants";

/**
 * The city's inventory is street plus park; `custom` is whatever was dropped
 * into `infra/data/custom/`. Adding a value here means adding it to `TreeKind`
 * in `treeLayer.ts` too, which mirrors this type to avoid a module cycle.
 */
export type TreeKindFilter = "all" | "street" | "park" | "custom";

export interface TreeSettings {
  /** The vector-tile circles, city-wide from z14. */
  pointsVisible: boolean;
  /** The three.js meshes, in the viewport from z16. */
  meshVisible: boolean;
  opacity: number;
  /** Exaggeration applied to each tree's surveyed `height_m`; 1 is true scale. */
  heightScale: number;
  kind: TreeKindFilter;
}

export const DEFAULT_TREE_SETTINGS: TreeSettings = {
  pointsVisible: true,
  meshVisible: true,
  opacity: 1,
  heightScale: 1,
  kind: "all",
};

/**
 * Canopy green for street trees, a cooler green for park trees — and a warm
 * ochre for custom ones, which is deliberately *not* a third green: the point
 * of the segment is seeing at a glance which trees are yours rather than the
 * city's. It is no relation of `--accent`, which is chrome.
 */
const COLOR_STREET = "#5f8f5a";
const COLOR_PARK = "#4a8f86";
const COLOR_CUSTOM = "#c08a45";
const COLOR_UNKNOWN = "#5c6b7a";

/**
 * Colour by `kind` rather than by species: the inventory names 291 street and
 * 448 park species, which no legend can carry.
 */
function colorExpression(): string {
  return JSON.stringify([
    "match",
    ["get", "kind"],
    "street",
    COLOR_STREET,
    "park",
    COLOR_PARK,
    "custom",
    COLOR_CUSTOM,
    COLOR_UNKNOWN,
  ]);
}

/** Both records narrow together, so the two views never show different data. */
function kindFilter(kind: TreeKindFilter): unknown[] | undefined {
  return kind === "all" ? undefined : ["==", ["get", "kind"], kind];
}

/**
 * The vector-tile half: every tree in the city as a circle, sized by its
 * surveyed height and coloured by street/park.
 *
 * Nothing here touches MapLibre — `createLayerSync` reads this description and
 * materialises the circle style layer, its paint, and its filters.
 */
export function treePointsLayer(settings: TreeSettings): GeoLibreLayer {
  const filter = kindFilter(settings.kind);

  // The three.js layer has no source of its own — it reads the tiles MapLibre
  // parsed for *this* layer. MapLibre stops keeping those the moment a layer is
  // `visibility: none`, so hiding the circles would silently starve the meshes:
  // `querySourceFeatures` returns 0 and the 3D trees vanish with it. So the
  // layer stays visible whenever either half is wanted, and "points off" is
  // expressed as zero circle opacity instead.
  const sourceNeeded = settings.pointsVisible || settings.meshVisible;

  return {
    id: TREE_POINTS_LAYER_ID,
    name: "Taipei Trees",
    type: "vector-tiles",
    source: {
      tiles: [TREES_TILES],
      sourceLayer: TREES_SOURCE_LAYER,
      minzoom: TREES_MIN_ZOOM,
      maxzoom: TREES_MAX_ZOOM,
      bounds: TREES_BOUNDS,
    },
    visible: sourceNeeded,
    opacity: settings.pointsVisible ? settings.opacity : 0,
    ...(filter ? { filterExpression: filter } : {}),
    style: {
      ...DEFAULT_LAYER_STYLE,
      minZoom: TREES_MIN_ZOOM,
      maxZoom: 24,
      extrusionEnabled: false,
      // Radius tracks the surveyed height. `height_m` is null for the ~78 trees
      // whose survey value was missing or implausible; GeoLibre's interpolate
      // falls those back to the range minimum, so they draw as the smallest
      // dot — visibly least-known rather than invisibly average.
      proportionalSizeEnabled: true,
      proportionalSizeProperty: "height_m",
      proportionalSizeMinValue: 2,
      proportionalSizeMaxValue: 25,
      proportionalSizeMinRadius: 1.4,
      proportionalSizeMaxRadius: 5,
      vectorStyleMode: "expression",
      vectorStyleExpression: colorExpression(),
      fillColor: COLOR_UNKNOWN,
      fillOpacity: 0.85,
      // No halo: at 163k points a stroke merges neighbouring trees into mush.
      strokeWidth: 0,
    },
    metadata: { sourceKind: "postgis-martin" },
  };
}

/**
 * The three.js half.
 *
 * `metadata.customLayerType` is the flag `syncExternalNativeLayer` branches on:
 * GeoLibre then only *moves and shows* the native layer ids listed here, leaving
 * creation and painting to us. That is what lets the meshes travel in the same
 * `sync([...])` call as the OSM buildings.
 */
export function treeMeshRecord(settings: TreeSettings): GeoLibreLayer {
  return {
    id: TREE_LAYER_ID,
    name: "Trees · three.js",
    // Inert on this path — the external-native branch never reads `type`.
    // "3d-tiles" is the closest LayerType for an externally rendered 3D mesh.
    type: "3d-tiles",
    // Empty on purpose: this layer fetches nothing. It reads the tiles MapLibre
    // already parsed for `tree-points`. See the spec.
    source: {},
    visible: settings.meshVisible,
    opacity: settings.opacity,
    // No `filterExpression`: GeoLibre cannot filter a layer it does not paint.
    // The kind filter is applied inside ThreeTreeLayer via `setKind`, which is
    // what keeps the meshes showing the same subset as the circles.
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "threejs",
      nativeLayerIds: [TREE_NATIVE_LAYER_ID],
      // GeoLibre cannot apply MapLibre paint properties to a custom layer.
      paintMode: "plugin",
    },
  };
}
