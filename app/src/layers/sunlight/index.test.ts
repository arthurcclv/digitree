import { describe, expect, test } from "vitest";
import { DEFAULT_SUNLIGHT_SETTINGS, SUNLIGHT_NATIVE_LAYER_ID, sunlightRecord } from "./index";
import * as THREE from "three";
import { canopyHullBaseOf, canopyHullOf, crownScale, rotationOf } from "../tree";
import { crownMatrix } from "./sunlightLayer";

/** Any moment will do: the record does not read it. */
const SETTINGS = { ...DEFAULT_SUNLIGHT_SETTINGS, sunTime: Date.parse("2026-06-21T04:00:00Z") };

describe("DEFAULT_SUNLIGHT_SETTINGS", () => {
  // The moment is the host's: which noon is "today" depends on where it is.
  test("carries no moment", () => {
    expect("sunTime" in DEFAULT_SUNLIGHT_SETTINGS).toBe(false);
  });
});

describe("sunlightRecord", () => {
  test("is an external-native three.js record, off by default", () => {
    const r = sunlightRecord(SETTINGS);
    expect(r.visible).toBe(false);
    expect(r.metadata).toMatchObject({
      customLayerType: "threejs",
      nativeLayerIds: [SUNLIGHT_NATIVE_LAYER_ID],
      paintMode: "plugin",
    });
    expect(r.source).toEqual({});
  });

  test("stays visible to MapLibre while a dependent demands the index", () => {
    // MapLibre runs no prerender for a hidden layer, and the light pass is there.
    expect(sunlightRecord(SETTINGS, true).visible).toBe(true);
    expect(sunlightRecord({ ...SETTINGS, visible: true }).visible).toBe(true);
  });
});

describe("crownMatrix", () => {
  test("places a hull exactly where the tree layer places the tree", () => {
    // The tree layer: x east, y up, z south; compose(position, yaw about +Y, scale).
    const [x, y, h] = [123.4, -56.7, 11.5];
    const yaw = rotationOf("BT0614021096");
    const treeLayer = new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, -y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      new THREE.Vector3(h, h, h),
    );
    // …then into this layer's east-north-up frame.
    const expected = new THREE.Matrix4().makeRotationX(Math.PI / 2).multiply(treeLayer);
    const pos = canopyHullOf("spreading").getAttribute("position");
    const actual = crownMatrix(x, y, { xz: h, y: h }, yaw);
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      const a = p.clone().applyMatrix4(actual);
      const b = p.clone().applyMatrix4(expected);
      expect(a.distanceTo(b)).toBeLessThan(1e-9);
    }
  });

  test("stands the hull up: the tree layer's +Y is up here", () => {
    const top = new THREE.Vector3(0, 1, 0).applyMatrix4(crownMatrix(10, 20, { xz: 8, y: 8 }, 0.3));
    expect(top.x).toBeCloseTo(10, 9);
    expect(top.y).toBeCloseTo(20, 9);
    expect(top.z).toBeCloseTo(8, 9);
  });

  test("scales the vertical and the horizontal apart", () => {
    // A point one unit out along the hull's x and one unit up.
    const m = crownMatrix(0, 0, { xz: 3, y: 8 }, 0);
    const side = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    const top = new THREE.Vector3(0, 1, 0).applyMatrix4(m);
    expect(side.length()).toBeCloseTo(3, 9);
    expect(top.z).toBeCloseTo(8, 9);
  });

  test("a surveyed canopy width sizes the shadow's crown to that width", () => {
    // What placeCrowns does: crownScale over the hull's own base, at true scale.
    const base = canopyHullBaseOf("spreading");
    const m = crownMatrix(0, 0, crownScale(base, { heightM: 9, widthM: 20 }, 1), rotationOf("T1"));
    const pos = canopyHullOf("spreading").getAttribute("position");
    let r = 0;
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m);
      r = Math.max(r, Math.hypot(p.x, p.y));
    }
    expect(2 * r).toBeCloseTo(20, 6);
  });
});
