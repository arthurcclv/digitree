import { afterEach, describe, expect, test, vi } from "vitest";
import { OSM_ATTRIBUTION, OSM_TILEJSON } from "./layers/basemaps";
import { BUILDINGS, SPLATS, TREES, TREES_SURVEYED } from "./sources";

describe("TREES_SURVEYED", () => {
  test("is the size of the surveyed inventory infra/ loads", () => {
    expect(TREES_SURVEYED).toBe(162_930);
  });

  // The panel prints it, and a bare `toLocaleString()` would group it by
  // whichever locale the browser happens to run in — 162.930 on a German one,
  // which reads as a decimal. The readout pins the locale; this pins the shape.
  test("prints grouped, in the panel's locale", () => {
    expect(TREES_SURVEYED.toLocaleString("en-US")).toBe("162,930");
  });
});

describe("TREES", () => {
  // Fetched from Martin directly; see `lib/tiles/specs/origins.md`.
  test("is Martin's on localhost:3000 by default, under the names in infra/martin.yaml", () => {
    expect(TREES.tiles).toBe("http://localhost:3000/trees/{z}/{x}/{y}");
    expect(TREES.sourceLayer).toBe("trees");
    expect([TREES.minzoom, TREES.maxzoom]).toEqual([14, 20]);
  });

  // Facts about this inventory, moved out of the tree layer unchanged.
  test("names the points record and falls back to the inventory's median height", () => {
    expect(TREES).toMatchObject({ name: "Taipei Trees", sourceKind: "postgis-martin", fallbackHeightM: 9.1 });
  });
});

describe("BUILDINGS", () => {
  // One OSM snapshot for the ground plane and the extrusions.
  test("is the basemaps' own OSM snapshot", () => {
    expect(BUILDINGS).toMatchObject({ tileJson: OSM_TILEJSON, sourceLayer: "building", attribution: OSM_ATTRIBUTION });
  });

  test("names the extrusion as the app always has", () => {
    expect(BUILDINGS).toMatchObject({ name: "OSM Buildings", sourceKind: "osm-openfreemap" });
  });
});

describe("SPLATS", () => {
  test("is Martin's and files' on their default localhost ports", () => {
    expect(SPLATS).toMatchObject({
      tiles: "http://localhost:3000/splats/{z}/{x}/{y}",
      sourceLayer: "splats",
      files: "http://localhost:3080/3dgs/",
      lodFiles: "http://localhost:3080/3dgs-lod/",
    });
  });

  // *The shared ground* in the splat spec: "Snap tiles to ground" off.
  test("shares the median ground of the delivered mosaic's tiles", () => {
    expect(SPLATS.sharedGroundZ).toBe(25.85);
  });
});

// `lib/tiles/specs/origins.md`, *Invariants* 2: the settings move every URL.
describe("VITE_TILES_URL and VITE_FILES_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("set the origins of every tile and file URL", async () => {
    vi.stubEnv("VITE_TILES_URL", "http://192.168.81.32:3001/");
    vi.stubEnv("VITE_FILES_URL", "https://192.168.81.32:3443");
    vi.resetModules();
    const sources = await import("./sources");
    expect(sources.TREES.tiles).toBe("http://192.168.81.32:3001/trees/{z}/{x}/{y}");
    expect(sources.SPLATS).toMatchObject({
      tiles: "http://192.168.81.32:3001/splats/{z}/{x}/{y}",
      files: "https://192.168.81.32:3443/3dgs/",
      lodFiles: "https://192.168.81.32:3443/3dgs-lod/",
    });
  });

  test("a malformed one fails loudly, naming it", async () => {
    vi.stubEnv("VITE_FILES_URL", "localhost:3080");
    vi.resetModules();
    await expect(import("./sources")).rejects.toThrow(/VITE_FILES_URL/);
  });
});
