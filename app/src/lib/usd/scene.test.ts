import { describe, expect, test } from "vitest";
import { colourise } from "./raster";
import { groundPackage } from "./ground";
import { rootLayer, type UsdPackage } from "./scene";

const FRAME = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2048 };
const pkg = (name: string, prim: string, attribution: string[]): UsdPackage => ({
  name,
  prim,
  usdz: new Blob([]),
  sidecars: [],
  attribution,
});

describe("the root layer", () => {
  const root = rootLayer(FRAME, [pkg("basemap", "Basemap", ["© OSM"]), pkg("trees", "Trees", ["© OSM", "models CC BY"])], 0, 0);

  test("references exactly the given packages, in order, and nothing else", () => {
    const refs = [...root.matchAll(/prepend references = @\.\/(\w+)\.usdz@/g)].map((m) => m[1]);
    expect(refs).toEqual(["basemap", "trees"]);
    expect(root).toContain('def "Basemap"');
    expect(root).toContain('def "Trees"');
    expect(root).not.toMatch(/def Mesh|def Material/);
  });

  test("is Z-up in metres, with World the default prim and the origin recorded", () => {
    expect(root).toContain('upAxis = "Z"');
    expect(root).toContain("metersPerUnit = 1");
    expect(root).toContain('defaultPrim = "World"');
    expect(root).toContain("double originLng = 121.5654");
    expect(root).toContain('string crs = "EPSG:3857"');
  });

  test("lists each attribution once", () => {
    expect(root).toContain('string[] attribution = ["© OSM", "models CC BY"]');
  });
});

test("colourise ramps each value and leaves NoData transparent", () => {
  const rgba = colourise(new Float32Array([0, 1, -1]), -1, (v) => [v, 0, 1 - v]);
  expect([...rgba]).toEqual([0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 0, 0]);
});

test("a ground quad spans its half-side, or the frame's", async () => {
  const quad = async (halfM?: number) =>
    (await groundPackage({ name: "g", prim: "G", frame: FRAME, z: 0, png: new Uint8Array(), masked: false, attribution: [], halfM }).usdz.text());
  expect(await quad()).toContain("point3f[] points = [(-1024, -1024, 0), (1024, -1024, 0), (1024, 1024, 0), (-1024, 1024, 0)]");
  expect(await quad(1500)).toContain("point3f[] points = [(-1500, -1500, 0), (1500, -1500, 0), (1500, 1500, 0), (-1500, 1500, 0)]");
});
