import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { OSM_ATTRIBUTION, OSM_TILEJSON } from "./basemaps";

export const BUILDINGS_LAYER_ID = "osm-buildings";

/**
 * Style-layer ids GeoLibre derives for this layer. `@geolibre/map` names a
 * single-source-layer vector tile extrusion `layer-<id>-vector-extrusion`;
 * we need the id to re-anchor the layer under the basemap labels.
 */
export const BUILDINGS_STYLE_LAYER_IDS = [
  `layer-${BUILDINGS_LAYER_ID}-vector-extrusion`,
  `layer-${BUILDINGS_LAYER_ID}-vector`,
];

export interface Palette {
  id: string;
  label: string;
  /** Ramp stops as [height in metres, colour]. */
  stops: [number, string][];
}

export const PALETTES: Palette[] = [
  {
    id: "ember",
    label: "Ember",
    stops: [
      [0, "#2b3040"],
      [12, "#3f4358"],
      [30, "#6c5570"],
      [70, "#b06a52"],
      [140, "#e8974a"],
      [260, "#ffd98e"],
    ],
  },
  {
    id: "jade",
    label: "Jade",
    stops: [
      [0, "#16303a"],
      [12, "#1d4a4e"],
      [30, "#2b6b63"],
      [70, "#4a9b7f"],
      [140, "#8fd0a0"],
      [260, "#dcf5cf"],
    ],
  },
  {
    id: "neon",
    label: "Neon",
    stops: [
      [0, "#241a44"],
      [12, "#3a2470"],
      [30, "#5c30a3"],
      [70, "#9b3fc4"],
      [140, "#e3559b"],
      [260, "#ffc3e0"],
    ],
  },
];

export interface BuildingSettings {
  visible: boolean;
  /** Vertical exaggeration applied to the OSM `render_height` attribute. */
  heightScale: number;
  opacity: number;
  /** `null` paints every building one flat colour instead of a height ramp. */
  paletteId: string | null;
  flatColor: string;
  /** Hide anything shorter than this (in real metres) to declutter. */
  minHeight: number;
  /**
   * Draw the basemap's street labels above the extrusions. Off by default:
   * labels styled for a dark ground are unreadable over lit building faces.
   */
  labelsOnTop: boolean;
}

export const DEFAULT_BUILDING_SETTINGS: BuildingSettings = {
  visible: true,
  heightScale: 1,
  opacity: 0.94,
  paletteId: "ember",
  flatColor: "#3d4658",
  minHeight: 0,
  labelsOnTop: false,
};

/** Colour by true (unexaggerated) height so the legend stays honest. */
function colorExpression(palette: Palette): string {
  return JSON.stringify([
    "interpolate",
    ["linear"],
    ["to-number", ["get", "render_height"], 0],
    ...palette.stops.flat(),
  ]);
}

/**
 * Builds the GeoLibre layer record for OSM building footprints. Nothing here
 * touches MapLibre directly — `createLayerSync` reads this description and
 * materialises the `fill-extrusion` style layer, its paint, and its filters.
 */
export function buildingsLayer(settings: BuildingSettings): GeoLibreLayer {
  const palette = PALETTES.find((p) => p.id === settings.paletteId) ?? null;

  const filters: unknown[] = [["!=", ["get", "hide_3d"], true]];
  if (settings.minHeight > 0) {
    filters.push([">=", ["to-number", ["get", "render_height"], 0], settings.minHeight]);
  }

  return {
    id: BUILDINGS_LAYER_ID,
    name: "OSM Buildings",
    type: "vector-tiles",
    source: {
      url: OSM_TILEJSON,
      sourceLayer: "building",
      attribution: OSM_ATTRIBUTION,
    },
    visible: settings.visible,
    opacity: 1,
    filterExpression: filters.length === 1 ? (filters[0] as unknown[]) : ["all", ...filters],
    style: {
      ...DEFAULT_LAYER_STYLE,
      minZoom: 13,
      maxZoom: 24,
      extrusionEnabled: true,
      extrusionOpacity: settings.opacity,
      extrusionBase: 0,
      extrusionHeightProperty: "render_height",
      extrusionHeightScale: settings.heightScale,
      extrusionColor: settings.flatColor,
      extrusionAdvancedStyleEnabled: palette !== null,
      extrusionColorExpression: palette ? colorExpression(palette) : "",
      extrusionHeightExpression: "",
    },
    metadata: { sourceKind: "osm-openfreemap" },
  };
}
