import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { tileOfLngLat } from "../tiles";
import { frameTiles, lngLatBounds, projection, yawQuat, yUpToZUp, Y_UP_TO_Z_UP_ROTATE_X_DEG, type ExportFrame } from "./frame";

const FRAME: ExportFrame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2048 };

describe("the export frame", () => {
  const p = projection(FRAME);

  test("puts the centre at the origin, east at +x and north at +y", () => {
    expect(p.toLocal(121.5654, 25.033).map(Math.abs)).toEqual([0, 0]);
    const [ex, ey] = p.toLocal(121.5664, 25.033);
    expect(ex).toBeGreaterThan(0);
    expect(Math.abs(ey)).toBeLessThan(1e-6);
    const [nx, ny] = p.toLocal(121.5654, 25.034);
    expect(Math.abs(nx)).toBeLessThan(1e-6);
    expect(ny).toBeGreaterThan(0);
  });

  test("measures metres to well under 0.1% near the centre", () => {
    // 0.001° of longitude at 25.033° N is 100.8 m on the ground.
    const [x] = p.toLocal(121.5664, 25.033);
    expect(Math.abs(x - 100.79) / 100.79).toBeLessThan(0.001);
  });

  test("its corners are inside, and a point past the edge is not", () => {
    const [w, s, e, n] = lngLatBounds(FRAME);
    const sw = p.toLocal(w, s);
    const ne = p.toLocal(e, n);
    expect(sw[0]).toBeCloseTo(-1024, 6);
    expect(sw[1]).toBeCloseTo(-1024, 6);
    expect(ne[0]).toBeCloseTo(1024, 6);
    expect(ne[1]).toBeCloseTo(1024, 6);
    expect(p.inside(1024, -1024)).toBe(true);
    expect(p.inside(1024.01, 0)).toBe(false);
  });

  test("touches every z14 tile under its square, and only those", () => {
    const tiles = frameTiles(FRAME);
    const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
    const [w, s, e, n] = lngLatBounds(FRAME);
    for (const [lng, lat] of [[w, s], [e, n], [w, n], [e, s], [FRAME.centre.lng, FRAME.centre.lat]]) {
      const t = tileOfLngLat(lng, lat);
      expect(keys.has(`${t.x}/${t.y}`)).toBe(true);
    }
    // A 2 km square spans at most two z14 tiles (~2.2 km) each way.
    expect(tiles.length).toBeLessThanOrEqual(4);
  });
});

describe("the tree layer's frame", () => {
  test("a rotateX of 90° is (x, y, z) → (x, −z, y)", () => {
    const m = new THREE.Matrix4().makeRotationX((Y_UP_TO_Z_UP_ROTATE_X_DEG * Math.PI) / 180);
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -2, 5]] as [number, number, number][]) {
      const r = new THREE.Vector3(...v).applyMatrix4(m);
      const want = yUpToZUp(v);
      expect(r.x).toBeCloseTo(want[0], 12);
      expect(r.y).toBeCloseTo(want[1], 12);
      expect(r.z).toBeCloseTo(want[2], 12);
    }
  });

  test("a yaw about three's +y is the same yaw about +z here", () => {
    const toZUp = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    for (const theta of [0, 0.7, 2, 5.5]) {
      // A tree-frame yaw, carried into this frame…
      const yawY = new THREE.Matrix4().makeRotationY(theta);
      const carried = new THREE.Vector3(1, 0, 0).applyMatrix4(yawY).applyMatrix4(toZUp);
      // …equals the export's quaternion applied after the frame change.
      const [w, x, y, z] = yawQuat(theta);
      const q = new THREE.Quaternion(x, y, z, w);
      const exported = new THREE.Vector3(1, 0, 0).applyMatrix4(toZUp).applyQuaternion(q);
      expect(exported.distanceTo(carried)).toBeLessThan(1e-12);
    }
  });
});

test("the host's frame is the side it is given, centred on the point", async () => {
  const { exportFrame } = await import("./frame");
  expect(exportFrame(121.5, 25, 7500)).toEqual({ centre: { lng: 121.5, lat: 25 }, sizeM: 7500 });
  expect(() => exportFrame(121.5, 25, 0)).toThrow();
  expect(() => exportFrame(121.5, 25, NaN)).toThrow();
});
