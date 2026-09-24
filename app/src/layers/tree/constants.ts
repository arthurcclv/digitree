/**
 * The source contract with `infra/`. Shared by the GeoLibre record in
 * `index.ts` and the three.js layer in `treeLayer.ts`, which reads the same
 * parsed tiles back out of MapLibre — hence its own module, so neither of those
 * two has to import the other.
 *
 * Every name here is published by Martin and set in `infra/martin.yaml`.
 * Renaming one there without changing it here makes the layer render nothing,
 * silently. See `infra/CLAUDE.md`.
 */

/** GeoLibre record id for the vector-tile half. */
export const TREE_POINTS_LAYER_ID = "tree-points";

/** GeoLibre record id for the three.js half. */
export const TREE_LAYER_ID = "threejs-tree";

/** The MVT layer inside each tile. */
export const TREES_SOURCE_LAYER = "trees";

/**
 * Relative on purpose. Martin's own TileJSON advertises an absolute
 * `http://localhost:3000/...`, which would route every tile request past Vite's
 * dev proxy straight at Martin's origin and reintroduce the CORS problem the
 * proxy exists to avoid. Using `source.tiles` instead of `source.url` costs
 * only the three fields below, which the TileJSON would otherwise have carried.
 */
export const TREES_TILES = "/tiles/trees/{z}/{x}/{y}";

/** Matches `minzoom` in infra/martin.yaml: below it one tile is most of Taipei. */
export const TREES_MIN_ZOOM = 14;
export const TREES_MAX_ZOOM = 20;

/** The loaded inventory's extent, west/south/east/north. */
export const TREES_BOUNDS: [number, number, number, number] = [
  121.4619, 24.9771, 121.6268, 25.1606,
];

/**
 * A second data source is a second attribution obligation, and MapLibre's own
 * control is disabled — so the app's status bar must render this.
 */
export const TREES_ATTRIBUTION = "臺北市政府 · Taipei City open data";

/**
 * A third obligation, and the only conditional one: the glTF models are CC BY
 * 4.0, which requires the author, the licence and a link, but only while they
 * are being used. Showing this under the procedural source would credit
 * evolveduk for icosahedra. `public/models/trees/CREDITS.md` carries the
 * per-file detail the status bar has no room for.
 */
export const MODELS_ATTRIBUTION = "Tree models: evolveduk · CC BY 4.0";
