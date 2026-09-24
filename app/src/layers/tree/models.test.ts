import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { DEFAULT_TREE_SETTINGS } from "./index";
import {
  FORM_MODELS,
  lodFileFor,
  lodFor,
  matchHeight,
  MODEL_LODS,
  normalizeModel,
} from "./models";
import { TREE_FORMS } from "./formGeometry";

const MODELS_DIR = fileURLToPath(new URL("../../../public/models/trees/", import.meta.url));

/** Just the JSON chunk of a .glb — enough to read `asset.extras`. */
function glbHeader(file: string): Record<string, any> {
  const raw = readFileSync(MODELS_DIR + file);
  return JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)).toString("utf8"));
}

const served = readdirSync(MODELS_DIR).filter((f) => f.endsWith(".glb"));

/** Triangles across every primitive, straight out of the accessors. */
function triangles(file: string): number {
  const doc = glbHeader(file);
  return (doc.meshes ?? [])
    .flatMap((m: any) => m.primitives)
    .reduce((total: number, p: any) => {
      const accessor = doc.accessors[p.indices ?? p.attributes.POSITION];
      return total + accessor.count / 3;
    }, 0);
}

const size = (file: string) => readFileSync(MODELS_DIR + file).byteLength;

describe("FORM_MODELS", () => {
  test("names exactly one model per form", () => {
    expect(Object.keys(FORM_MODELS).sort()).toEqual([...TREE_FORMS].sort());
  });

  test("every named model is actually served", () => {
    for (const form of TREE_FORMS) expect(served).toContain(FORM_MODELS[form]);
  });

  test("no two forms share a model", () => {
    const files = TREE_FORMS.map((form) => FORM_MODELS[form]);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("the detail ladder", () => {
  // A level indexes straight into `FormModel.levels`, so the table has to be
  // ordered from 0 without gaps. Adding an L2 row out of order breaks that
  // silently — every tree would draw the wrong rung.
  test("is ordered from 0 without gaps", () => {
    MODEL_LODS.forEach((rung, i) => expect(rung.level).toBe(i));
  });

  test("reaches farther at every rung, and the last one catches everything", () => {
    const reaches = MODEL_LODS.map((rung) => rung.maxDistanceM);
    expect(reaches.at(-1)).toBeNull();
    const bounded = reaches.slice(0, -1) as number[];
    expect(bounded.every((d) => typeof d === "number" && d > 0)).toBe(true);
    expect([...bounded].sort((a, b) => a - b)).toEqual(bounded);
  });

  test("keeps level 0 at the plain name and numbers the rest", () => {
    expect(lodFileFor("oak_tree.glb", 0)).toBe("oak_tree.glb");
    expect(lodFileFor("oak_tree.glb", 1)).toBe("oak_tree.L1.glb");
    // Extensible by construction: a rung that does not exist yet still names
    // the file it would be served from.
    expect(lodFileFor("oak_tree.glb", 2)).toBe("oak_tree.L2.glb");
    // Only the extension, so a name that happens to contain "glb" survives.
    expect(lodFileFor("glb_tree.glb", 1)).toBe("glb_tree.L1.glb");
  });

  test("picks the lowest rung whose reach covers the distance", () => {
    const first = MODEL_LODS[0].maxDistanceM!;
    expect(lodFor(0)).toBe(0);
    expect(lodFor(first)).toBe(0); // inclusive at the boundary
    expect(lodFor(first + 0.001)).toBe(1);
    expect(lodFor(Number.POSITIVE_INFINITY)).toBe(MODEL_LODS.at(-1)!.level);
  });

  test("ships every rung of every form", () => {
    for (const form of TREE_FORMS) {
      for (const { level } of MODEL_LODS) {
        expect(served, `${form} L${level}`).toContain(
          lodFileFor(FORM_MODELS[form], level),
        );
      }
    }
  });

  // The whole reason the ladder exists. Measured over Da'an the modelled source
  // drew 95.2M triangles a frame and took the map from 120fps to 13.
  test("decimates at every rung above 0, for every form", () => {
    for (const form of TREE_FORMS) {
      const file = FORM_MODELS[form];
      for (const { level } of MODEL_LODS.slice(1)) {
        const ratio = triangles(file) / triangles(lodFileFor(file, level));
        expect(ratio, `${form} L${level} (${file})`).toBeGreaterThan(2);
      }
    }
  });

  test("decimates the whole set by at least 4x at level 1", () => {
    let base = 0;
    let decimated = 0;
    for (const form of TREE_FORMS) {
      base += triangles(FORM_MODELS[form]);
      decimated += triangles(lodFileFor(FORM_MODELS[form], 1));
    }
    expect(base / decimated).toBeGreaterThan(4);
  });

  test("shrinks the textures too, so a rung is nearly free to ship", () => {
    for (const form of TREE_FORMS) {
      const file = FORM_MODELS[form];
      for (const { level } of MODEL_LODS.slice(1)) {
        expect(size(lodFileFor(file, level)), `${file} L${level}`).toBeLessThan(
          size(file) / 2,
        );
      }
    }
  });
});

describe("matchHeight", () => {
  /** A model standing on the origin, `h` metres tall. */
  function standing(h: number) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, h, 1).translate(0, h / 2, 0),
      new THREE.MeshStandardMaterial(),
    );
    return normalizeModel(new THREE.Object3D().add(mesh));
  }

  // Decimation moves a bounding box slightly. Measured on its own, a decimated
  // rung stands a fraction shorter than level 0 — and every tree in the city
  // would twitch as it crossed a threshold.
  test("brings a rung to the height it is given", () => {
    const matched = matchHeight(standing(9.8), 10);
    expect(matched.baseHeightM).toBeCloseTo(10);
    matched.parts[0].geometry.computeBoundingBox();
    const box = matched.parts[0].geometry.boundingBox!;
    expect(box.max.y - box.min.y).toBeCloseTo(10);
  });

  test("keeps the model standing on the origin", () => {
    const matched = matchHeight(standing(4), 10);
    expect(matched.parts[0].geometry.boundingBox!.min.y).toBeCloseTo(0);
  });

  test("leaves a model that already matches untouched", () => {
    const model = standing(10);
    const before = model.parts[0].geometry.attributes.position.array.slice();
    matchHeight(model, 10);
    expect(model.parts[0].geometry.attributes.position.array).toEqual(before);
  });
});

describe("the served folder", () => {
  // Invariant 17. `public/` is downloadable by definition, so a licence that
  // forbids redistributing the model file forbids serving it — this is what
  // makes re-adding `stylized_tropical_pack.glb` fail the suite rather than ship.
  test("every model declares a CC-BY licence in asset.extras", () => {
    for (const file of served) {
      const licence = String(glbHeader(file).asset?.extras?.license ?? "");
      expect(licence.toUpperCase(), `${file} licence`).toMatch(/^CC-BY/);
    }
  });

  test("keeps the author and source URL the prep script must preserve", () => {
    for (const file of served) {
      const extras = glbHeader(file).asset?.extras ?? {};
      expect(extras.author, `${file} author`).toBeTruthy();
      expect(extras.source, `${file} source`).toContain("http");
    }
  });

  test("every model is credited", () => {
    const credits = readFileSync(MODELS_DIR + "CREDITS.md", "utf8");
    for (const file of served) expect(credits).toContain(`\`${file}\``);
  });

  // The prep step, from the other end: an original would still be PNG and would
  // not declare the extension that makes its textures loadable.
  test("every model is a prepared one", () => {
    for (const file of served) {
      const doc = glbHeader(file);
      expect(doc.extensionsRequired, file).toContain("EXT_texture_webp");
      for (const image of doc.images ?? []) expect(image.mimeType, file).toBe("image/webp");
    }
  });
});

describe("normalizeModel", () => {
  /** A two-part model: a 1 m cube at y 2..3, and a 1 m cube at y 5..6. */
  function scene(): THREE.Object3D {
    const root = new THREE.Object3D();
    for (const y of [2.5, 5.5]) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1).translate(4, y, 4),
        new THREE.MeshStandardMaterial(),
      );
      root.add(mesh);
    }
    return root;
  }

  test("stands the model on the origin and centres it on X/Z", () => {
    const { parts } = normalizeModel(scene());
    const bounds = new THREE.Box3();
    for (const part of parts) bounds.union(part.geometry.boundingBox!);
    expect(bounds.min.y).toBeCloseTo(0);
    expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(0);
    expect((bounds.min.z + bounds.max.z) / 2).toBeCloseTo(0);
  });

  test("measures the height rather than taking it on trust", () => {
    // 2..6 in the source, so 4 m tall however far off the origin it started.
    expect(normalizeModel(scene()).baseHeightM).toBeCloseTo(4);
  });

  test("bakes parent transforms into the geometry", () => {
    // Sketchfab exports carry their Y-up correction as a root rotation; if it
    // is not baked, this model lies down and every tree is scaled by its width.
    const root = scene();
    root.rotation.x = -Math.PI / 2;
    // 1 m deep in Z before the rotation, so 1 m tall after it.
    expect(normalizeModel(root).baseHeightM).toBeCloseTo(1);
  });

  test("keeps one part per mesh, with its own material", () => {
    const { parts } = normalizeModel(scene());
    expect(parts).toHaveLength(2);
    expect(new Set(parts.map((p) => p.material)).size).toBe(2);
  });

  test("premultiplies alpha, which nothing else will do", () => {
    // MapLibre blends with `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` and GLTFLoader
    // has no idea it is loading into MapLibre's context.
    for (const part of normalizeModel(scene()).parts) {
      expect(part.material.premultipliedAlpha).toBe(true);
    }
  });

  test("refuses a multi-material mesh rather than picking one", () => {
    const root = new THREE.Object3D();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    root.add(mesh);
    expect(() => normalizeModel(root)).toThrow(/not instanceable/);
  });

  test("refuses a model with no mesh in it", () => {
    expect(() => normalizeModel(new THREE.Object3D())).toThrow(/no mesh/);
  });
});

describe("the default source", () => {
  // The procedural source is the one that always works: no asset, no request,
  // no licence. Defaulting to "model" would make a first paint wait on 6 MB.
  test("is procedural, so nothing is fetched until it is asked for", () => {
    expect(DEFAULT_TREE_SETTINGS.meshSource).toBe("procedural");
  });
});
