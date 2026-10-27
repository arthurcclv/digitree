import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { usda, yawQuat, type ExportFrame } from "../../lib/usd";
import { buildForm } from "./formGeometry";
import { formOf, type TreeForm } from "./forms";
import { rotationOf } from "./placement";
import type { TreeFeature } from "./schema";
import { geometryMesh, modelPrototypes, proceduralPrototypes, treeInstances, treesPackage, type Prototype } from "./usd";

const FRAME: ExportFrame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2048 };
const tree = (id: string, over: Partial<TreeFeature> = {}): TreeFeature => ({
  id,
  lng: 121.5654,
  lat: 25.033,
  heightM: 12,
  canopyWidthM: null,
  kind: "street",
  species: "榕樹",
  district: null,
  place: null,
  placeNote: null,
  diameterCm: null,
  surveyDate: null,
  ...over,
});

describe("treeInstances", () => {
  test("filters by kind as the meshes do, keeps each id once, and sorts by id", () => {
    const got = treeInstances(
      [tree("b"), tree("a", { kind: "park" }), tree("b", { lng: 121.566 }), tree("c")],
      "street",
      FRAME,
      9.1,
    );
    expect(got.map((t) => t.id)).toEqual(["b", "c"]);
    // The first "b" wins.
    expect(Math.abs(got[0].x)).toBeLessThan(1e-6);
    expect(treeInstances([tree("a", { kind: "park" }), tree("b")], "all", FRAME, 9.1)).toHaveLength(2);
  });

  test("uses the source's fallback for a missing height, and nothing else", () => {
    const [t] = treeInstances([tree("a", { heightM: null })], "all", FRAME, 9.1);
    expect(t.heightM).toBe(9.1);
  });

  test("keeps only trees inside the frame, placed in its metres", () => {
    const got = treeInstances([tree("in", { lng: 121.566 }), tree("out", { lng: 121.6 })], "all", FRAME, 9.1);
    expect(got.map((t) => t.id)).toEqual(["in"]);
    expect(got[0].x).toBeGreaterThan(0);
  });

  test("reads the form from the species, and a non-string species as empty", () => {
    const [a, b] = treeInstances([tree("a"), tree("b", { species: 7 })], "all", FRAME, 9.1);
    expect(a.form).toBe(formOf("榕樹"));
    expect(a.species).toBe("榕樹");
    expect(b.species).toBe("");
    expect(b.form).toBe("generic");
  });
});

/** The first entry of a stored zip: the package's root layer. */
async function rootText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const v = new DataView(bytes.buffer);
  const size = v.getUint32(18, true);
  const start = 30 + v.getUint16(26, true) + v.getUint16(28, true);
  return new TextDecoder().decode(bytes.subarray(start, start + size));
}

/** The values of one array attribute, as numbers. */
const numbersOf = (text: string, name: string) => {
  const m = text.match(new RegExp(`${name.replace(/[[\]]/g, "\\$&")} = \\[([^\\]]*)\\]`));
  return m![1].replace(/[()]/g, "").split(",").map(Number);
};

describe("the package", () => {
  test("places each tree with its yaw, its scale and its form's prototype", async () => {
    const trees = treeInstances([tree("t1"), tree("t2", { species: 7, heightM: 6, lng: 121.566 })], "all", FRAME, 9.1);
    const forms = new Set(trees.map((t) => t.form));
    const text = await rootText((await treesPackage(trees, proceduralPrototypes(forms), { heightScale: 2 }, FRAME, ["© trees"])).usdz);

    const sorted = [...forms].sort();
    expect(numbersOf(text, "int[] protoIndices")).toEqual(trees.map((t) => sorted.indexOf(t.form)));
    const scales = numbersOf(text, "float3[] scales");
    trees.forEach((t, i) => {
      // Unmeasured: the form's proportions at true height, the vertical exaggerated.
      const built = buildForm(t.form);
      expect(scales[i * 3]).toBeCloseTo(t.heightM / built.baseHeightM, 5);
      expect(scales[i * 3 + 1]).toBeCloseTo(t.heightM / built.baseHeightM, 5);
      expect(scales[i * 3 + 2]).toBeCloseTo((t.heightM * 2) / built.baseHeightM, 5);
    });
    const q = numbersOf(text, "quath[] orientations");
    trees.forEach((t, i) => {
      const want = yawQuat(rotationOf(t.id));
      for (let k = 0; k < 4; k++) expect(q[i * 4 + k]).toBeCloseTo(want[k], 5);
    });
    expect(text).toContain('string[] primvars:treeId = ["t1", "t2"]');
    expect(text).toContain('rotateX = 90');
    expect(text).toContain(`<\/Trees\/Instances\/Prototypes\/${usda.identifier(sorted[0])}>`);
    expect(text).toContain('string[] attribution = ["© trees"]');
  });

  test("scales a surveyed canopy width on x and y, and the height on z", async () => {
    const trees = treeInstances([tree("w", { canopyWidthM: 20, heightM: 9 })], "all", FRAME, 9.1);
    expect(trees[0].widthM).toBe(20);
    const text = await rootText(
      (await treesPackage(trees, proceduralPrototypes([trees[0].form]), { heightScale: 1.5 }, FRAME, [])).usdz,
    );
    const built = buildForm(trees[0].form);
    const [x, y, z] = numbersOf(text, "float3[] scales");
    expect(x).toBeCloseTo(20 / built.baseWidthM, 5);
    expect(y).toBeCloseTo(20 / built.baseWidthM, 5);
    expect(z).toBeCloseTo((9 * 1.5) / built.baseHeightM, 5);
  });

  test("keeps a model's texture as PNG, its alpha mask and its double side", async () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 0.25], 2));
    const map = new THREE.Texture({ width: 2, height: 2 });
    const material = new THREE.MeshStandardMaterial({ map, alphaTest: 0.4, side: THREE.DoubleSide });
    const proto: Prototype = { parts: [{ geometry, material }], baseHeightM: 1, baseWidthM: 1 };
    const trees = treeInstances([tree("a")], "all", FRAME, 9.1);
    const encoded: THREE.Texture[] = [];
    const pkg = await treesPackage(trees, new Map([[trees[0].form, proto]]), { heightScale: 1 }, FRAME, [], async (t) => {
      encoded.push(t);
      return new Uint8Array([1, 2, 3]);
    });
    const text = await rootText(pkg.usdz);
    expect(encoded).toEqual([map]);
    expect(text).toMatch(/asset inputs:file = @textures\/\w+\.png@/);
    expect(text).toContain("float inputs:opacityThreshold = 0.4");
    expect(text).toContain("uniform bool doubleSided = 1");
    const packaged = new TextDecoder().decode(new Uint8Array(await pkg.usdz.arrayBuffer()));
    expect(packaged).toMatch(/textures\/\w+\.png/);
  });
});

test("glTF uv becomes st with v flipped", () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0.25, 0.5, 1], 2));
  const m = geometryMesh(g);
  expect(m.st).toEqual([0, 1, 1, 0.75, 0.5, 0]);
  expect(m.faceVertexIndices).toEqual([0, 1, 2]);
  expect(m.faceVertexCounts).toEqual([3]);
});

describe("the prototypes", () => {
  test("procedural: one per form, buildForm's bark and canopy with the two named materials", () => {
    const forms: TreeForm[] = ["spreading", "upright"];
    const protos = proceduralPrototypes(forms);
    expect([...protos.keys()]).toEqual([...forms]);
    for (const form of forms) {
      const p = protos.get(form)!;
      const built = buildForm(form);
      expect(p.baseHeightM).toBe(built.baseHeightM);
      expect(p.baseWidthM).toBe(built.baseWidthM);
      expect(p.parts.map((part) => part.material.name)).toEqual(["Bark", "Canopy"]);
      expect(p.parts[0].geometry.getAttribute("position").count).toBe(built.bark.getAttribute("position").count);
      expect(p.parts[1].geometry.getAttribute("position").count).toBe(built.canopy.getAttribute("position").count);
    }
  });

  test("procedural: written as one Y-up Xform per form, turned Z-up, holding its meshes", async () => {
    const trees = treeInstances([tree("a")], "all", FRAME, 9.1);
    const form = trees[0].form;
    const text = await rootText((await treesPackage(trees, proceduralPrototypes([form]), { heightScale: 1 }, FRAME, [])).usdz);
    expect(text).toContain(`def Xform "${usda.identifier(form)}"`);
    expect(text).toContain("rotateX = 90");
    expect(text.match(/def Mesh "/g)?.length).toBe(2);
    expect(text).toContain("Looks/Bark");
    expect(text).toContain("Looks/Canopy");
  });

  test("a model that fails to load rejects the export with failed", async () => {
    const load = async () => {
      throw new Error("404");
    };
    await expect(modelPrototypes(["upright"], load)).rejects.toMatchObject({ reason: "failed", layer: "trees" });
    await expect(modelPrototypes(["upright"], load)).rejects.toThrow(/upright.*404/);
  });
});
