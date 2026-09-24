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
import { addPrism, crownMatrix } from "./sunlightLayer";

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
});

describe("addPrism", () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  test("floors cover the footprint once, and the prism is closed", () => {
    const prism: number[] = [];
    const floor: number[] = [];
    addPrism([square], 20, prism, floor);
    // Two floor triangles; floor + roof + 4 walls × 2 in the prism.
    expect(floor.length / 9).toBe(2);
    expect(prism.length / 9).toBe(2 + 2 + 8);
    const area = (tris: number[]) => {
      let a = 0;
      for (let i = 0; i < tris.length; i += 9) {
        const [x1, y1, , x2, y2, , x3, y3] = tris.slice(i, i + 9);
        a += Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2;
      }
      return a;
    };
    expect(area(floor)).toBeCloseTo(100, 9);
    // Every z is the ground or the roof.
    for (let i = 2; i < prism.length; i += 3) expect([0, 20]).toContain(prism[i]);
  });

  test("a hole is left out of the floor", () => {
    const hole: [number, number][] = [
      [3, 3],
      [3, 7],
      [7, 7],
      [7, 3],
    ];
    const floor: number[] = [];
    addPrism([square, hole], 5, [], floor);
    let a = 0;
    for (let i = 0; i < floor.length; i += 9) {
      const [x1, y1, , x2, y2, , x3, y3] = floor.slice(i, i + 9);
      a += Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2;
    }
    expect(a).toBeCloseTo(100 - 16, 9);
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
