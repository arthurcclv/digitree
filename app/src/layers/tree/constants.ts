/**
 * The layer's own ids and obligations. Shared by the GeoLibre records and the
 * three.js layer, hence its own module, so neither of those has to import the
 * other. Where the inventory is served is not here: that is the host's
 * `TreeSource` (see `schema.ts`).
 */

/** GeoLibre record id for the vector-tile half. */
export const TREE_POINTS_LAYER_ID = "tree-points";

/** GeoLibre record id for the three.js half. */
export const TREE_LAYER_ID = "threejs-tree";

/**
 * An attribution obligation, and the only conditional one: the glTF models are
 * CC BY 4.0, which requires the author, the licence and a link, but only while
 * they are being used. Showing this under the procedural source would credit
 * evolveduk for icosahedra. `public/models/trees/CREDITS.md` carries the
 * per-file detail the status bar has no room for.
 */
export const MODELS_ATTRIBUTION = "Tree models: evolveduk · CC BY 4.0";

/**
 * The two marks a tree can carry (`specs/tree-info.md`, *Highlight*): the one
 * under the pointer, and the one whose card is open. Selection chrome, so they
 * come from the accent's text colour rather than from the kind palette. On the
 * meshes they multiply the material, on the circles they replace the colour.
 */
export const TREE_HOVER_COLOR = "#b9d4ec";
export const TREE_SELECTED_COLOR = "#7fb8e6";

/** The feature-state keys the circles' colour reads. */
export const TREE_STATE = { hover: "hover", selected: "selected" } as const;
