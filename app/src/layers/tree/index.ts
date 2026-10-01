/** The two GeoLibre records. See "The two records" in `specs/spec.md`. */
export { treeMeshRecord, treePointsLayer } from "./records";

/** The layer attached to a map. See `src/lib/mount/specs/spec.md`. */
export { mountTree, type TreeMount } from "./mount";

export {
  ThreeTreeLayer,
  TREE_MESH_MIN_ZOOM,
  TREE_NATIVE_LAYER_ID,
  MAX_INSTANCES,
} from "./treeLayer";

/** The silhouette vocabulary. See "Form classes" in `specs/spec.md`. */
export { formOf, SPECIES_FORMS, type TreeForm } from "./forms";

/** Per-tree variation. See "Rotation is hashed, not random". */
export { rotationOf } from "./placement";

/** The shape each form casts a shadow with. See *The canopy hull*. */
export { canopyHullBaseOf, canopyHullOf, TREE_FORMS } from "./formGeometry";

/** How tall and wide a tree draws. See *Per-instance transform*. */
export { crownScale, type CrownScale } from "./crown";

export { MODELS_ATTRIBUTION, TREE_LAYER_ID, TREE_POINTS_LAYER_ID } from "./constants";

/**
 * Where an inventory is (the host's descriptor) and the one reading of a tree,
 * also for a layer that fetches the tree tiles itself (sunlight). See *Data
 * source*.
 */
export { TREE_PROPS, treeOf, treeTiles, type TreeFeature, type TreeSource } from "./schema";

/** The other half of the silhouette vocabulary. See "The model table". */
export { FORM_MODELS, MODELS_BASE_URL, normalizeModel } from "./models";
export type { ModelGeometry, ModelPart } from "./models";
export type { ModelStatus } from "./treeLayer";

/**
 * The city's inventory is street plus park; `custom` is whatever was dropped
 * into `infra/data/custom/`. Adding a value here means adding it to `TreeKind`
 * in `treeLayer.ts` too, which mirrors this type to avoid a module cycle.
 */
export type TreeKindFilter = "all" | "street" | "park" | "custom";

/**
 * Which of the two mesh sources draws. Mirrored by `MeshSource` in
 * `treeLayer.ts`, which cannot import this without a module cycle.
 *
 * Deliberately not named `"real"`. A modelled tree is a stock asset of a beech
 * or a spruce picked because its silhouette matches a form — not a portrait of
 * the 榕樹 standing at that coordinate, and no more a likeness of it than the
 * icosahedra are. What is real under both sources is the position and the
 * surveyed height.
 */
export type TreeMeshSource = "procedural" | "model";

export interface TreeSettings {
  /** The vector-tile circles, city-wide from z14. */
  pointsVisible: boolean;
  /** The three.js meshes, in the viewport from z16. */
  meshVisible: boolean;
  /** Which geometry those meshes draw. Nothing is fetched until this is "model". */
  meshSource: TreeMeshSource;
  opacity: number;
  /** Exaggeration applied to each tree's surveyed `height_m`; 1 is true scale. */
  heightScale: number;
  kind: TreeKindFilter;
}

export const DEFAULT_TREE_SETTINGS: TreeSettings = {
  pointsVisible: true,
  meshVisible: true,
  // The source that always works: no asset, no request, no licence.
  meshSource: "procedural",
  opacity: 1,
  heightScale: 1,
  kind: "all",
};
