import { describe, expect, test, vi } from "vitest";
import { getExternalNativePaintBridge } from "@geolibre/core";
import type { BuildingSource } from "../buildings";
import type { TreeSource } from "../tree";
import { createGraph } from "../../lib/dag";
import { ThreeLayer } from "../../lib/three";
import { fakeMap } from "../../lib/mount/fakeMap";
import { DEFAULT_SUNLIGHT_SETTINGS } from "./index";
import { LPI_NODE } from "./lpi";
import { mountSunlight } from "./mount";
import { SUNLIGHT_LAYER_ID, sunlightRecord } from "./records";
import { SUNLIGHT_NATIVE_LAYER_ID, ThreeSunlightLayer } from "./sunlightLayer";

const TREES: TreeSource = {
  tiles: "https://trees.example.test/{z}/{x}/{y}.pbf",
  sourceLayer: "arbres",
  minzoom: 12,
  maxzoom: 18,
  bounds: [2.22, 48.81, 2.47, 48.91],
  attribution: "",
};
const BUILDINGS: BuildingSource = { tileJson: "https://example.test/b.json", sourceLayer: "building", attribution: "" };

const mount = () => {
  const f = fakeMap();
  const graph = createGraph();
  return { f, graph, m: mountSunlight({ map: f.map, graph }, { trees: TREES, buildings: BUILDINGS }, DEFAULT_SUNLIGHT_SETTINGS) };
};

describe("mountSunlight", () => {
  test("adds its own DAG node", () => {
    const { graph, m } = mount();
    expect(graph.state(LPI_NODE)).toBe("off");
    m.dispose();
  });

  test("syncs the record the builder makes, visible exactly while demanded", () => {
    const { m } = mount();
    expect(m.prepareSync()).toEqual([sunlightRecord(DEFAULT_SUNLIGHT_SETTINGS, false)]);
    const on = { ...DEFAULT_SUNLIGHT_SETTINGS, visible: true };
    m.update(on);
    expect(m.prepareSync()).toEqual([sunlightRecord(on, true)]);
    m.dispose();
  });

  test("adds the custom layer, and re-adds it after a style reset", () => {
    const { f, m } = mount();
    m.prepareSync();
    f.resetStyle();
    m.prepareSync();
    expect(f.added).toEqual([SUNLIGHT_NATIVE_LAYER_ID, SUNLIGHT_NATIVE_LAYER_ID]);
    m.dispose();
  });

  test("registers the paint bridge on mount and clears it on dispose", () => {
    const { m } = mount();
    expect(getExternalNativePaintBridge(SUNLIGHT_LAYER_ID)).toBeDefined();
    m.dispose();
    expect(getExternalNativePaintBridge(SUNLIGHT_LAYER_ID)).toBeUndefined();
  });

  test("sets the sun time only when it changed", () => {
    const setSunTime = vi.spyOn(ThreeSunlightLayer.prototype, "setSunTime");
    const { m } = mount();
    setSunTime.mockClear();
    m.update({ ...DEFAULT_SUNLIGHT_SETTINGS, opacity: 0.2 });
    expect(setSunTime).not.toHaveBeenCalled();
    m.update({ ...DEFAULT_SUNLIGHT_SETTINGS, sunTime: DEFAULT_SUNLIGHT_SETTINGS.sunTime + 60_000 });
    expect(setSunTime).toHaveBeenCalledTimes(1);
    m.dispose();
    vi.restoreAllMocks();
  });
});

// See `src/lib/three/specs/spec.md`, invariant 8: MapLibre gives a layer with a
// `prerender` an offscreen pass, so it must have one exactly when it needs it.
describe("ThreeSunlightLayer", () => {
  test("is a ThreeLayer, with a prerender", () => {
    expect(ThreeSunlightLayer.prototype).toBeInstanceOf(ThreeLayer);
    expect("prerender" in ThreeSunlightLayer.prototype).toBe(true);
  });
});
