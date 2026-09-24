import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * OpenFreeMap serves OpenStreetMap data as OpenMapTiles-schema vector tiles —
 * no API key, no registration. The same `openmaptiles` source that paints the
 * basemap also carries the `building` layer we extrude, so the ground plane and
 * the 3D buildings always come from one OSM snapshot.
 */
export const OSM_TILEJSON = "https://tiles.openfreemap.org/planet";

export const OSM_ATTRIBUTION =
  "© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap";

export interface Basemap {
  id: string;
  label: string;
  styleUrl: string;
  /**
   * Default building colour that reads well against this basemap. This is the
   * only place a basemap's colour identity reaches the app — the interface
   * chrome has one fixed accent and does not re-tint per basemap.
   */
  buildingColor: string;
  light: boolean;
}

/** Ordered; `BASEMAPS[0]` is the app's initial basemap. Paper leads. */
export const BASEMAPS: Basemap[] = [
  {
    id: "positron",
    label: "Paper",
    styleUrl: "https://tiles.openfreemap.org/styles/positron",
    buildingColor: "#d6d3cd",
    light: true,
  },
  {
    id: "dark",
    label: "Midnight",
    styleUrl: "https://tiles.openfreemap.org/styles/dark",
    buildingColor: "#3d4658",
    light: false,
  },
  {
    id: "fiord",
    label: "Fiord",
    styleUrl: "https://tiles.openfreemap.org/styles/fiord",
    buildingColor: "#3b4a63",
    light: false,
  },
  {
    id: "liberty",
    label: "Liberty",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    buildingColor: "#c9c3b6",
    light: true,
  },
];

const GEOLIBRE_LAYER_PREFIX = "layer-";

/**
 * Every basemap ships its own flat (and, in Liberty, extruded) building layers.
 * They z-fight with the GeoLibre-managed extrusion, so hide them and let
 * GeoLibre own the building rendering outright.
 */
export function hideBasemapBuildings(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith(GEOLIBRE_LAYER_PREFIX)) continue;
    if (/building/i.test(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

/** The basemap's first label layer, so extrusions can slot underneath it. */
export function firstLabelLayerId(map: MapLibreMap): string | undefined {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === "symbol" && !layer.id.startsWith(GEOLIBRE_LAYER_PREFIX)) {
      return layer.id;
    }
  }
  return undefined;
}

/**
 * `createLayerSync` always appends to the top of the stack, so re-anchor the
 * GeoLibre layers beneath the basemap labels after every sync.
 */
export function anchorUnderLabels(map: MapLibreMap, layerIds: string[]): void {
  const before = firstLabelLayerId(map);
  if (!before) return;
  for (const id of layerIds) {
    if (map.getLayer(id) && map.getLayer(before)) {
      try {
        map.moveLayer(id, before);
      } catch {
        /* style reloading mid-flight */
      }
    }
  }
}
