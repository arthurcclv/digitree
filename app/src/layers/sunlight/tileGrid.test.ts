import { describe, expect, test } from "vitest";
import { DOMAIN_M, FAR_DOMAIN_M, FAR_GRID_SIZE, fromLocal, makeDomain, toLocal, type Vec2 } from "./frame";
import {
  classifyByTiles,
  FETCH_MARGIN_M,
  planTiles,
  TILE_ZOOM,
  tileIntersects,
  tileKey,
  tileOfLngLat,
  tileSquareLocal,
} from "./tileGrid";

const far = makeDomain(121.5435, 25.033, FAR_GRID_SIZE, FAR_DOMAIN_M);

describe("tile maths", () => {
  test("a point lies inside its own tile's square", () => {
    const [lng, lat] = [121.5501, 25.0402];
    const t = tileOfLngLat(lng, lat);
    const [w, s, e, n] = tileSquareLocal(far, t);
    const [x, y] = toLocal(far, lng, lat);
    expect(x).toBeGreaterThanOrEqual(w);
    expect(x).toBeLessThan(e);
    expect(y).toBeGreaterThan(s);
    expect(y).toBeLessThanOrEqual(n);
  });

  test("a z14 tile at Taipei is about 2.2 km across", () => {
    const [w, s, e, n] = tileSquareLocal(far, tileOfLngLat(121.5435, 25.033));
    expect(e - w).toBeGreaterThan(2150);
    expect(e - w).toBeLessThan(2250);
    expect(n - s).toBeCloseTo(e - w, 6);
  });

  test("tileIntersects against a lng/lat box", () => {
    const t = tileOfLngLat(121.55, 25.04);
    expect(tileIntersects(t, [121.46, 24.97, 121.63, 25.16])).toBe(true);
    expect(tileIntersects(t, [120, 23, 120.5, 23.5])).toBe(false);
  });
});

describe("planTiles", () => {
  const footprint: Vec2[] = [
    [-400, -300],
    [400, -300],
    [900, 3000],
    [-900, 3000],
  ];

  test("covers the footprint and the near grid, grown by the margin on every side", () => {
    const tiles = planTiles(far, footprint, DOMAIN_M / 2);
    const keys = new Set(tiles.map(tileKey));
    const probe = (x: number, y: number) => {
      const [lng, lat] = fromLocal(far, x, y);
      return keys.has(tileKey(tileOfLngLat(lng, lat)));
    };
    const m = FETCH_MARGIN_M - 1;
    // Corners of the grown box.
    expect(probe(-1024 - m, -1024 - m)).toBe(true);
    expect(probe(1024 + m, -1024 - m)).toBe(true);
    expect(probe(-1024 - m, 3000 + m)).toBe(true);
    expect(probe(1024 + m, 3000 + m)).toBe(true);
  });

  test("plans nothing further than one tile beyond that box", () => {
    const tiles = planTiles(far, footprint, DOMAIN_M / 2);
    const tileM = 2250;
    for (const t of tiles) {
      const [w, s, e, n] = tileSquareLocal(far, t);
      expect(e).toBeGreaterThan(-1024 - FETCH_MARGIN_M);
      expect(w).toBeLessThan(1024 + FETCH_MARGIN_M);
      expect(n).toBeGreaterThan(-1024 - FETCH_MARGIN_M);
      expect(s).toBeLessThan(3000 + FETCH_MARGIN_M);
      expect(e - w).toBeLessThan(tileM);
      expect(t.z).toBe(TILE_ZOOM);
    }
  });

  test("never plans past the far grid", () => {
    const huge: Vec2[] = [
      [-20_000, -20_000],
      [20_000, -20_000],
      [20_000, 20_000],
    ];
    for (const t of planTiles(far, huge, DOMAIN_M / 2)) {
      const [w, s, e, n] = tileSquareLocal(far, t);
      expect(e).toBeGreaterThan(-FAR_DOMAIN_M / 2);
      expect(w).toBeLessThan(FAR_DOMAIN_M / 2);
      expect(n).toBeGreaterThan(-FAR_DOMAIN_M / 2);
      expect(s).toBeLessThan(FAR_DOMAIN_M / 2);
    }
  });
});

describe("classifyByTiles", () => {
  const here = tileOfLngLat(...fromLocal(far, 0, 0));
  const east = { ...here, x: here.x + 1 };
  const [, , hereEast] = tileSquareLocal(far, here);
  const covered = new Set([tileKey(here), tileKey(east)]);

  test("complete when the point and its reach are both in covered tiles", () => {
    expect(classifyByTiles(far, covered, [300, 0], [hereEast - 100, 0])).toBe("complete");
  });

  test("incomplete when the reach lands in an uncovered tile", () => {
    expect(classifyByTiles(far, covered, [0, 5000], [0, 0])).toBe("incomplete");
  });

  test("outside when the point's own tile is uncovered", () => {
    expect(classifyByTiles(far, covered, [0, 0], [0, 5000])).toBe("outside");
  });
});
