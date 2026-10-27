import { describe, expect, test, vi } from "vitest";
import { getExternalNativePaintBridge } from "@geolibre/core";
import { createGraph } from "../../lib/dag";
import { ThreeLayer } from "../../lib/three";
import { fakeMap } from "../../lib/mount/fakeMap";
import { TREE_LAYER_ID } from "./constants";
import { DEFAULT_TREE_SETTINGS, type TreeSettings } from "./index";
import { mountTree } from "./mount";
import { treeMeshRecord, treePointsLayer } from "./records";
import type { TreeSource } from "./schema";
import { ThreeTreeLayer, TREE_NATIVE_LAYER_ID } from "./treeLayer";

/** A foreign inventory: the mount must take everything about it from here. */
const TREES: TreeSource = {
  tiles: "https://trees.example.test/{z}/{x}/{y}.pbf",
  sourceLayer: "arbres",
  minzoom: 12,
  maxzoom: 18,
  bounds: [2.22, 48.81, 2.47, 48.91],
  attribution: "",
  name: "Arbres",
  sourceKind: "fixture",
  fallbackHeightM: 7,
};

const mount = (settings: TreeSettings = DEFAULT_TREE_SETTINGS) => {
  const f = fakeMap();
  return { f, m: mountTree({ map: f.map, graph: createGraph() }, { trees: TREES }, settings) };
};

describe("mountTree", () => {
  // A new member is how a host would push layer-specific state in (a setter);
  // it means changing the factory table in the mount spec first (invariant 8).
  test("exposes exactly its members", () => {
    const { m } = mount();
    expect(Object.keys(m).sort()).toEqual(["dispose", "exportUsd", "pick", "prepareSync", "select", "update"]);
    m.dispose();
  });

  test("syncs the same two records the builders make, points first", () => {
    const settings = { ...DEFAULT_TREE_SETTINGS, kind: "park" as const, opacity: 0.5 };
    const { m } = mount(settings);
    expect(m.prepareSync()).toEqual([treePointsLayer(settings, TREES), treeMeshRecord(settings)]);
    m.dispose();
  });

  test("adds the custom layer, and re-adds it after a style reset", () => {
    const { f, m } = mount();
    m.prepareSync();
    m.prepareSync();
    expect(f.added).toEqual([TREE_NATIVE_LAYER_ID]);
    f.resetStyle();
    m.prepareSync();
    expect(f.added).toEqual([TREE_NATIVE_LAYER_ID, TREE_NATIVE_LAYER_ID]);
    m.dispose();
  });

  test("registers the paint bridge on mount and clears it on dispose", () => {
    const { m } = mount();
    expect(getExternalNativePaintBridge(TREE_LAYER_ID)).toBeDefined();
    m.dispose();
    expect(getExternalNativePaintBridge(TREE_LAYER_ID)).toBeUndefined();
  });

  test("pushes only the settings that changed to the layer", () => {
    const setKind = vi.spyOn(ThreeTreeLayer.prototype, "setKind");
    const setHeightScale = vi.spyOn(ThreeTreeLayer.prototype, "setHeightScale");
    const setMeshSource = vi.spyOn(ThreeTreeLayer.prototype, "setMeshSource");
    const { m } = mount();
    for (const spy of [setKind, setHeightScale, setMeshSource]) spy.mockClear();
    m.update({ ...DEFAULT_TREE_SETTINGS, opacity: 0.3 });
    expect(setKind).not.toHaveBeenCalled();
    expect(setHeightScale).not.toHaveBeenCalled();
    m.update({ ...DEFAULT_TREE_SETTINGS, opacity: 0.3, kind: "street" });
    expect(setKind).toHaveBeenCalledWith("street");
    expect(setHeightScale).not.toHaveBeenCalled();
    expect(setMeshSource).not.toHaveBeenCalled();
    m.dispose();
    vi.restoreAllMocks();
  });
});

describe("mountTree: picking and marks", () => {
  /** The fake map plus what picking on the circles and marking them touch. */
  const pickable = (settings: TreeSettings) => {
    const f = fakeMap();
    const queries: unknown[] = [];
    const states: { target: unknown; state: unknown }[] = [];
    const canvas = { style: { cursor: "" } };
    Object.assign(f.map, {
      getStyle: () => ({ layers: [{ id: "layer-tree-points-arbres-circle", type: "circle" }] }),
      queryRenderedFeatures: (...args: unknown[]) => {
        queries.push(args);
        return [{ id: 42, properties: { tree_id: "T1", kind: "park" }, geometry: { type: "Point", coordinates: [2.3, 48.8] } }];
      },
      project: () => ({ x: 10, y: 10 }),
      setFeatureState: (target: unknown, state: unknown) => states.push({ target, state }),
      getCanvas: () => canvas,
    });
    const m = mountTree({ map: f.map, graph: createGraph() }, { trees: TREES }, settings);
    return { f, m, queries, states };
  };
  const circlesOnly = { ...DEFAULT_TREE_SETTINGS, meshVisible: false };

  test("registers its hover listeners on mount and removes them on dispose", () => {
    const { f, m } = mount();
    for (const type of ["mousemove", "mouseout", "movestart"]) expect(f.listeners.get(type)?.size).toBe(1);
    m.dispose();
    for (const type of ["mousemove", "mouseout", "movestart"]) expect(f.listeners.get(type)?.size).toBe(0);
  });

  test("picks on the circles when the meshes are off", () => {
    const { m, queries } = pickable(circlesOnly);
    expect(m.pick({ x: 10, y: 10 })).toMatchObject({ id: "T1", kind: "park" });
    expect(queries).toHaveLength(1);
    m.dispose();
  });

  test("picks nothing, and queries nothing, with both halves off", () => {
    const { m, queries } = pickable({ ...DEFAULT_TREE_SETTINGS, meshVisible: false, pointsVisible: false });
    expect(m.pick({ x: 10, y: 10 })).toBeNull();
    expect(queries).toHaveLength(0);
    m.dispose();
  });

  test("select marks the picked circle by its feature id, and select(null) unmarks it", () => {
    const setMarks = vi.spyOn(ThreeTreeLayer.prototype, "setMarks");
    const { m, states } = pickable(circlesOnly);
    const target = { source: "source-tree-points", sourceLayer: "arbres", id: 42 };
    m.select(m.pick({ x: 10, y: 10 })!.id);
    expect(states).toEqual([{ target, state: { selected: true } }]);
    expect(setMarks).toHaveBeenLastCalledWith({ hover: null, selected: "T1" });
    m.select(null);
    expect(states.at(-1)).toEqual({ target, state: { selected: false } });
    expect(setMarks).toHaveBeenLastCalledWith({ hover: null, selected: null });
    m.dispose();
    vi.restoreAllMocks();
  });
});

// See `src/lib/three/specs/spec.md`, invariant 8: MapLibre gives a layer with a
// `prerender` an offscreen pass, so it must have one exactly when it needs it.
describe("ThreeTreeLayer", () => {
  test("is a ThreeLayer, without a prerender", () => {
    expect(ThreeTreeLayer.prototype).toBeInstanceOf(ThreeLayer);
    expect("prerender" in ThreeTreeLayer.prototype).toBe(false);
  });
});
