import { describe, expect, test } from "vitest";
import { frameAt, localToMercator, mercatorToLocal, planTiles, toLocal } from "./frame";
import { lngLatToMercator, metreInMercator, TILE_ZOOM, tileKey, tileOfLngLat } from "./grid";

const centre: [number, number] = [121.5608, 25.0345];
const frame = frameAt(...centre);

/** Metres per degree on the map's sphere. */
const M_PER_DEG = (6_371_008.8 * Math.PI) / 180;

/** A lng/lat `dx`, `dy` metres east and north of the centre, on the map's sphere. */
const offset = (dx: number, dy: number): [number, number] => [
  centre[0] + dx / (M_PER_DEG * Math.cos((centre[1] * Math.PI) / 180)),
  centre[1] + dy / M_PER_DEG,
];

describe("LocalFrame", () => {
  test("is at its lng/lat, with that latitude's metre", () => {
    expect(frame).toEqual({ origin: lngLatToMercator(...centre), metre: metreInMercator(centre[1]) });
  });

  test("puts its own origin at (0, 0)", () => {
    const [x, y] = toLocal(frame, ...centre);
    expect(Math.abs(x) + Math.abs(y)).toBe(0);
  });

  // Mercator y grows south; the local frame's y grows north.
  test("has x east and y north", () => {
    const [x, y] = toLocal(frame, ...offset(300, 200));
    expect(x).toBeCloseTo(300, 0);
    expect(y).toBeCloseTo(200, 0);
    const [, south] = toLocal(frame, ...offset(0, -200));
    expect(south).toBeLessThan(0);
  });

  test("measures in the frame's metres", () => {
    const p = { x: frame.origin.x + 7 * frame.metre, y: frame.origin.y - 11 * frame.metre };
    const [x, y] = mercatorToLocal(frame, p);
    expect(x).toBeCloseTo(7, 6);
    expect(y).toBeCloseTo(11, 6);
  });

  test("round-trips through Mercator", () => {
    for (const [x, y] of [[0, 0], [123.4, -567.8], [-2048, 2048]]) {
      const [bx, by] = mercatorToLocal(frame, localToMercator(frame, x, y));
      expect(bx).toBeCloseTo(x, 6);
      expect(by).toBeCloseTo(y, 6);
    }
  });
});

describe("planTiles", () => {
  test("covers the footprint's tiles plus one ring, and only those", () => {
    const footprint = [offset(-300, -300), offset(300, -300), offset(300, 300), offset(-300, 300)];
    const tiles = planTiles(frame, footprint, 4096);
    expect(tiles.every((t) => t.z === TILE_ZOOM)).toBe(true);
    const keys = new Set(tiles.map(tileKey));
    const inner = footprint.map(([lng, lat]) => tileOfLngLat(lng, lat));
    for (const t of inner) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) expect(keys.has(tileKey({ ...t, x: t.x + dx, y: t.y + dy }))).toBe(true);
      }
    }
    const xs = inner.map((t) => t.x);
    const ys = inner.map((t) => t.y);
    const w = Math.max(...xs) - Math.min(...xs) + 3;
    const h = Math.max(...ys) - Math.min(...ys) + 3;
    expect(tiles).toHaveLength(w * h);
  });

  test("clips a far corner to the half-width", () => {
    const halfM = 4096;
    const far = [offset(-200, -200), offset(200, -200), offset(40_000, 60_000), offset(-40_000, 60_000)];
    const tiles = planTiles(frame, far, halfM);
    const limit = tileOfLngLat(...offset(halfM, halfM));
    const low = tileOfLngLat(...offset(-halfM, halfM));
    for (const t of tiles) {
      expect(t.x).toBeLessThanOrEqual(limit.x + 1);
      expect(t.x).toBeGreaterThanOrEqual(low.x - 1);
      expect(t.y).toBeGreaterThanOrEqual(limit.y - 1);
    }
  });

  test("clips a footprint reaching to the horizon", () => {
    const footprint: [number, number][] = [offset(-100, -100), offset(100, -100), [122.5, 26], [120.5, 26]];
    // ±2 km is under two z14 tiles each way, plus the ring.
    expect(planTiles(frame, footprint, 2048).length).toBeLessThanOrEqual(7 * 7);
  });

  test("plans nothing without ground in view", () => {
    expect(planTiles(frame, [offset(0, 0), offset(10, 0)], 4096)).toEqual([]);
  });
});
