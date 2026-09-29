import { describe, expect, test, vi } from "vitest";
import { getExternalNativePaintBridge } from "@geolibre/core";
import type { BuildingSource } from "../buildings";
import { createGraph } from "../../lib/dag";
import { ThreeLayer } from "../../lib/three";
import { fakeMap } from "../../lib/mount/fakeMap";
import { AO_NATIVE_LAYER_ID, ThreeAoLayer } from "./aoLayer";
import { DEFAULT_AO_SETTINGS } from "./index";
import { mountAmbientOcclusion, type AmbientOcclusionMountSettings } from "./mount";
import { AO_LAYER_ID, ambientOcclusionRecord } from "./records";

const SETTINGS: AmbientOcclusionMountSettings = {
  ao: DEFAULT_AO_SETTINGS,
  extrusion: { visible: true, heightScale: 1, minHeight: 0 },
};

const BUILDINGS: BuildingSource = { tileJson: "https://example.test/b.json", sourceLayer: "building", attribution: "", name: "", sourceKind: "" };

const mount = () => {
  const f = fakeMap();
  return { f, m: mountAmbientOcclusion({ map: f.map, graph: createGraph() }, { buildings: BUILDINGS }, SETTINGS) };
};

describe("mountAmbientOcclusion", () => {
  // A new member is how a host would push layer-specific state in (a setter);
  // it means changing the factory table in the mount spec first (invariant 8).
  test("exposes exactly its members", () => {
    const { m } = mount();
    expect(Object.keys(m).sort()).toEqual(["dispose", "prepareSync", "update"]);
    m.dispose();
  });

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

// See `src/lib/three/specs/spec.md`, invariant 8: MapLibre gives a layer with a
// `prerender` an offscreen pass, so it must have one exactly when it needs it.
describe("ThreeAoLayer", () => {
  test("is a ThreeLayer, with a prerender", () => {
    expect(ThreeAoLayer.prototype).toBeInstanceOf(ThreeLayer);
    expect("prerender" in ThreeAoLayer.prototype).toBe(true);
  });
});
