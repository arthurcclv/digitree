/**
 * Form → glTF model. The table behind *The model table* and *Geometry — the
 * modelled source* in `specs/spec.md`.
 *
 * The procedural source in `formGeometry.ts` builds its eight shapes out of
 * icosahedra and cylinders; this module loads eight authored ones instead. The
 * two are interchangeable by design: both hand the layer a list of
 * `{ geometry, material }` parts plus the height the shape was modelled at, and
 * the layer places them identically.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { radialWidthM } from "./crown";
import type { TreeForm } from "./forms";

/** Where `prepare-tree-models.py` writes, and Vite serves from `public/`. */
export const MODELS_BASE_URL = "/models/trees/";

/** A rung of the detail ladder. See *Levels of detail* in `specs/spec.md`. */
export interface LodLevel {
  /** 0 is the authored model; every rung above it is decimated. */
  level: number;
  /**
   * Drawn when the camera is no farther than this. `null` on the last rung,
   * which catches everything beyond.
   */
  maxDistanceM: number | null;
}

/**
 * The ladder, **as data**.
 *
 * Adding a third rung — an `L2` beyond, say, 600 m — is a row here and a row in
 * `tools/prepare-tree-models.py`, not a change to any of the code below.
 * Nothing in the layer names a level; it indexes one.
 *
 * This is also why the levels are numbered rather than called `near` and `far`.
 * A two-value name is a two-value ceiling, in the file name and in the type
 * behind it alike, and it would have to be unpicked by whoever adds the third.
 *
 * Entries must stay ordered by `level`, ascending from 0 and without gaps: a
 * level indexes straight into `FormModel.levels`. `models.test.ts` asserts it.
 */
export const MODEL_LODS: readonly LodLevel[] = [
  { level: 0, maxDistanceM: 300 },
  { level: 1, maxDistanceM: null },
];

export type ModelLod = number;

/**
 * The level a tree at this distance draws — the lowest-numbered rung whose
 * reach covers it.
 *
 * Pure, and separated from the layer for that reason: it is the one part of the
 * LOD rule that can be tested without a map, a camera or a GL context.
 */
export function lodFor(distanceM: number): ModelLod {
  for (const rung of MODEL_LODS) {
    if (rung.maxDistanceM === null || distanceM <= rung.maxDistanceM) return rung.level;
  }
  return MODEL_LODS[MODEL_LODS.length - 1].level;
}

/**
 * The file a level is served from: `oak_tree.glb` at level 0, and
 * `oak_tree.L1.glb`, `oak_tree.L2.glb` … above it.
 *
 * Level 0 keeps the plain name because it is the authored model — the one
 * `FORM_MODELS` and `CREDITS.md` already name.
 */
export function lodFileFor(file: string, level: ModelLod): string {
  return level === 0 ? file : file.replace(/\.glb$/, `.L${level}.glb`);
}

/**
 * One file per form.
 *
 * Like `SPECIES_FORMS`, this is *data*: swapping which file a form loads is a
 * judgement correction and needs no spec change. Three rows are approximate and
 * the spec says so at length — `palm-fan` is served by a feather palm because
 * nothing in the set is palmate, `columnar` draws 福木 as bamboo culms, and
 * `tiered` gets a flat umbrella where 黑板樹 is a whorled pagoda. The set holds
 * nine further models that no row names; they are the shelf this table is
 * retuned from, and nothing fetches them.
 */
export const FORM_MODELS: Readonly<Record<TreeForm, string>> = {
  spreading: "oak_tree.glb",
  upright: "beech_tree.glb",
  tiered: "acacia_tree.glb",
  columnar: "bamboo.glb",
  conic: "spruce.glb",
  "palm-feather": "coconut_palm.glb",
  "palm-fan": "date_palm.glb",
  generic: "maple_tree.glb",
};

/** One drawable piece of a model: its own geometry, its own authored material. */
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface ModelGeometry {
  /** Between one and five, depending on how the asset was authored. */
  parts: ModelPart[];
  /**
   * The height the model stands at, **measured here and never declared**. The
   * spec's table prints a number for each file; this is the one the layer
   * scales by, for the same reason `FormGeometry.baseHeightM` is measured.
   */
  baseHeightM: number;
  /**
   * The width it stands at, by `radialWidthM`, over **every part**: a glTF has
   * no bark/canopy split to rely on. Measured, like the height.
   */
  baseWidthM: number;
}

/** One form's ladder, plus the single size every rung scales from. */
export interface FormModel {
  /** Indexed by level, so `levels[0]` is the authored model. */
  levels: ModelGeometry[];
  /** Measured from **level 0**, and shared by the ladder. See `matchHeight`. */
  baseHeightM: number;
  /** Measured from level 0 too, and shared for the same reason. */
  baseWidthM: number;
}

/**
 * Scale a model so it stands exactly `heightM` tall.
 *
 * Decimation moves a bounding box a little, so a decimated level measured on
 * its own stands a fraction of a percent shorter than level 0 — and every tree
 * in the city would twitch as it crossed a threshold. The whole ladder
 * therefore shares level 0's height, and each rung above it is brought to that
 * height here. The scale is about the origin, which the model already stands
 * on, so this cannot lift it off the ground or shift it sideways.
 */
export function matchHeight(model: ModelGeometry, heightM: number, widthM: number): ModelGeometry {
  const factor = heightM / model.baseHeightM;
  if (Number.isFinite(factor) && factor !== 1) {
    for (const part of model.parts) {
      part.geometry.scale(factor, factor, factor);
      part.geometry.computeBoundingBox();
    }
  }
  // The rung's own width, after the uniform scale, sits within decimation's
  // error of level 0's. It takes level 0's, so a tree with a surveyed width
  // draws that width at every level rather than twitching across a threshold.
  return { parts: model.parts, baseHeightM: heightM, baseWidthM: widthM };
}

/**
 * Turn a parsed glTF scene into something instanceable.
 *
 * Three things have to happen, and the spec's *Normalisation* section says why:
 * the node tree is flattened into world-space geometries (Sketchfab exports
 * carry their Y-up correction as a root rotation), the result is moved so it
 * stands on the origin (`old_tree` ships with 1.21 m of root below its own),
 * and the height is measured from what is left.
 */
export function normalizeModel(root: THREE.Object3D): ModelGeometry {
  root.updateMatrixWorld(true);

  const parts: ModelPart[] = [];
  const sources = new Set<THREE.BufferGeometry>();

  root.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    if (Array.isArray(mesh.material)) {
      // GLTFLoader gives every glTF primitive its own Mesh, so a material array
      // means the file is shaped in a way this loader has never seen. Refusing
      // is better than silently drawing one of the materials for all of them.
      throw new Error(`multi-material mesh "${mesh.name}" is not instanceable`);
    }
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    sources.add(mesh.geometry);
    parts.push({ geometry, material: mesh.material });
  });

  if (!parts.length) throw new Error("model contains no mesh");

  const bounds = new THREE.Box3();
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    bounds.union(part.geometry.boundingBox!);
  }

  // Stand it on the origin, centred on X/Z — the frame every instance matrix in
  // `treeLayer.ts` assumes, and the one the procedural builders already use.
  const offset = new THREE.Vector3(
    -(bounds.min.x + bounds.max.x) / 2,
    -bounds.min.y,
    -(bounds.min.z + bounds.max.z) / 2,
  );
  for (const part of parts) {
    part.geometry.translate(offset.x, offset.y, offset.z);
    part.geometry.computeBoundingBox();
  }

  // The loader's own geometries were cloned above and are no longer referenced.
  // The materials are: they carry the textures and go into the layer's registry.
  for (const geometry of sources) geometry.dispose();

  for (const material of new Set(parts.map((p) => p.material))) {
    // three.js and MapLibre share one GL context, and MapLibre blends with
    // `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`. GLTFLoader has no idea it is
    // loading into that context, so nothing else will set this.
    material.premultipliedAlpha = true;
  }

  return {
    parts,
    baseHeightM: bounds.max.y - bounds.min.y,
    baseWidthM: radialWidthM(parts.map((p) => p.geometry)),
  };
}

/**
 * Fetch and normalise one form's whole ladder.
 *
 * Every rung is required: a form that cannot load one of its files is not a
 * modelled form. Rejecting rather than falling back to the rungs that did
 * arrive keeps the failure in one place — the layer leaves such a form
 * procedural for the rest of the session, rather than retrying or substituting
 * another form's file.
 */
export async function loadFormModel(
  form: TreeForm,
  loader: GLTFLoader = new GLTFLoader(),
): Promise<FormModel> {
  const file = FORM_MODELS[form];
  const levels = await Promise.all(
    MODEL_LODS.map(async ({ level }) =>
      normalizeModel(
        (await loader.loadAsync(MODELS_BASE_URL + lodFileFor(file, level))).scene,
      ),
    ),
  );
  const { baseHeightM, baseWidthM } = levels[0];
  return {
    levels: levels.map((level, i) => (i === 0 ? level : matchHeight(level, baseHeightM, baseWidthM))),
    baseHeightM,
    baseWidthM,
  };
}
