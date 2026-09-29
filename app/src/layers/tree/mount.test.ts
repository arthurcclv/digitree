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
    expect(Object.keys(m).sort()).toEqual(["dispose", "prepareSync", "update"]);
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

// See `src/lib/three/specs/spec.md`, invariant 8: MapLibre gives a layer with a
// `prerender` an offscreen pass, so it must have one exactly when it needs it.
describe("ThreeTreeLayer", () => {
  test("is a ThreeLayer, without a prerender", () => {
    expect(ThreeTreeLayer.prototype).toBeInstanceOf(ThreeLayer);
    expect("prerender" in ThreeTreeLayer.prototype).toBe(false);
  });
});
