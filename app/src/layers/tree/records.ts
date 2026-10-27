import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  TREE_HOVER_COLOR,
  TREE_LAYER_ID,
  TREE_POINTS_LAYER_ID,
  TREE_SELECTED_COLOR,
  TREE_STATE,
} from "./constants";
import { TREE_PROPS, type TreeSource } from "./schema";
import { TREE_NATIVE_LAYER_ID } from "./treeLayer";
import type { TreeKindFilter, TreeSettings } from "./index";

// The two GeoLibre records. Pure descriptions: nothing here touches MapLibre.

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

/** The circles' kind colours, for the UI that names a kind (the tree card's badge). */
export const TREE_KIND_COLORS: Readonly<Record<string, string>> = {
  street: COLOR_STREET,
  park: COLOR_PARK,
  custom: COLOR_CUSTOM,
};

/**
 * Colour by `kind` rather than by species: the inventory names 291 street and
 * 448 park species, which no legend can carry. A marked tree (selected, then
 * hovered) takes its mark's colour instead, read from feature-state so that
 * marking one never changes the record. Exported for its test.
 */
export function colorExpression(): string {
  const state = (key: string) => ["boolean", ["feature-state", key], false];
  return JSON.stringify([
    "case",
    state(TREE_STATE.selected),
    TREE_SELECTED_COLOR,
    state(TREE_STATE.hover),
    TREE_HOVER_COLOR,
    [
      "match",
      ["get", TREE_PROPS.kind],
      "street",
      COLOR_STREET,
      "park",
      COLOR_PARK,
      "custom",
      COLOR_CUSTOM,
      COLOR_UNKNOWN,
    ],
  ]);
}

/** Both records narrow together, so the two views never show different data. */
function kindFilter(kind: TreeKindFilter): unknown[] | undefined {
  return kind === "all" ? undefined : ["==", ["get", TREE_PROPS.kind], kind];
}

/**
 * The vector-tile half: every tree in the city as a circle, sized by its
 * surveyed height and coloured by street/park.
 *
 * Nothing here touches MapLibre — `createLayerSync` reads this description and
 * materialises the circle style layer, its paint, and its filters.
 */
export function treePointsLayer(settings: TreeSettings, source: TreeSource): GeoLibreLayer {
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
    name: source.name,
    type: "vector-tiles",
    source: {
      tiles: [source.tiles],
      sourceLayer: source.sourceLayer,
      minzoom: source.minzoom,
      maxzoom: source.maxzoom,
      bounds: source.bounds,
    },
    visible: sourceNeeded,
    opacity: settings.pointsVisible ? settings.opacity : 0,
    ...(filter ? { filterExpression: filter } : {}),
    style: {
      ...DEFAULT_LAYER_STYLE,
      minZoom: source.minzoom,
      maxZoom: 24,
      extrusionEnabled: false,
      // Radius tracks the surveyed height. `height_m` is null for the ~56 trees
      // whose survey value was missing or implausible; GeoLibre's interpolate
      // falls those back to the range minimum, so they draw as the smallest
      // dot — visibly least-known rather than invisibly average.
      proportionalSizeEnabled: true,
      proportionalSizeProperty: TREE_PROPS.height,
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
    metadata: { sourceKind: source.sourceKind },
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
