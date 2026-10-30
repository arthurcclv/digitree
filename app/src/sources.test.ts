import { describe, expect, test } from "vitest";
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
  // Relative, so every request goes through Vite's proxy; see the tree spec.
  test("is served same-origin, from the Martin names in infra/martin.yaml", () => {
    expect(TREES.tiles).toBe("/tiles/trees/{z}/{x}/{y}");
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
  // *The shared ground* in the splat spec: "Snap tiles to ground" off.
  test("shares the median ground of the delivered mosaic's tiles", () => {
    expect(SPLATS.sharedGroundZ).toBe(25.85);
  });
});
