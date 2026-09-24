import { describe, expect, test } from "vitest";
import { lngLatToMercator, metreInMercator, tileKey, tileOfLngLat, triangulateTile, type TileId } from "../../lib/tiles";
import { AO_FETCH_HALF_M, placeAoPrisms, planAoTiles } from "./geometry";

const centre: [number, number] = [121.5608, 25.0345];
const frame = { origin: lngLatToMercator(...centre), metre: metreInMercator(centre[1]) };

/** A lng/lat `dx`, `dy` metres east and north of the centre. */
const offset = (dx: number, dy: number): [number, number] => {
  const lng = centre[0] + (dx / (111_320 * Math.cos((centre[1] * Math.PI) / 180)));
  const lat = centre[1] + dy / 110_574;
  return [lng, lat];
};

describe("planAoTiles", () => {
  test("covers the footprint's tiles plus one ring", () => {
    const footprint = [offset(-300, -300), offset(300, -300), offset(300, 300), offset(-300, 300)];
    const tiles = planAoTiles(frame, footprint);
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

  test("clips a far corner to the fetch half-width", () => {
    const far = [offset(-200, -200), offset(200, -200), offset(40_000, 60_000), offset(-40_000, 60_000)];
    const tiles = planAoTiles(frame, far);
    const limit = tileOfLngLat(...offset(AO_FETCH_HALF_M, AO_FETCH_HALF_M));
    const low = tileOfLngLat(...offset(-AO_FETCH_HALF_M, AO_FETCH_HALF_M));
    for (const t of tiles) {
      expect(t.x).toBeLessThanOrEqual(limit.x + 1);
      expect(t.x).toBeGreaterThanOrEqual(low.x - 1);
      expect(t.y).toBeGreaterThanOrEqual(limit.y - 1);
    }
  });

  test("no ground in view plans nothing", () => {
    expect(planAoTiles(frame, [offset(0, 0), offset(10, 0)])).toEqual([]);
  });
});

describe("placeAoPrisms", () => {
  const tile: TileId = tileOfLngLat(...centre);
  const square = (dx: number, dy: number, s: number) => [
    [offset(dx, dy), offset(dx + s, dy), offset(dx + s, dy + s), offset(dx, dy + s), offset(dx, dy)],
  ];
  const prisms = triangulateTile(tile, [
    { heightM: 10, polygons: [square(0, 0, 20)] },
    { heightM: 50, polygons: [square(50, 0, 20)] },
  ]);
  const parts = [{ tile, prisms }];
  const zs = (p: Float32Array) => new Set(Array.from(p.filter((_, i) => i % 3 === 2)));

  test("puts each roof at render_height × heightScale", () => {
    const { positions, buildings } = placeAoPrisms(frame, parts, 2, 0);
    expect(buildings).toBe(2);
    expect(zs(positions)).toEqual(new Set([0, 20, 100]));
  });

  test("drops buildings below minHeight, reading true height", () => {
    // 10 m × 4 = 40 m drawn, but 10 m real: still below a 30 m minimum.
    const { positions, buildings } = placeAoPrisms(frame, parts, 4, 30);
    expect(buildings).toBe(1);
    expect(zs(positions)).toEqual(new Set([0, 200]));
  });

  test("places the prisms in the frame's metres", () => {
    const { positions } = placeAoPrisms(frame, parts, 1, 30);
    const xs = Array.from(positions.filter((_, i) => i % 3 === 0));
    const ys = Array.from(positions.filter((_, i) => i % 3 === 1));
    expect(Math.min(...xs)).toBeCloseTo(50, 0);
    expect(Math.max(...xs)).toBeCloseTo(70, 0);
    expect(Math.min(...ys)).toBeCloseTo(0, 0);
    expect(Math.max(...ys)).toBeCloseTo(20, 0);
  });
});
