import { describe, expect, test } from "vitest";
import {
  applyRowMajor,
  castToGround,
  cellCentre,
  cellM,
  cellOf,
  clipToSquare,
  counterClockwise,
  fromLocal,
  geoTransform3857,
  insideConvex,
  levelOf,
  lightMatrixRowMajor,
  makeDomain,
  FAR_DOMAIN_M,
  FAR_GRID_SIZE,
  MIN_SUN_ELEVATION_REACH_M,
  nearGridFor,
  reachVector,
  SHADOW_REACH_M,
  toLocal,
  type Vec2,
} from "./frame";

const close = (a: Vec2, b: Vec2, eps = 1e-9) => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
};

describe("the shadow shear", () => {
  test("casts a point at height h a distance h / tan(el) away from the sun", () => {
    // Sun due south at 45°: a 10 m point lands 10 m north of its base.
    close(castToGround(0, 0, 10, 180, 45), [0, 10]);
    // Sun due east at 30°: lands h·√3 west.
    close(castToGround(5, 5, 10, 90, 30), [5 - 10 * Math.sqrt(3), 5]);
  });

  test("leaves the ground where it is", () => {
    close(castToGround(12, -7, 0, 123, 17), [12, -7]);
  });

  test("the light matrix is the shear followed by the domain square", () => {
    const m = lightMatrixRowMajor(135, 40, 2048);
    const [gx, gy] = castToGround(100, -200, 30, 135, 40);
    close(applyRowMajor(m, 100, -200, 30), [gx / 1024, gy / 1024]);
  });

  test("the footprint matrix drops the shear", () => {
    const m = lightMatrixRowMajor(135, 40, 2048, true);
    close(applyRowMajor(m, 100, -200, 30), [100 / 1024, -200 / 1024]);
  });
});

describe("the domain", () => {
  const d = makeDomain(121.5654, 25.033);

  test("is 0.5 m cells by default", () => {
    expect(cellM(d)).toBe(0.5);
  });

  test("lng/lat round-trips through the local frame", () => {
    const [x, y] = toLocal(d, 121.57, 25.035);
    const [lng, lat] = fromLocal(d, x, y);
    expect(lng).toBeCloseTo(121.57, 9);
    expect(lat).toBeCloseTo(25.035, 9);
  });

  test("the local frame is metres, east and north", () => {
    // 0.001° of latitude is ~110.8 m at 25° N.
    const [, y] = toLocal(d, 121.5654, 25.034);
    expect(y).toBeGreaterThan(110);
    expect(y).toBeLessThan(112);
    const [x] = toLocal(d, 121.5664, 25.033);
    // 0.001° of longitude is ~100.9 m at 25° N.
    expect(x).toBeGreaterThan(100);
    expect(x).toBeLessThan(102);
  });

  test("cells index from the south-west, and a cell's centre is inside it", () => {
    expect(cellOf(d, -1024, -1024)).toEqual([0, 0]);
    expect(cellOf(d, 1023.9, 1023.9)).toEqual([4095, 4095]);
    expect(cellOf(d, 1024, 0)).toBeNull();
    const [x, y] = cellCentre(d, 17, 4000);
    expect(cellOf(d, x, y)).toEqual([17, 4000]);
  });

  test("a lng/lat lands in the right cell within one cell", () => {
    const [lng, lat] = fromLocal(d, 300.25, -411.75);
    const [x, y] = toLocal(d, lng, lat);
    const cell = cellOf(d, x, y)!;
    const [cx, cy] = cellCentre(d, cell[0], cell[1]);
    expect(Math.abs(cx - 300.25)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(cy + 411.75)).toBeLessThanOrEqual(0.5);
  });

  test("the export geotransform starts at the domain's north-west corner", () => {
    const gt = geoTransform3857(d);
    const [west, north] = fromLocal(d, -1024, 1024);
    // EPSG:3857 forward, on its own sphere.
    const R = 6_378_137;
    const x = (R * west * Math.PI) / 180;
    const y = R * Math.log(Math.tan(Math.PI / 4 + (north * Math.PI) / 360));
    expect(gt.originX).toBeCloseTo(x, 3);
    expect(gt.originY).toBeCloseTo(y, 3);
    // Web Mercator pixels are larger than ground metres by 1 / cos φ.
    expect(gt.pixel / 0.5).toBeCloseTo((1 / Math.cos((25.033 * Math.PI) / 180)) * (6_378_137 / 6_371_008.8), 4);
  });
});

describe("coverage", () => {
  const square: Vec2[] = [
    [-100, -100],
    [100, -100],
    [100, 100],
    [-100, 100],
  ];

  test("counterClockwise reverses a clockwise ring", () => {
    const cw = [...square].reverse();
    expect(insideConvex(cw, [0, 0])).toBe(false);
    expect(insideConvex(counterClockwise(cw), [0, 0])).toBe(true);
  });

  test("clipping to the domain square keeps the inside part", () => {
    const big: Vec2[] = [
      [-5000, -50],
      [5000, -50],
      [5000, 3000],
      [-5000, 3000],
    ];
    const clipped = clipToSquare(big, 1024);
    expect(insideConvex(counterClockwise(clipped), [0, 0])).toBe(true);
    expect(insideConvex(counterClockwise(clipped), [0, -60])).toBe(false);
    for (const [x, y] of clipped) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1024 + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(1024 + 1e-9);
    }
    expect(clipped.length).toBeLessThanOrEqual(8);
  });

  test("the reach points towards the sun and shrinks as it rises", () => {
    const high = reachVector(0, 80);
    expect(high[1]).toBeCloseTo(SHADOW_REACH_M / Math.tan((80 * Math.PI) / 180), 9);
    expect(Math.abs(high[0])).toBeLessThan(1e-9);
    const west = reachVector(270, 30);
    expect(west[0]).toBeLessThan(0);
  });

  test("the fetch margin is the reach at the lowest sun", () => {
    expect(MIN_SUN_ELEVATION_REACH_M).toBeCloseTo(150 / Math.tan((10 * Math.PI) / 180), 9);
    expect(Math.hypot(...reachVector(123, 10))).toBeCloseTo(MIN_SUN_ELEVATION_REACH_M, 9);
  });
});

describe("the far grid", () => {
  test("is 8 m cells, and shares the near grid's frame", () => {
    const far = makeDomain(121.5654, 25.033, FAR_GRID_SIZE, FAR_DOMAIN_M);
    const near = makeDomain(121.5654, 25.033);
    expect(cellM(far)).toBe(8);
    expect(toLocal(far, 121.58, 25.04)).toEqual(toLocal(near, 121.58, 25.04));
  });
});

describe("nearGridFor", () => {
  test("is the wide 4 km, 1 m grid below z15", () => {
    for (const z of [12, 13, 14, 14.99]) {
      const g = nearGridFor(z);
      expect(g.domainM / g.size).toBe(1);
      expect(g.domainM).toBe(4096);
    }
  });

  test("is the fine 2 km, 0.5 m grid from z15", () => {
    for (const z of [15, 16.5, 20]) {
      const g = nearGridFor(z);
      expect(g.domainM / g.size).toBe(0.5);
      expect(g.domainM).toBe(2048);
    }
  });
});

describe("levelOf", () => {
  const near = makeDomain(121.55, 25.04, 4096, 2048);
  const far = makeDomain(121.55, 25.04, FAR_GRID_SIZE, FAR_DOMAIN_M);

  test("picks the near grid inside it, the far grid outside, nothing beyond", () => {
    const [lng, lat] = fromLocal(near, 100, -200);
    expect(levelOf(near, far, lng, lat)).toMatchObject({ level: "near", domain: near });
    const [flng, flat] = fromLocal(near, 3000, 0);
    expect(levelOf(near, far, flng, flat)).toMatchObject({ level: "far", domain: far });
    const [olng, olat] = fromLocal(near, 9000, 0);
    expect(levelOf(near, far, olng, olat)).toBeNull();
  });

  test("answers in the grids it is given, not wherever a later plan moved to", () => {
    // A replan recentres the levels 1.5 km east; the last result is still
    // in the old frame, and a probe must be read there.
    const moved = makeDomain(...fromLocal(near, 1500, 0), 4096, 2048);
    const [lng, lat] = fromLocal(near, -900.25, 0);
    const hit = levelOf(near, far, lng, lat)!;
    expect(hit.level).toBe("near");
    close(hit.point, [-900.25, 0], 1e-6);
    expect(hit.cell).toEqual(cellOf(near, -900.25, 0));
    // In the moved frame the same point is off the near grid altogether.
    expect(levelOf(moved, far, lng, lat)!.level).toBe("far");
  });
});
