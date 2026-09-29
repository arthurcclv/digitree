import { describe, expect, test } from "vitest";
import { featureFilter, type FilterSpecification } from "@maplibre/maplibre-gl-style-spec";
import { buildingHeight, BUILDING_SHOWN_FILTER, meetsMinHeight, minHeightFilter } from "./schema";
import { buildingsLayer, DEFAULT_BUILDING_SETTINGS } from "./index";

/** The extrusion's own filter for a minimum height, as MapLibre evaluates it. */
function keptByExtrusion(props: Record<string, unknown>, minHeight: number): boolean {
  const record = buildingsLayer({ ...DEFAULT_BUILDING_SETTINGS, minHeight }, {
    tileJson: "https://example.test/tiles.json",
    sourceLayer: "building",
    attribution: "",
    name: "",
    sourceKind: "",
  });
  const f = featureFilter(record.filterExpression as FilterSpecification, "filter");
  // type 3: a polygon, as a building footprint is.
  return f.filter({ zoom: 15 }, { type: 3, properties: props } as never);
}

const SAMPLES: Record<string, unknown>[] = [
  { render_height: 30 },
  { render_height: "12.5" },
  { render_height: 4 },
  { render_height: 30, hide_3d: true },
  { render_height: 0 },
  { render_height: -3 },
  {},
  { hide_3d: true },
];

describe("buildingHeight", () => {
  test("drops hide_3d and non-positive heights", () => {
    expect(buildingHeight({ render_height: 30 })).toBe(30);
    expect(buildingHeight({ render_height: "12.5" })).toBe(12.5);
    expect(buildingHeight({ render_height: 30, hide_3d: true })).toBeNull();
    expect(buildingHeight({ render_height: 0 })).toBeNull();
    expect(buildingHeight({})).toBeNull();
  });
});

describe("the two forms of the rule", () => {
  test("every building the JS form keeps, the extrusion keeps, at every minimum height", () => {
    for (const minHeight of [0, 5, 20]) {
      for (const p of SAMPLES) {
        const h = buildingHeight(p);
        if (h !== null && h >= minHeight) expect(keptByExtrusion(p, minHeight), JSON.stringify(p)).toBe(true);
        if (!keptByExtrusion(p, minHeight)) expect(h === null || h < minHeight, JSON.stringify(p)).toBe(true);
      }
    }
  });

  test("both drop hide_3d", () => {
    expect(keptByExtrusion({ render_height: 30, hide_3d: true }, 0)).toBe(false);
    expect(buildingHeight({ render_height: 30, hide_3d: true })).toBeNull();
  });

  // The one known divergence, pinned so it cannot widen unnoticed: a footprint
  // with no volume is drawn flat, but has nothing to shade or occlude.
  test("differ only on a non-positive height with no minimum", () => {
    const differing = [0, 5, 20].flatMap((m) =>
      SAMPLES.filter((p) => keptByExtrusion(p, m) !== (buildingHeight(p) !== null && buildingHeight(p)! >= m)).map(
        (p) => [m, p],
      ),
    );
    expect(differing).toEqual([
      [0, { render_height: 0 }],
      [0, { render_height: -3 }],
      [0, {}],
    ]);
  });

  test("the record's filter is built from the schema's parts", () => {
    expect(minHeightFilter(5)).toEqual([">=", ["to-number", ["get", "render_height"], 0], 5]);
    expect(BUILDING_SHOWN_FILTER).toEqual(["!=", ["get", "hide_3d"], true]);
  });
});

describe("meetsMinHeight", () => {
  // Ambient occlusion filters decoded heights with this; the extrusion with
  // `minHeightFilter`. They must keep the same buildings, or the redrawn
  // prisms and the drawn extrusions disagree.
  test("agrees with minHeightFilter, as MapLibre evaluates it, for every positive height", () => {
    for (const m of [0, 0.5, 5, 20, 80]) {
      const f = featureFilter(minHeightFilter(m) as FilterSpecification, "filter");
      for (const h of [0.1, 0.5, 4.99, 5, 5.01, 20, 79.9, 80, 300]) {
        const byMapLibre = f.filter({ zoom: 15 }, { type: 3, properties: { render_height: h } } as never);
        expect(meetsMinHeight(h, m), `h=${h} m=${m}`).toBe(byMapLibre);
      }
    }
  });
});
