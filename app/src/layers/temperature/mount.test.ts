import { describe, expect, test, vi } from "vitest";
import { getExternalNativePaintBridge } from "@geolibre/core";
import type { BuildingSource } from "../buildings";
import type { TreeSource } from "../tree";
import { createGraph } from "../../lib/dag";
import { ThreeLayer } from "../../lib/three";
import { fakeMap } from "../../lib/mount/fakeMap";
import { DEFAULT_SUNLIGHT_SETTINGS, LPI_NODE, mountSunlight } from "../sunlight";

/** A moment for the settings: the host's, so the layer has no default. */
const SUN = { ...DEFAULT_SUNLIGHT_SETTINGS, sunTime: Date.parse("2026-06-21T04:00:00Z") };
import { DEFAULT_TEMPERATURE_SETTINGS, type TemperatureStatus } from "./index";
import { mountTemperature } from "./mount";
import { TEMPERATURE_LAYER_ID, temperatureRecord } from "./records";
import { TEMPERATURE_NATIVE_LAYER_ID, ThreeTemperatureLayer } from "./temperatureLayer";

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
const BUILDINGS: BuildingSource = { tileJson: "https://example.test/b.json", sourceLayer: "building", attribution: "", name: "", sourceKind: "" };

/** Both layers on one map and one graph, mounted in dependency order. */
const mountBoth = () => {
  const f = fakeMap();
  const ctx = { map: f.map, graph: createGraph() };
  const statuses: TemperatureStatus[] = [];
  const sunlight = mountSunlight(ctx, { trees: TREES, buildings: BUILDINGS }, SUN);
  const temperature = mountTemperature(ctx, DEFAULT_TEMPERATURE_SETTINGS, {
    onStatus: (s) => statuses.push(s),
  });
  const dispose = () => {
    temperature.dispose();
    sunlight.dispose();
  };
  return { f, graph: ctx.graph, sunlight, temperature, statuses, dispose };
};

describe("mountTemperature", () => {
  test("throws when mounted before the direct-sun layer", () => {
    const f = fakeMap();
    expect(() => mountTemperature({ map: f.map, graph: createGraph() }, DEFAULT_TEMPERATURE_SETTINGS)).toThrow(
      /unknown "sunlight.lpi"/,
    );
  });

  test("syncs the record the builder makes, and re-adds its layer after a style reset", () => {
    const { f, temperature, dispose } = mountBoth();
    expect(temperature.prepareSync()).toEqual([temperatureRecord(DEFAULT_TEMPERATURE_SETTINGS)]);
    f.resetStyle();
    temperature.prepareSync();
    expect(f.added.filter((id) => id === TEMPERATURE_NATIVE_LAYER_ID)).toHaveLength(2);
    dispose();
  });

  test("registers the paint bridge on mount and clears it on dispose", () => {
    const { dispose } = mountBoth();
    expect(getExternalNativePaintBridge(TEMPERATURE_LAYER_ID)).toBeDefined();
    dispose();
    expect(getExternalNativePaintBridge(TEMPERATURE_LAYER_ID)).toBeUndefined();
  });

  test("showing PET makes the direct-sun record visible, with its own overlay off", () => {
    const { sunlight, temperature, dispose } = mountBoth();
    expect(sunlight.prepareSync()[0].visible).toBe(false);
    temperature.update({ ...DEFAULT_TEMPERATURE_SETTINGS, visible: true });
    // Stack order: sunlight's records are built before temperature's.
    expect(sunlight.prepareSync()[0].visible).toBe(true);
    temperature.update({ ...DEFAULT_TEMPERATURE_SETTINGS, visible: false });
    expect(sunlight.prepareSync()[0].visible).toBe(false);
    dispose();
  });

  test("follows the direct-sun state through the DAG alone", () => {
    const { graph, temperature, statuses, dispose } = mountBoth();
    temperature.update({ ...DEFAULT_TEMPERATURE_SETTINGS, visible: true });
    graph.setState(LPI_NODE, "low-sun");
    expect(statuses.at(-1)?.state).toBe("low-sun");
    graph.setState(LPI_NODE, "zoom");
    expect(statuses.at(-1)?.state).toBe("zoom");
    dispose();
  });

  test("sets the PET parameters only when one changed", () => {
    const setParams = vi.spyOn(ThreeTemperatureLayer.prototype, "setParams");
    const { temperature, dispose } = mountBoth();
    setParams.mockClear();
    temperature.update({ ...DEFAULT_TEMPERATURE_SETTINGS, opacity: 0.3 });
    expect(setParams).not.toHaveBeenCalled();
    temperature.update({ ...DEFAULT_TEMPERATURE_SETTINGS, ta: 35 });
    expect(setParams).toHaveBeenCalledWith({ g0: 800, ta: 35, v: 1 });
    dispose();
    vi.restoreAllMocks();
  });
});

// See `src/lib/three/specs/spec.md`, invariant 8: MapLibre gives a layer with a
// `prerender` an offscreen pass, so it must have one exactly when it needs it.
describe("ThreeTemperatureLayer", () => {
  test("is a ThreeLayer, with a prerender", () => {
    expect(ThreeTemperatureLayer.prototype).toBeInstanceOf(ThreeLayer);
    expect("prerender" in ThreeTemperatureLayer.prototype).toBe(true);
  });
});
