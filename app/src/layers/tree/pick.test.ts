import { describe, expect, test } from "vitest";
import { expression, latest } from "@maplibre/maplibre-gl-style-spec";
import { TREE_HOVER_COLOR, TREE_SELECTED_COLOR } from "./constants";
import { pickCircle, treeInfoRows, treeStillShown } from "./pick";
import { colorExpression, TREE_KIND_COLORS } from "./records";
import type { TreeFeature } from "./schema";

const tree = (over: Partial<TreeFeature> = {}): TreeFeature => ({
  id: "BT0614021096",
  lng: 121.5,
  lat: 25.04,
  heightM: 16,
  canopyWidthM: null,
  kind: "street",
  species: "榕樹",
  district: "士林區",
  place: "文林路",
  placeNote: "東側人行道",
  diameterCm: 54,
  surveyDate: "2022-11-18",
  ...over,
});

const rows = (t: TreeFeature) => Object.fromEntries(treeInfoRows(t, 9.1).map((r) => [r.label, r.value]));

describe("treeInfoRows", () => {
  test("a street tree: every city column, the place and its note joined", () => {
    expect(treeInfoRows(tree(), 9.1)).toEqual([
      { label: "Tree ID", value: "BT0614021096" },
      { label: "District", value: "士林區" },
      { label: "Location", value: "文林路 · 東側人行道" },
      { label: "Height", value: "16 m" },
      { label: "Trunk diameter", value: "54 cm" },
      { label: "Surveyed", value: "2022-11-18" },
      { label: "Coordinates", value: "25.040000, 121.500000" },
    ]);
  });

  test("a NULL is dashed, and a missing height states the fallback it is drawn at", () => {
    const r = rows(tree({ kind: "park", district: null, place: "天母公園", placeNote: null, heightM: null, diameterCm: null, surveyDate: null }));
    expect(r.District).toBe("—");
    expect(r.Location).toBe("天母公園");
    expect(r.Height).toBe("not recorded · drawn at 9.1 m");
    expect(r["Trunk diameter"]).toBe("—");
    expect(r.Surveyed).toBe("—");
    expect(rows(tree({ place: null, placeNote: "東側" })).Location).toBe("—");
  });

  test("a custom tree has no district, location or survey date rows, and does have a canopy width", () => {
    const r = rows(tree({ kind: "custom", district: null, place: null, placeNote: null, surveyDate: null, canopyWidthM: 20 }));
    expect(Object.keys(r)).toEqual(["Tree ID", "Height", "Trunk diameter", "Canopy width", "Coordinates"]);
    expect(r["Canopy width"]).toBe("20 m");
    expect(rows(tree({ kind: "custom", canopyWidthM: null }))["Canopy width"]).toBe("—");
  });

  test("numbers keep one decimal, whatever float32 noise the tile carried", () => {
    expect(rows(tree({ heightM: 4.400000095367432, diameterCm: 15.09000015258789 }))).toMatchObject({
      Height: "4.4 m",
      "Trunk diameter": "15.1 cm",
    });
  });
});

describe("treeStillShown", () => {
  const all = { pointsVisible: true, meshVisible: true, kind: "all" };
  test("a tree stays pickable while some half is drawn and its kind passes the filter", () => {
    expect(treeStillShown(tree(), all)).toBe(true);
    expect(treeStillShown(tree(), { ...all, pointsVisible: false })).toBe(true);
    expect(treeStillShown(tree(), { ...all, kind: "street" })).toBe(true);
    expect(treeStillShown(tree(), { ...all, kind: "park" })).toBe(false);
    expect(treeStillShown(tree(), { ...all, pointsVisible: false, meshVisible: false })).toBe(false);
  });
});

describe("pickCircle", () => {
  const feature = (id: number, treeId: string, lng: number) => ({
    id,
    properties: { tree_id: treeId, kind: "street" },
    geometry: { type: "Point", coordinates: [lng, 25] },
  });
  /** A feature's longitude is its screen x, so distances are exact. */
  const fakeCircleMap = (features: unknown[], layers = [{ id: "layer-tree-points-trees-circle", type: "circle" }]) => {
    const queries: unknown[] = [];
    const map = {
      getStyle: () => ({ layers }),
      queryRenderedFeatures: (box: unknown, options: unknown) => {
        queries.push({ box, options });
        return features;
      },
      project: ([lng]: [number, number]) => ({ x: lng, y: 100 }),
    };
    return { map: map as never, queries };
  };

  test("queries only the points record's circle layers, in a box padded by the pick distance", () => {
    const { map, queries } = fakeCircleMap([], [
      { id: "layer-tree-points-trees-circle", type: "circle" },
      { id: "layer-tree-points-trees-line", type: "line" },
      { id: "layer-buildings-circle", type: "circle" },
    ]);
    pickCircle(map, { x: 50, y: 100 });
    expect(queries).toEqual([
      {
        box: [
          [44, 94],
          [56, 106],
        ],
        options: { layers: ["layer-tree-points-trees-circle"] },
      },
    ]);
  });

  test("the nearest centre wins, then the lower tree_id; the MVT id comes with it", () => {
    const { map } = fakeCircleMap([feature(1, "B", 53), feature(2, "C", 49), feature(3, "A", 47)]);
    // C and A are both 1 px from x = 48; A wins the tie.
    expect(pickCircle(map, { x: 48, y: 100 })).toMatchObject({ tree: { id: "A" }, featureId: 3 });
    expect(pickCircle(map, { x: 53, y: 100 })).toMatchObject({ tree: { id: "B" }, featureId: 1 });
  });

  test("nothing without the circle layer, and nothing among unreadable features", () => {
    expect(pickCircle(fakeCircleMap([feature(1, "A", 50)], []).map, { x: 50, y: 100 })).toBeNull();
    const unreadable = { id: 1, properties: { tree_id: 7 }, geometry: { type: "Point", coordinates: [50, 25] } };
    expect(pickCircle(fakeCircleMap([unreadable]).map, { x: 50, y: 100 })).toBeNull();
  });
});

describe("the circles' colour", () => {
  const spec = latest.paint_circle["circle-color"];
  const colour = expression.createPropertyExpression(JSON.parse(colorExpression()), "circle-color", spec as never);
  if (colour.result !== "success") throw new Error(JSON.stringify(colour.value));
  const at = (kind: string, state: Record<string, boolean>) => {
    const c = colour.value.evaluate({ zoom: 16 }, { type: 1, properties: { kind } } as never, state);
    return [c.r, c.g, c.b].map((v: number) => Math.round(v * 255));
  };
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  test("selected, then hovered, then the kind", () => {
    expect(at("street", {})).toEqual(hex(TREE_KIND_COLORS.street!));
    expect(at("park", { hover: false, selected: false })).toEqual(hex(TREE_KIND_COLORS.park!));
    expect(at("street", { hover: true })).toEqual(hex(TREE_HOVER_COLOR));
    expect(at("street", { selected: true })).toEqual(hex(TREE_SELECTED_COLOR));
    expect(at("custom", { hover: true, selected: true })).toEqual(hex(TREE_SELECTED_COLOR));
  });
});
