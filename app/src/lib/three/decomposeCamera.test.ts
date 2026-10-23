import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { decomposeCamera, mercatorFrame } from "./index";
import fixtures from "./mainMatrix.fixtures.json";

// See `specs/spec.md`, *`decomposeCamera`*, and its invariants 9 and 10.

/** max |P·V − s·C| / max |s·C|, with s the positive scale that matches w rows. */
function roundTrip(input: THREE.Matrix4): number {
  const { projection, view } = decomposeCamera(input);
  const pv = projection.clone().multiply(view).elements;
  const e = input.elements;
  const s = 1 / Math.hypot(e[3], e[7], e[11]);
  let err = 0;
  let size = 0;
  for (let i = 0; i < 16; i++) {
    err = Math.max(err, Math.abs(pv[i] - s * e[i]));
    size = Math.max(size, Math.abs(s * e[i]));
  }
  return err / size;
}

/** An off-centre perspective times a rigid view, both known. */
function synthetic(cx = 0, cy = 0) {
  const projection = new THREE.Matrix4().makePerspective(-1 + cx, 1 + cx, 0.6 + cy, -0.6 + cy, 0.5, 5000);
  const view = new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(0.9, -0.3, 2.1))
    .setPosition(120, -40, 300);
  return { projection, view, clip: projection.clone().multiply(view) };
}

describe("decomposeCamera", () => {
  test("recovers a known perspective and view", () => {
    const { projection, view, clip } = synthetic();
    const got = decomposeCamera(clip);
    // makePerspective puts −1 in the w row already, so the scale is 1.
    got.projection.elements.forEach((v, i) => expect(v).toBeCloseTo(projection.elements[i], 9));
    got.view.elements.forEach((v, i) => expect(v).toBeCloseTo(view.elements[i], 9));
  });

  test("keeps an off-centre principal point in the projection", () => {
    const { clip } = synthetic(0.3, -0.15);
    const { projection, view } = decomposeCamera(clip);
    expect(roundTrip(clip)).toBeLessThan(1e-12);
    expect(new THREE.Matrix3().setFromMatrix4(view).determinant()).toBeCloseTo(1, 12);
    expect(projection.elements[8]).toBeCloseTo(0.3, 12); // P[0][2]
  });

  test("survives a positive homogeneous scale, and puts exactly (0, 0, −1, 0) in w", () => {
    const { clip } = synthetic();
    const { projection } = decomposeCamera(clip.clone().multiplyScalar(3.7e8));
    expect([projection.elements[3], projection.elements[7], projection.elements[11], projection.elements[15]]).toEqual([
      0, 0, -1, 0,
    ]);
  });

  test("throws on a reflection", () => {
    const { clip } = synthetic();
    expect(() => decomposeCamera(clip.multiply(new THREE.Matrix4().makeScale(1, -1, 1)))).toThrow(/reflection/);
  });

  test("throws on a depth row that is not a perspective depth", () => {
    const { clip } = synthetic();
    clip.elements[2] += 0.5; // z row, x column
    expect(() => decomposeCamera(clip)).toThrow(/depth row/);
  });

  test("throws on a non-finite or orthographic input", () => {
    expect(() => decomposeCamera(new THREE.Matrix4().set(NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1))).toThrow(
      /not finite/,
    );
    expect(() => decomposeCamera(new THREE.Matrix4().makeOrthographic(-1, 1, 1, -1, 0.1, 10))).toThrow(/w row/);
  });

  // MapLibre's own matrices, at every pitch, several bearings, and with panel
  // padding, each times the frame the splat layer uses.
  test.each(fixtures.captures.map((c) => [`pitch ${c.view.pitch} bearing ${c.view.bearing} pad ${c.view.padding.left}/${c.view.padding.top}`, c] as const))(
    "decomposes MapLibre's mainMatrix: %s",
    (_, c) => {
      const clip = new THREE.Matrix4()
        .fromArray(c.mainMatrix)
        .multiply(mercatorFrame({ x: c.origin[0], y: c.origin[1] }, c.metre));
      expect(roundTrip(clip)).toBeLessThan(1e-12);
      const { view } = decomposeCamera(clip);
      expect(new THREE.Matrix3().setFromMatrix4(view).determinant()).toBeCloseTo(1, 12);
    },
  );
});
