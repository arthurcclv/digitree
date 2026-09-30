import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { settle, TileStore } from "../../lib/tiles";
import {
  buildPackage,
  frameTiles,
  imagePng,
  meshPrim,
  previewMaterial,
  projection,
  UsdExportError,
  usda,
  xform,
  yawQuat,
  Y_UP_TO_Z_UP_ROTATE_X_DEG,
  type ExportFrame,
  type UsdPackage,
  type ZipEntry,
} from "../../lib/usd";
import { MODELS_ATTRIBUTION } from "./constants";
import { buildForm, buildMaterials } from "./formGeometry";
import { formOf, type TreeForm } from "./forms";
import { FORM_MODELS, MODELS_BASE_URL, normalizeModel, type ModelGeometry } from "./models";
import { rotationOf } from "./placement";
import { treeTiles, type TreeFeature, type TreeSource } from "./schema";
import type { TreeSettings } from "./index";

/**
 * The trees as a USD package: one `PointInstancer`, one prototype per form,
 * from whichever mesh source is active. See *Trees* in
 * `src/lib/usd/specs/spec.md`.
 */

export const TREES_USD_NAME = "trees";
const PRIM = "Trees";
const INSTANCER = `/${PRIM}/Instances`;
const LOOKS = `/${PRIM}/Looks`;

export type TreeUsdSettings = Pick<TreeSettings, "kind" | "heightScale" | "meshSource">;

/** One tree as the meshes place it, in the export frame. */
export interface TreeInstance {
  id: string;
  x: number;
  y: number;
  /** Surveyed, or the source's fallback; before `heightScale`. */
  heightM: number;
  form: TreeForm;
  species: string;
}

/**
 * The trees the meshes would draw inside the frame: the kind filter, one per
 * `tree_id`, the fallback height and nothing else, sorted by id.
 */
export function treeInstances(
  features: readonly TreeFeature[],
  kind: TreeSettings["kind"],
  frame: ExportFrame,
  fallbackHeightM: number,
): TreeInstance[] {
  const proj = projection(frame);
  const byId = new Map<string, TreeInstance>();
  for (const t of features) {
    if (kind !== "all" && t.kind !== kind) continue;
    if (byId.has(t.id)) continue;
    const [x, y] = proj.toLocal(t.lng, t.lat);
    if (!proj.inside(x, y)) continue;
    byId.set(t.id, {
      id: t.id,
      x,
      y,
      heightM: t.heightM ?? fallbackHeightM,
      form: formOf(t.species),
      species: typeof t.species === "string" ? t.species : "",
    });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One drawable piece of a prototype, in its own Y-up metres. */
export interface PrototypePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface Prototype {
  parts: PrototypePart[];
  baseHeightM: number;
}

/** A geometry's triangles as USD mesh data; glTF's `uv` becomes `st` with `v` flipped. */
export function geometryMesh(g: THREE.BufferGeometry) {
  const pos = g.getAttribute("position");
  const points = Array.from({ length: pos.count * 3 }, (_, i) => pos.getComponent(Math.floor(i / 3), i % 3));
  const index = g.getIndex();
  const faceVertexIndices = index ? Array.from(index.array) : Array.from({ length: pos.count }, (_, i) => i);
  const faceVertexCounts = new Array(faceVertexIndices.length / 3).fill(3);
  const n = g.getAttribute("normal");
  const normals = n ? Array.from({ length: n.count * 3 }, (_, i) => n.getComponent(Math.floor(i / 3), i % 3)) : undefined;
  const uv = g.getAttribute("uv");
  const st = uv
    ? Array.from({ length: uv.count * 2 }, (_, i) => {
        const v = uv.getComponent(Math.floor(i / 2), i % 2);
        return i % 2 ? 1 - v : v;
      })
    : undefined;
  return { points, faceVertexIndices, faceVertexCounts, normals, st };
}

/**
 * A material's standard-surface fields, each possibly missing. A part holds a
 * `THREE.Material`; GLTFLoader's and the procedural ones are standard, and
 * another kind reads as missing fields.
 */
function surfaceOf(m: THREE.Material): Partial<Pick<THREE.MeshStandardMaterial, "color" | "map" | "roughness">> {
  // Narrow, and safe: every field is optional, so nothing is assumed present.
  return m as Partial<THREE.MeshStandardMaterial>;
}

/** A three.js material's colour: three keeps colours linear, which is what USD wants. */
function colourOf(m: THREE.Material): [number, number, number] {
  const c = surfaceOf(m).color;
  return c ? [c.r, c.g, c.b] : [0.18, 0.18, 0.18];
}

/** Encodes a texture's image as PNG. Injected, so the package can be built without a browser. */
export type TextureEncoder = (texture: THREE.Texture) => Promise<Uint8Array>;

export const encodeTexturePng: TextureEncoder = (texture) => {
  // three types `image` loosely; a loaded glTF's is an ImageBitmap or an
  // HTMLImageElement, both drawable and sized.
  const image = texture.image as CanvasImageSource & { width: number; height: number };
  return imagePng(image, image.width, image.height);
};

/** The package from placed trees and the prototypes of the forms they use. */
export async function treesPackage(
  trees: readonly TreeInstance[],
  prototypes: ReadonlyMap<TreeForm, Prototype>,
  settings: Pick<TreeUsdSettings, "heightScale">,
  frame: ExportFrame,
  attribution: string[],
  encode: TextureEncoder = encodeTexturePng,
): Promise<UsdPackage> {
  const forms = [...new Set(trees.map((t) => t.form))].sort();
  const protoIndex = new Map(forms.map((f, i) => [f, i]));

  // Materials are per prototype part, deduplicated by three's own identity.
  const materials = new Map<THREE.Material, string>();
  const taken = new Set<string>();
  const textures = new Map<THREE.Texture, string>();
  const files: ZipEntry[] = [];
  const looks = [];
  const protoPrims = [];
  for (const form of forms) {
    const proto = prototypes.get(form);
    if (!proto) throw new UsdExportError(TREES_USD_NAME, "failed", `no prototype for form "${form}"`);
    const meshes = [];
    for (let i = 0; i < proto.parts.length; i++) {
      const { geometry, material } = proto.parts[i];
      let path = materials.get(material);
      if (!path) {
        // The material's own name when it has a free one, else its first user's.
        const own = material.name ? usda.identifier(material.name) : "";
        let name = own && !taken.has(own) ? own : usda.identifier(`${form}_${i}`);
        for (let k = 2; taken.has(name); k++) name = usda.identifier(`${form}_${i}_${k}`);
        taken.add(name);
        path = `${LOOKS}/${name}`;
        materials.set(material, path);
        const map = surfaceOf(material).map ?? null;
        let texture: string | undefined;
        if (map?.image) {
          texture = textures.get(map);
          if (!texture) {
            texture = `textures/${name}.png`;
            textures.set(map, texture);
            files.push({ name: texture, data: await encode(map) });
          }
        }
        const mask = material.alphaTest > 0;
        looks.push(
          previewMaterial(LOOKS, name, {
            diffuse: colourOf(material),
            texture,
            opacityFromTexture: Boolean(texture) && mask,
            opacityThreshold: mask ? material.alphaTest : 0,
            roughness: surfaceOf(material).roughness ?? 0.9,
          }),
        );
      }
      meshes.push(
        meshPrim(`part${i}`, {
          ...geometryMesh(geometry),
          doubleSided: material.side === THREE.DoubleSide,
          material: path,
        }),
      );
    }
    protoPrims.push(xform(usda.identifier(form), meshes, { rotateXDeg: Y_UP_TO_Z_UP_ROTATE_X_DEG }));
  }

  const positions: number[] = [];
  const orientations: number[] = [];
  const scales: number[] = [];
  const indices: number[] = [];
  for (const t of trees) {
    const s = (t.heightM * settings.heightScale) / prototypes.get(t.form)!.baseHeightM;
    positions.push(t.x, t.y, 0);
    orientations.push(...yawQuat(rotationOf(t.id)));
    scales.push(s, s, s);
    indices.push(protoIndex.get(t.form)!);
  }
  const targets = forms.map((f) => `<${INSTANCER}/Prototypes/${usda.identifier(f)}>`).join(", ");
  const instancer = {
    type: "PointInstancer",
    name: "Instances",
    props: [
      usda.prop("quath[]", "orientations", usda.tuples(orientations, 4)),
      usda.prop("point3f[]", "positions", usda.tuples(positions, 3)),
      usda.prop("string[]", "primvars:species", usda.strings(trees.map((t) => t.species)), { interpolation: "vertex" }),
      usda.prop("string[]", "primvars:treeId", usda.strings(trees.map((t) => t.id)), { interpolation: "vertex" }),
      usda.prop("int[]", "protoIndices", usda.numbers(indices)),
      `rel prototypes = [${targets}]`,
      usda.prop("float3[]", "scales", usda.tuples(scales, 3)),
    ],
    children: [{ type: "Scope", name: "Prototypes", children: protoPrims }],
  };

  return buildPackage({
    name: TREES_USD_NAME,
    prim: PRIM,
    frame,
    attribution,
    custom: { heightScale: settings.heightScale },
    files,
    children: [xform("Looks", looks), instancer],
  });
}

/** The procedural prototypes: `buildForm`'s bark and canopy, with the two shared materials. */
export function proceduralPrototypes(forms: Iterable<TreeForm>): Map<TreeForm, Prototype> {
  const [bark, canopy] = buildMaterials();
  bark.name = "Bark";
  canopy.name = "Canopy";
  const out = new Map<TreeForm, Prototype>();
  for (const form of forms) {
    const g = buildForm(form);
    out.set(form, {
      parts: [
        { geometry: g.bark, material: bark },
        { geometry: g.canopy, material: canopy },
      ],
      baseHeightM: g.baseHeightM,
    });
  }
  return out;
}

/** A form's model at level 0, the full-detail rung, normalised as the layer does. */
export type ModelLoader = (form: TreeForm) => Promise<ModelGeometry>;

export const loadModelLevel0: ModelLoader = async (form) =>
  normalizeModel((await new GLTFLoader().loadAsync(MODELS_BASE_URL + FORM_MODELS[form])).scene);

export async function modelPrototypes(forms: Iterable<TreeForm>, load: ModelLoader): Promise<Map<TreeForm, Prototype>> {
  const out = new Map<TreeForm, Prototype>();
  for (const form of forms) {
    try {
      out.set(form, await load(form));
    } catch (e) {
      throw new UsdExportError(TREES_USD_NAME, "failed", `model for "${form}" did not load: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export interface TreeUsdDeps {
  fetchFn?: typeof fetch;
  loadModel?: ModelLoader;
  encode?: TextureEncoder;
}

/** Fetch every tile the frame touches, place the trees, build the package. */
export async function exportTreesUsd(
  source: TreeSource,
  settings: TreeUsdSettings,
  frame: ExportFrame,
  deps: TreeUsdDeps = {},
): Promise<UsdPackage> {
  const store = new TileStore({ trees: treeTiles(source) }, deps.fetchFn);
  const tiles = frameTiles(frame);
  const counts = await settle(store, tiles);
  if (counts.failed) throw new UsdExportError(TREES_USD_NAME, "failed", `${counts.failed} tree tile(s) failed to load`);
  const trees = treeInstances(
    tiles.flatMap((t) => store.featuresOf("trees", t)),
    settings.kind,
    frame,
    source.fallbackHeightM,
  );
  const forms = new Set(trees.map((t) => t.form));
  const modelled = settings.meshSource === "model";
  const prototypes = modelled
    ? await modelPrototypes(forms, deps.loadModel ?? loadModelLevel0)
    : proceduralPrototypes(forms);
  const attribution = [source.attribution, ...(modelled ? [MODELS_ATTRIBUTION] : [])];
  return treesPackage(trees, prototypes, settings, frame, attribution, deps.encode);
}
