import { describe, expect, test } from "vitest";
import { tileOfLngLat } from "../../lib/tiles";
import { DEFAULT_TREE_SETTINGS, treePointsLayer } from "./index";
import { treeOf, treeTiles, type TreeSource } from "./schema";

/** Nowhere near Taipei: whatever the record carries, it took from here. */
export const FOREIGN_TREES: TreeSource = {
  tiles: "https://trees.example.test/{z}/{x}/{y}.pbf",
  sourceLayer: "arbres",
  minzoom: 12,
  maxzoom: 18,
  bounds: [2.22, 48.81, 2.47, 48.91],
  attribution: "Ville de Paris",
  name: "Arbres",
  sourceKind: "fixture",
  fallbackHeightM: 7,
};

const point = (lng: number, lat: number) => ({ type: "Point", coordinates: [lng, lat] });

describe("treeOf", () => {
  test("reads a Point with a text tree_id", () => {
    expect(treeOf({ tree_id: "T1", kind: "street", species: "榕樹", height_m: 8 }, point(121.5, 25))).toEqual({
      id: "T1",
      lng: 121.5,
      lat: 25,
      heightM: 8,
      canopyWidthM: null,
      kind: "street",
      species: "榕樹",
      district: null,
      place: null,
      placeNote: null,
      diameterCm: null,
      surveyDate: null,
    });
  });

  test("reads the display fields: text as non-empty strings, the diameter as a positive number", () => {
    const props = {
      tree_id: "BT1",
      district: "士林區",
      place: "文林路",
      place_note: "東側人行道",
      diameter_cm: 54,
      survey_date: "2022-11-18",
    };
    expect(treeOf(props, point(121.5, 25))).toMatchObject({
      district: "士林區",
      place: "文林路",
      placeNote: "東側人行道",
      diameterCm: 54,
      surveyDate: "2022-11-18",
    });
    const t = treeOf({ tree_id: "BT1", district: "", place: 3, place_note: null, survey_date: 20221118 }, point(0, 0))!;
    expect([t.district, t.place, t.placeNote, t.surveyDate]).toEqual([null, null, null, null]);
    for (const bad of [undefined, null, 0, -1, "54", Number.NaN]) {
      expect(treeOf({ tree_id: "T1", diameter_cm: bad }, point(0, 0))!.diameterCm).toBeNull();
    }
  });

  test("reads canopy_width_m as a positive number, and as null otherwise", () => {
    const width = (w: unknown) => treeOf({ tree_id: "T1", canopy_width_m: w }, point(0, 0))!.canopyWidthM;
    expect(width(8.5)).toBe(8.5);
    for (const bad of [undefined, null, 0, -2, "8.5", Number.NaN]) expect(width(bad)).toBeNull();
  });

  test("rejects a non-Point and a missing or non-text tree_id", () => {
    expect(treeOf({ tree_id: "T1" }, { type: "LineString", coordinates: [] })).toBeNull();
    expect(treeOf({}, point(0, 0))).toBeNull();
    expect(treeOf({ tree_id: 7 }, point(0, 0))).toBeNull();
    expect(treeOf(null, point(0, 0))).toBeNull();
    expect(treeOf({ tree_id: "T1" }, null)).toBeNull();
  });

  test("a missing, zero, negative or non-numeric height is null, not zero", () => {
    for (const height_m of [undefined, null, 0, -2, "9"]) {
      expect(treeOf({ tree_id: "T1", height_m }, point(0, 0))?.heightM).toBeNull();
    }
  });
});

describe("treeTiles", () => {
  test("asks only for tiles inside the descriptor's bounds, at its URL", () => {
    const src = treeTiles(FOREIGN_TREES);
    expect(src.location).toEqual({ tiles: FOREIGN_TREES.tiles });
    expect(src.mayHold!(tileOfLngLat(2.35, 48.86))).toBe(true);
    expect(src.mayHold!(tileOfLngLat(121.55, 25.04))).toBe(false);
  });
});

describe("treePointsLayer", () => {
  test("takes every source field from the descriptor it is given", () => {
    const r = treePointsLayer(DEFAULT_TREE_SETTINGS, FOREIGN_TREES);
    expect(r.source).toEqual({
      tiles: [FOREIGN_TREES.tiles],
      sourceLayer: FOREIGN_TREES.sourceLayer,
      minzoom: FOREIGN_TREES.minzoom,
      maxzoom: FOREIGN_TREES.maxzoom,
      bounds: FOREIGN_TREES.bounds,
    });
    expect(r.style.minZoom).toBe(FOREIGN_TREES.minzoom);
  });

  test("is named and labelled by the descriptor, not by the layer", () => {
    const r = treePointsLayer(DEFAULT_TREE_SETTINGS, FOREIGN_TREES);
    expect(r.name).toBe(FOREIGN_TREES.name);
    expect(r.metadata).toMatchObject({ sourceKind: FOREIGN_TREES.sourceKind });
  });
});
