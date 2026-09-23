import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { buildForm, buildMaterials, TREE_FORMS, type FormGeometry } from "./formGeometry";
import type { TreeForm } from "./forms";

function box(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

/** The widest horizontal span of the canopy, in metres. */
function spread(form: FormGeometry): number {
  const b = box(form.canopy);
  return Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
}

/** Widest horizontal span of the canopy between two heights. */
function spreadBetween(form: FormGeometry, low: number, high: number): number {
  const pos = form.canopy.getAttribute("position");
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < low || y > high) continue;
    minX = Math.min(minX, pos.getX(i));
    maxX = Math.max(maxX, pos.getX(i));
  }
  return maxX - minX;
}

/**
 * Empty horizontal bands of at least `least` metres inside the canopy.
 *
 * Measured over triangle spans, not vertex heights: a solid crown has few
 * vertices at any given height but its triangles still cover every height
 * between them, and only a real hole separates one span from the next.
 */
function gaps(form: FormGeometry, least: number): number {
  const pos = form.canopy.getAttribute("position");
  const spans: [number, number][] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const ys = [pos.getY(i), pos.getY(i + 1), pos.getY(i + 2)];
    spans.push([Math.min(...ys), Math.max(...ys)]);
  }
  spans.sort((a, b) => a[0] - b[0]);

  let bands = 0;
  let reach = spans[0][1];
  for (const [low, high] of spans) {
    if (low - reach >= least) bands++;
    reach = Math.max(reach, high);
  }
  return bands;
}

const built = new Map<TreeForm, FormGeometry>(TREE_FORMS.map((f) => [f, buildForm(f)]));
const get = (form: TreeForm): FormGeometry => built.get(form)!;

describe("buildForm", () => {
  test("covers exactly the eight forms the spec defines", () => {
    expect([...TREE_FORMS].sort()).toEqual(
      [
        "columnar",
        "conic",
        "generic",
        "palm-fan",
        "palm-feather",
        "spreading",
        "tiered",
        "upright",
      ].sort(),
    );
  });

  test.each(TREE_FORMS)("%s builds bark and canopy", (form) => {
    const geometry = get(form);
    expect(geometry.bark.getAttribute("position").count).toBeGreaterThan(0);
    expect(geometry.canopy.getAttribute("position").count).toBeGreaterThan(0);
  });

  test.each(TREE_FORMS)("%s stands on the origin", (form) => {
    // Instances are placed at ground level, so a shape whose base is not at
    // y = 0 would float or sink by that amount at every scale.
    expect(box(get(form).bark).min.y).toBeCloseTo(0, 2);
  });

  test.each(TREE_FORMS)("%s measures its own base height", (form) => {
    // The claim in FormGeometry: the height is taken from the geometry, never
    // written by hand, so the two cannot drift the way TREE_BASE_HEIGHT_M did.
    const geometry = get(form);
    const top = Math.max(box(geometry.bark).max.y, box(geometry.canopy).max.y);
    expect(geometry.baseHeightM).toBeCloseTo(top, 6);
    expect(geometry.baseHeightM).toBeGreaterThan(0);
  });

  test.each(TREE_FORMS)("%s is deterministic", (form) => {
    // Invariant 5: same form, same shape, every reload. No Math.random anywhere.
    const a = buildForm(form).canopy.getAttribute("position").array;
    const b = buildForm(form).canopy.getAttribute("position").array;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

/**
 * A form class is a promise about a silhouette. These assert the promise the
 * spec's table makes for each one, so a builder cannot quietly stop keeping it.
 */
describe("silhouettes", () => {
  test("spreading is wider than it is tall", () => {
    const form = get("spreading");
    expect(spread(form)).toBeGreaterThan(form.baseHeightM);
  });

  test("upright is taller than it is wide", () => {
    const form = get("upright");
    expect(spread(form)).toBeLessThan(form.baseHeightM);
  });

  test("columnar is narrow and carries foliage down the trunk", () => {
    const form = get("columnar");
    expect(spread(form)).toBeLessThan(form.baseHeightM * 0.35);
    // "Foliage to the ground": the canopy starts low, unlike every other form.
    expect(box(form.canopy).min.y).toBeLessThan(form.baseHeightM * 0.2);
  });

  test("conic tapers from bottom to top", () => {
    const form = get("conic");
    const b = box(form.canopy);
    const third = (b.max.y - b.min.y) / 3;
    expect(spreadBetween(form, b.min.y, b.min.y + third)).toBeGreaterThan(
      spreadBetween(form, b.max.y - third, b.max.y),
    );
  });

  test("tiered leaves daylight between its layers", () => {
    // The gaps are what the class is for; a solid crown would be `upright`.
    expect(gaps(get("tiered"), 0.3)).toBeGreaterThanOrEqual(2);
    expect(gaps(get("upright"), 0.3)).toBe(0);
  });

  test.each(["palm-feather", "palm-fan"] as const)("%s has a bare trunk", (form) => {
    const geometry = get(form);
    expect(box(geometry.canopy).min.y).toBeGreaterThan(geometry.baseHeightM * 0.65);
  });
});

describe("buildMaterials", () => {
  test("returns the two the paint bridge iterates", () => {
    // Shared by all sixteen meshes: setOpacity must keep iterating two however
    // many forms exist, or GeoLibre's paint bridge stops covering the layer.
    const materials = buildMaterials();
    expect(materials).toHaveLength(2);
    for (const material of materials) {
      // MapLibre blends with ONE, ONE_MINUS_SRC_ALPHA and expects premultiplied
      // colours; without this the meshes wash out at partial opacity.
      expect(material.premultipliedAlpha).toBe(true);
      expect(material.flatShading).toBe(true);
    }
  });
});
