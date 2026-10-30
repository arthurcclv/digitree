import { OSM_ATTRIBUTION, OSM_TILEJSON } from "./layers/basemaps";
import type { BuildingSource } from "./layers/buildings";
import type { SplatSource } from "./layers/splat";
import type { TreeSource } from "./layers/tree";

/**
 * The datasets this app points its layers at. The only place the endpoints
 * live: the layers take these as descriptors and know none of them. Another
 * city is a change here, not under `src/layers/`. See
 * `src/lib/tiles/specs/spec.md`.
 */

/**
 * Taipei's tree inventory, from the local PostGIS + Martin stack in `infra/`.
 * Every name here is published by Martin and set in `infra/martin.yaml`.
 * Renaming one there without changing it here makes the layer render nothing,
 * silently. See `infra/CLAUDE.md`.
 */
export const TREES: TreeSource = {
  // Relative on purpose. Martin's own TileJSON advertises an absolute
  // `http://localhost:3000/...`, which would route every tile request past
  // Vite's dev proxy straight at Martin's origin and reintroduce the CORS
  // problem the proxy exists to avoid.
  tiles: "/tiles/trees/{z}/{x}/{y}",
  sourceLayer: "trees",
  // Matches `minzoom` in infra/martin.yaml: below it one tile is most of Taipei.
  minzoom: 14,
  maxzoom: 20,
  // The loaded inventory's extent.
  bounds: [121.4619, 24.9771, 121.6268, 25.1606],
  // A second data source is a second attribution obligation, and MapLibre's
  // own control is disabled — so the app's status bar must render this.
  attribution: "臺北市政府 · Taipei City open data",
  name: "Taipei Trees",
  sourceKind: "postgis-martin",
  // The inventory's measured median height. Used for the ~56 trees whose
  // surveyed `height_m` was missing or implausible.
  fallbackHeightM: 9.1,
};

/**
 * How many surveyed trees `infra/` loads — the street and park open data, the
 * two `kind`s the city publishes. Custom rows are *not* counted: they live in
 * the same source but `infra/` decides how many exist and never tells the app,
 * so this figure is honest only where it is labelled as the surveyed
 * inventory. Reloading `infra/` with a newer extract changes it.
 */
export const TREES_SURVEYED = 162_930;

/**
 * OSM building footprints, from the same OpenFreeMap snapshot the basemaps
 * paint — so the ground plane and the extrusions never disagree. One
 * descriptor, handed to the extrusion and to both self-fetching layers.
 */
export const BUILDINGS: BuildingSource = {
  tileJson: OSM_TILEJSON,
  sourceLayer: "building",
  attribution: OSM_ATTRIBUTION,
  name: "OSM Buildings",
  sourceKind: "osm-openfreemap",
};

/**
 * The Gaussian splat captures in infra: their placements from PostGIS through
 * Martin, their files and the paged LoD trees the layer draws from infra's
 * static `files` service. Both are reached through same-origin proxies
 * (`/tiles` → TILES_PROXY_TARGET, `/files` → FILES_PROXY_TARGET; see
 * `src/lib/tiles/specs/proxy.md`). The table, the source id and the layer name
 * are set in `infra/martin.yaml`, the file paths in `infra/files.conf`. See
 * `src/layers/splat/specs/spec.md`.
 */
export const SPLATS: SplatSource = {
  tiles: "/tiles/splats/{z}/{x}/{y}",
  sourceLayer: "splats",
  files: "/files/3dgs/",
  lodFiles: "/files/3dgs-lod/",
  attribution: "3DGS captures",
  name: "Gaussian splat captures",
  // The median GROUNDZ of the delivered mosaic's tiles (25.07–26.26 m).
  sharedGroundZ: 25.85,
};
