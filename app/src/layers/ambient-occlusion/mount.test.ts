import { describe, expect, test, vi } from "vitest";
import { getExternalNativePaintBridge } from "@geolibre/core";
import type { BuildingSource } from "../buildings";
import { createGraph } from "../../lib/dag";
import { fakeMap } from "../../lib/mount/fakeMap";
import { AO_NATIVE_LAYER_ID, ThreeAoLayer } from "./aoLayer";
import { DEFAULT_AO_SETTINGS } from "./index";
import { mountAmbientOcclusion, type AmbientOcclusionMountSettings } from "./mount";
import { AO_LAYER_ID, ambientOcclusionRecord } from "./records";

const SETTINGS: AmbientOcclusionMountSettings = {
  ao: DEFAULT_AO_SETTINGS,
  extrusion: { visible: true, heightScale: 1, minHeight: 0 },
};

const BUILDINGS: BuildingSource = { tileJson: "https://example.test/b.json", sourceLayer: "building", attribution: "" };

const mount = () => {
  const f = fakeMap();
  return { f, m: mountAmbientOcclusion({ map: f.map, graph: createGraph() }, { buildings: BUILDINGS }, SETTINGS) };
};

describe("mountAmbientOcclusion", () => {
  test("syncs the record the builder makes, hidden with the extrusion it shades", () => {
    const { m } = mount();
    expect(m.prepareSync()).toEqual([ambientOcclusionRecord(SETTINGS.ao, SETTINGS.extrusion)]);
    m.update({ ...SETTINGS, extrusion: { ...SETTINGS.extrusion, visible: false } });
    expect(m.prepareSync()[0].visible).toBe(false);
    m.dispose();
  });

  test("adds the custom layer, and re-adds it after a style reset", () => {
    const { f, m } = mount();
    m.prepareSync();
    f.resetStyle();
    m.prepareSync();
    expect(f.added).toEqual([AO_NATIVE_LAYER_ID, AO_NATIVE_LAYER_ID]);
    m.dispose();
  });

  test("registers the paint bridge on mount and clears it on dispose", () => {
    const { m } = mount();
    expect(getExternalNativePaintBridge(AO_LAYER_ID)).toBeDefined();
    m.dispose();
    expect(getExternalNativePaintBridge(AO_LAYER_ID)).toBeUndefined();
  });

  test("sets the parameters only when one of them, or the extrusion's shape, changed", () => {
    const setParams = vi.spyOn(ThreeAoLayer.prototype, "setParams");
    const { m } = mount();
    setParams.mockClear();
    m.update({ ...SETTINGS, extrusion: { ...SETTINGS.extrusion, visible: false } });
    expect(setParams).not.toHaveBeenCalled();
    m.update({ ...SETTINGS, extrusion: { ...SETTINGS.extrusion, minHeight: 20 } });
    expect(setParams).toHaveBeenCalledWith({ intensity: 1, radiusM: 6, heightScale: 1, minHeight: 20 });
    m.dispose();
    vi.restoreAllMocks();
  });
});
