import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { frameAt, lngLatToMercator, metreInMercator, trueMetreAxes } from "../../lib/tiles";
import { SPLAT_REBASE_M } from "./constants";
import { axesOf, placeCapture, rebased, similarity, type Placed } from "./frame";

const TAIPEI: [number, number] = [121.5608, 25.0345];

/** `metres` east of a point, on the map's sphere. */
const eastOf = ([lng, lat]: [number, number], metres: number): [number, number] => [
  lng + (metres / (40_075_016.686 * Math.cos((lat * Math.PI) / 180))) * 360,
  lat,
];

/**
 * A local point through the whole placement, as the layer draws it: the mesh
 * matrix, then the stretch about the origin (`stretch.ts`, on the CPU).
 */
const whole = ({ matrix, origin, axes }: Placed, p: THREE.Vector3) => {
  const c = p.clone().applyMatrix4(matrix).sub(origin);
  return new THREE.Vector3(c.x * axes.east, c.y * axes.north, c.z).add(origin);
};

describe("similarity", () => {
  // Heading is the angle of the capture's +y, clockwise from north, which is
  // what infra's solve stores. The file is drawn as stored, z-up. Local frame:
  // x east, y north, z up.
  test.each([
    [0, [0, 1]],
    [90, [1, 0]],
    [180, [0, -1]],
    [30, [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)]],
  ])("turns local +y to heading %d°", (heading, [east, north]) => {
    const v = new THREE.Vector3(0, 1, 0).applyMatrix4(similarity({ headingDeg: heading, scale: 1 }));
    expect(v.x).toBeCloseTo(east, 12);
    expect(v.y).toBeCloseTo(north, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });

  test("scales uniformly and keeps up as up", () => {
    const m = similarity({ headingDeg: 47, scale: 1.2 });
    const up = new THREE.Vector3(0, 0, 5).applyMatrix4(m);
    expect(up.toArray().map((v) => +v.toFixed(12))).toEqual([0, 0, 6]);
    expect(new THREE.Vector3(3, 4, 0).applyMatrix4(m).length()).toBeCloseTo(6, 12);
  });

  test("is a proper rotation, never a mirror", () => {
    expect(similarity({ headingDeg: 200, scale: 1.05 }).determinant()).toBeGreaterThan(0);
  });
});

describe("axesOf", () => {
  test("is the capture's own latitude's true-metre axes", () => {
    expect(axesOf({ lngLat: [0, 60] })).toEqual(trueMetreAxes(60));
  });

  test("stretches by no more than the ellipsoid does, here", () => {
    const { east, north } = axesOf({ lngLat: TAIPEI });
    expect(Math.abs(east - 1)).toBeLessThan(0.002);
    expect(Math.abs(north - 1)).toBeLessThan(0.004);
  });
});

describe("placeCapture", () => {
  const capture = (over: Partial<{ lngLat: [number, number]; altitudeM: number; headingDeg: number; scale: number }> = {}) => ({
    lngLat: TAIPEI,
    altitudeM: 0,
    headingDeg: 0,
    scale: 1,
    ...over,
  });

  // The map's metres per true metre, at the capture's own latitude.
  test("draws local +x at east·scale and +y at north·scale, at heading 0", () => {
    const { east, north } = trueMetreAxes(TAIPEI[1]);
    const placed = placeCapture(capture({ scale: 1.02 }), frameAt(...TAIPEI));
    const x = whole(placed, new THREE.Vector3(1, 0, 0));
    const y = whole(placed, new THREE.Vector3(0, 1, 0));
    expect(x.x).toBeCloseTo(east * 1.02, 12);
    expect(x.y).toBeCloseTo(0, 12);
    expect(y.x).toBeCloseTo(0, 12);
    expect(y.y).toBeCloseTo(north * 1.02, 12);
  });

  test("is translation · k · diag(east, north, 1) · similarity, with up not stretched", () => {
    const at: [number, number] = [TAIPEI[0] + 0.01, TAIPEI[1] + 0.03];
    const s = capture({ lngLat: at, altitudeM: 4, headingDeg: 130, scale: 1.02 });
    const anchor = frameAt(...TAIPEI);
    const placed = placeCapture(s, anchor);
    const k = metreInMercator(at[1]) / anchor.metre;
    const { east, north } = trueMetreAxes(at[1]);
    const want = new THREE.Matrix4()
      .makeTranslation(placed.origin)
      .multiply(new THREE.Matrix4().makeScale(k, k, k))
      .multiply(new THREE.Matrix4().makeScale(east, north, 1))
      .multiply(similarity(s));
    for (const p of [new THREE.Vector3(10, -20, 3), new THREE.Vector3(-150, 80, 0), new THREE.Vector3(0, 0, 5)]) {
      const got = whole(placed, p);
      const exp = p.clone().applyMatrix4(want);
      expect(got.distanceTo(exp)).toBeLessThan(1e-9);
    }
    const up = whole(placed, new THREE.Vector3(0, 0, 5)).sub(placed.origin);
    expect(up.z).toBeCloseTo(5 * 1.02 * k, 12);
  });

  test("puts the origin at the capture's Mercator offset from the anchor, north up", () => {
    const at: [number, number] = [TAIPEI[0] + 0.002, TAIPEI[1] + 0.001];
    const anchor = frameAt(...TAIPEI);
    const { matrix, origin } = placeCapture(capture({ lngLat: at, altitudeM: 7 }), anchor);
    const m = lngLatToMercator(...at);
    expect(origin.x).toBeCloseTo((m.x - anchor.origin.x) / anchor.metre, 9);
    expect(origin.y).toBeCloseTo((anchor.origin.y - m.y) / anchor.metre, 9);
    expect(origin.x).toBeGreaterThan(0);
    expect(origin.y).toBeGreaterThan(0);
    expect(origin.z).toBeCloseTo((7 * metreInMercator(at[1])) / anchor.metre, 12);
    // The mesh's translation is the origin: the stretch is about it.
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual(origin.toArray());
  });

  test("leaves the origin fixed under the stretch", () => {
    const placed = placeCapture(capture({ lngLat: eastOf(TAIPEI, 900), headingDeg: 40 }), frameAt(...TAIPEI));
    expect(whole(placed, new THREE.Vector3()).distanceTo(placed.origin)).toBeLessThan(1e-12);
  });

  test("keeps a capture its own size in metres, whatever the anchor", () => {
    // 100 local metres east, from two anchors 20 km apart on a north–south line.
    const s = capture({ lngLat: TAIPEI });
    const span = (lat: number) => {
      const placed = placeCapture(s, frameAt(TAIPEI[0], lat));
      const metresPerFrameUnit = metreInMercator(lat) / metreInMercator(TAIPEI[1]);
      return (whole(placed, new THREE.Vector3(100, 0, 0)).x - placed.origin.x) * metresPerFrameUnit;
    };
    expect(span(TAIPEI[1])).toBeCloseTo(span(TAIPEI[1] + 0.18), 9);
  });

  test("is a proper transform, never a mirror, at any heading", () => {
    for (const headingDeg of [0, 45, 200, 359]) {
      expect(placeCapture(capture({ headingDeg, scale: 1.05 }), frameAt(...TAIPEI)).matrix.determinant()).toBeGreaterThan(0);
    }
  });
});

describe("rebased", () => {
  const anchor = frameAt(...TAIPEI);

  test("stays within SPLAT_REBASE_M", () => {
    expect(rebased(anchor, ...eastOf(TAIPEI, SPLAT_REBASE_M - 100))).toBeNull();
  });

  test("moves to the frame at the centre past it", () => {
    const centre = eastOf(TAIPEI, SPLAT_REBASE_M + 100);
    expect(rebased(anchor, ...centre)).toEqual(frameAt(...centre));
  });
});
