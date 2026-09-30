import { describe, expect, test } from "vitest";
import { lngLatBounds, projection, UsdExportError, type ExportFrame } from "../../lib/usd";
import type { BuildingFeature } from "../../lib/tiles";
import { DEFAULT_BUILDING_SETTINGS, exportBuildingsUsd, PALETTES } from "./index";
import { buildingColour, buildingMesh, buildingsPackage } from "./usd";
import { linearRgb } from "../../lib/usd";

const FRAME: ExportFrame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2048 };
const proj = projection(FRAME);
const [W, S, E, N] = lngLatBounds(FRAME);
const TILE = { x: 13724, y: 7016, z: 14 };

/** A lng/lat square ring around a point, counter-clockwise unless `cw`. */
function square(lng: number, lat: number, d: number, cw = false): [number, number][] {
  const r: [number, number][] = [
    [lng - d, lat - d],
    [lng + d, lat - d],
    [lng + d, lat + d],
    [lng - d, lat + d],
    [lng - d, lat - d],
  ];
  return cw ? r.reverse() : r;
}

type Mesh = NonNullable<ReturnType<typeof buildingMesh>>;

/** Each face's normal (Newell's method) and centroid. */
function faces(m: Mesh) {
  const out: { n: number[]; c: number[]; count: number }[] = [];
  let at = 0;
  for (const count of m.faceVertexCounts) {
    const idx = m.faceVertexIndices.slice(at, at + count);
    at += count;
    const p = idx.map((i) => m.points.slice(i * 3, i * 3 + 3));
    const n = [0, 0, 0];
    const c = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const [a, b] = [p[i], p[(i + 1) % count]];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      for (let k = 0; k < 3; k++) c[k] += a[k] / count;
    }
    out.push({ n, c, count });
  }
  return out;
}

describe("a building's mesh", () => {
  test("has walls and a roof, no floor, every face pointing outward", () => {
    for (const cw of [false, true]) {
      const m = buildingMesh([[square(121.5654, 25.033, 0.0001, cw)]], 30, proj)!;
      expect(m.points.length / 3).toBe(8);
      const fs = faces(m);
      expect(fs.filter((f) => f.count === 4)).toHaveLength(4);
      const roof = fs.filter((f) => f.count === 3);
      expect(roof).toHaveLength(2);
      for (const f of roof) {
        expect(f.c[2]).toBe(30);
        expect(f.n[2]).toBeGreaterThan(0);
      }
      // A wall's normal points away from the footprint's centre, which is the origin here.
      for (const f of fs.filter((f) => f.count === 4)) expect(f.n[0] * f.c[0] + f.n[1] * f.c[1]).toBeGreaterThan(0);
      // Nothing at the base faces down: there is no floor.
      expect(fs.some((f) => f.n[2] < 0)).toBe(false);
    }
  });

  test("a hole's walls face into the hole", () => {
    const m = buildingMesh([[square(121.5654, 25.033, 0.0002), square(121.5654, 25.033, 0.00005)]], 10, proj)!;
    const walls = faces(m).filter((f) => f.count === 4);
    expect(walls).toHaveLength(8);
    const inner = walls.filter((f) => Math.hypot(f.c[0], f.c[1]) < 10);
    expect(inner).toHaveLength(4);
    for (const f of inner) expect(f.n[0] * f.c[0] + f.n[1] * f.c[1]).toBeLessThan(0);
  });
});

describe("the colour", () => {
  const ember = PALETTES.find((p) => p.id === "ember")!;

  test("is the flat colour with no palette", () => {
    expect(buildingColour(DEFAULT_BUILDING_SETTINGS, PALETTES, 50)).toEqual(linearRgb(DEFAULT_BUILDING_SETTINGS.flatColor));
  });

  test("is the palette at the true height, clamped at both ends", () => {
    const s = { ...DEFAULT_BUILDING_SETTINGS, paletteId: "ember" };
    expect(buildingColour(s, PALETTES, 12)).toEqual(linearRgb(ember.stops[1][1]));
    expect(buildingColour(s, PALETTES, -5)).toEqual(linearRgb(ember.stops[0][1]));
    expect(buildingColour(s, PALETTES, 999)).toEqual(linearRgb(ember.stops[5][1]));
    const mid = buildingColour(s, PALETTES, 21);
    const [a, b] = [linearRgb(ember.stops[1][1]), linearRgb(ember.stops[2][1])];
    for (let k = 0; k < 3; k++) expect(mid[k]).toBeGreaterThanOrEqual(Math.min(a[k], b[k]));
  });
});

describe("the package", () => {
  const feature = (lng: number, lat: number, heightM: number): BuildingFeature => ({
    heightM,
    polygons: [[square(lng, lat, 0.0001)]],
  });
  const text = async (settings = DEFAULT_BUILDING_SETTINGS, features: BuildingFeature[]) =>
    buildingsPackage([{ tile: TILE, features }], settings, PALETTES, FRAME, "© OSM").usdz.text();

  test("keeps a building with a vertex inside the frame, whole, and drops one outside", async () => {
    const t = await text(DEFAULT_BUILDING_SETTINGS, [
      feature(E, 25.033, 20), // straddles the east edge
      feature(E + 0.01, 25.033, 20), // wholly outside
      feature(121.5654, N - 0.01, 20),
    ]);
    expect(t).toContain(`def Mesh "b_${TILE.x}_${TILE.y}_0"`);
    expect(t).not.toContain(`"b_${TILE.x}_${TILE.y}_1"`);
    expect(t).toContain(`def Mesh "b_${TILE.x}_${TILE.y}_2"`);
    // Not clipped: its east wall lies past the edge.
    const [x] = proj.toLocal(E + 0.0001, 25.033);
    expect(x).toBeGreaterThan(FRAME.sizeM / 2);
    expect(t).toContain(`(${x.toFixed(6).replace(/\.?0+$/, "")},`);
    expect(W).toBeLessThan(E);
    expect(S).toBeLessThan(N);
  });

  test("keeps a feature's footprints that touch the frame, and drops its far ones", async () => {
    const merged: BuildingFeature = {
      heightM: 20,
      polygons: [[square(121.5654, 25.033, 0.0001)], [square(E + 0.03, 25.033, 0.0001)]],
    };
    const pkg = buildingsPackage([{ tile: TILE, features: [merged] }], DEFAULT_BUILDING_SETTINGS, PALETTES, FRAME, "© OSM");
    const t = await pkg.usdz.text();
    expect(t).toContain(`def Mesh "b_${TILE.x}_${TILE.y}_0"`);
    // One square footprint: 8 points, not 16.
    const points = t.match(/point3f\[\] points = \[([^\]]*)\]/)![1];
    expect(points.match(/\(/g)).toHaveLength(8);
    expect(pkg.extentM).toBe(FRAME.sizeM / 2);
  });

  test("reports the half-side covering the frame and every mesh, overhang included", async () => {
    const pkg = buildingsPackage(
      [{ tile: TILE, features: [feature(E, 25.033, 20)] }],
      DEFAULT_BUILDING_SETTINGS,
      PALETTES,
      FRAME,
      "© OSM",
    );
    const [x] = proj.toLocal(E + 0.0001, 25.033);
    expect(pkg.extentM).toBeCloseTo(x, 6);
    expect(await pkg.usdz.text()).toContain(`double extentM = ${x.toFixed(9).replace(/\.?0+$/, "")}`);
  });

  test("drops what the minimum height drops, and scales height like the extrusion", async () => {
    const s = { ...DEFAULT_BUILDING_SETTINGS, minHeight: 15, heightScale: 2 };
    const t = await text(s, [feature(121.5654, 25.033, 10), feature(121.5655, 25.033, 20)]);
    expect(t).not.toContain(`"b_${TILE.x}_${TILE.y}_0"`);
    expect(t).toContain(`"b_${TILE.x}_${TILE.y}_1"`);
    expect(t).toMatch(/, 40\)/); // the roof at 20 m × 2
    expect(t).toContain("float primvars:heightM = 20");
    expect(t).toContain("double heightScale = 2");
  });

  test("is byte-identical for the same input", async () => {
    const fs = [feature(121.5654, 25.033, 10)];
    expect(await text(DEFAULT_BUILDING_SETTINGS, fs)).toBe(await text(DEFAULT_BUILDING_SETTINGS, fs));
  });
});

test("a tile that fails rejects the export", async () => {
  const fetchFn = (async (url: string) =>
    url.endsWith("tilejson")
      ? new Response(JSON.stringify({ tiles: ["/b/{z}/{x}/{y}"] }))
      : new Response(null, { status: 500 })) as unknown as typeof fetch;
  const source = { tileJson: "/tilejson", sourceLayer: "building", attribution: "", name: "", sourceKind: "" };
  await expect(exportBuildingsUsd(source, DEFAULT_BUILDING_SETTINGS, FRAME, fetchFn)).rejects.toBeInstanceOf(UsdExportError);
});
