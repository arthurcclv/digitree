import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  BUILDING_HEIGHT_EXPRESSION,
  BUILDING_HEIGHT_PROPERTY,
  BUILDING_SHOWN_FILTER,
  minHeightFilter,
  type BuildingSource,
} from "./schema";
import { fetchBuildingsUsd } from "./usd";
import type { ExportFrame, UsdPackage } from "../../lib/usd";

/** Where footprints are, and how one is read. See *Source* in `specs/spec.md`. */
export {
  BUILDING_HEIGHT_EXPRESSION,
  BUILDING_SHOWN_FILTER,
  buildingHeight,
  buildingTiles,
  meetsMinHeight,
  minHeightFilter,
  type BuildingSource,
} from "./schema";

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
  // No control sets `paletteId`; the app always paints flat. The ramps below
  // stay part of the layer's contract — see the spec.
  paletteId: null,
  // Must equal BASEMAPS[0].buildingColor: the app re-patches this only when the
  // basemap changes, so a mismatch paints the first frame for the wrong ground.
  flatColor: "#d6d3cd",
  minHeight: 0,
  labelsOnTop: false,
};

/** Colour by true (unexaggerated) height so the legend stays honest. */
function colorExpression(palette: Palette): string {
  return JSON.stringify([
    "interpolate",
    ["linear"],
    BUILDING_HEIGHT_EXPRESSION,
    ...palette.stops.flat(),
  ]);
}

/**
 * Builds the GeoLibre layer record for OSM building footprints. Nothing here
 * touches MapLibre directly — `createLayerSync` reads this description and
 * materialises the `fill-extrusion` style layer, its paint, and its filters.
 */
export function buildingsLayer(settings: BuildingSettings, source: BuildingSource): GeoLibreLayer {
  const palette = PALETTES.find((p) => p.id === settings.paletteId) ?? null;

  const filters: unknown[] = [BUILDING_SHOWN_FILTER];
  if (settings.minHeight > 0) filters.push(minHeightFilter(settings.minHeight));

  return {
    id: BUILDINGS_LAYER_ID,
    name: source.name,
    type: "vector-tiles",
    source: {
      url: source.tileJson,
      sourceLayer: source.sourceLayer,
      attribution: source.attribution,
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
      extrusionHeightProperty: BUILDING_HEIGHT_PROPERTY,
      extrusionHeightScale: settings.heightScale,
      extrusionColor: settings.flatColor,
      extrusionAdvancedStyleEnabled: palette !== null,
      extrusionColorExpression: palette ? colorExpression(palette) : "",
      extrusionHeightExpression: "",
    },
    metadata: { sourceKind: source.sourceKind },
  };
}

/**
 * The buildings as a USD package, as the extrusion draws them now. See
 * *Buildings* in `src/lib/usd/specs/spec.md`.
 */
export function exportBuildingsUsd(
  source: BuildingSource,
  settings: BuildingSettings,
  frame: ExportFrame,
  fetchFn?: typeof fetch,
): Promise<UsdPackage> {
  return fetchBuildingsUsd(source, settings, PALETTES, frame, fetchFn);
}
