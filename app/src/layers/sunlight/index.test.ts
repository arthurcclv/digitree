import { describe, expect, test } from "vitest";
import {
  DEFAULT_SUNLIGHT_SETTINGS,
  defaultSunTime,
  fromTaipei,
  SUNLIGHT_NATIVE_LAYER_ID,
  sunlightRecord,
  taipeiDate,
  taipeiMinutes,
} from "./index";
import * as THREE from "three";
import { canopyHullOf, rotationOf } from "../tree";
import { crownMatrix } from "./sunlightLayer";

describe("Taipei time", () => {
  test("round-trips a date and minute of day", () => {
    const ms = fromTaipei("2026-06-21", 9 * 60 + 15);
    expect(new Date(ms).toISOString()).toBe("2026-06-21T01:15:00.000Z");
    expect(taipeiDate(ms)).toBe("2026-06-21");
    expect(taipeiMinutes(ms)).toBe(555);
  });

  test("a late-evening UTC instant is already tomorrow in Taipei", () => {
    const ms = Date.parse("2026-06-21T20:00:00Z");
    expect(taipeiDate(ms)).toBe("2026-06-22");
    expect(taipeiMinutes(ms)).toBe(4 * 60);
  });

  test("the default is noon today, Taipei time", () => {
    const now = Date.parse("2026-09-24T17:30:00Z"); // 01:30 on the 25th in Taipei
    expect(new Date(defaultSunTime(now)).toISOString()).toBe("2026-09-25T04:00:00.000Z");
  });
});

describe("sunlightRecord", () => {
  test("is an external-native three.js record, off by default", () => {
    const r = sunlightRecord(DEFAULT_SUNLIGHT_SETTINGS);
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
    expect(sunlightRecord(DEFAULT_SUNLIGHT_SETTINGS, true).visible).toBe(true);
    expect(sunlightRecord({ ...DEFAULT_SUNLIGHT_SETTINGS, visible: true }).visible).toBe(true);
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
    const actual = crownMatrix(x, y, h, yaw);
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      const a = p.clone().applyMatrix4(actual);
      const b = p.clone().applyMatrix4(expected);
      expect(a.distanceTo(b)).toBeLessThan(1e-9);
    }
  });

  test("stands the hull up: the tree layer's +Y is up here", () => {
    const top = new THREE.Vector3(0, 1, 0).applyMatrix4(crownMatrix(10, 20, 8, 0.3));
    expect(top.x).toBeCloseTo(10, 9);
    expect(top.y).toBeCloseTo(20, 9);
    expect(top.z).toBeCloseTo(8, 9);
  });
});
