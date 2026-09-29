import { describe, expect, test, vi } from "vitest";
import type { CustomLayerInterface } from "maplibre-gl";
import { getExternalNativePaintBridge } from "@geolibre/core";
import { changed, nativeLayer } from "./index";
import { fakeMap } from "./fakeMap";

const custom = { id: "fake-native", type: "custom", render: () => {} } as CustomLayerInterface;

describe("nativeLayer", () => {
  test("adds the custom layer exactly when the style lacks it", () => {
    const f = fakeMap();
    const native = nativeLayer(f.map, "fake", custom, {});
    native.ensureAdded();
    native.ensureAdded();
    expect(f.added).toEqual(["fake-native"]);
    f.resetStyle();
    native.ensureAdded();
    expect(f.added).toEqual(["fake-native", "fake-native"]);
    native.dispose();
  });

  test("registers the paint bridge at once and clears it on dispose", () => {
    const f = fakeMap();
    const setOpacity = vi.fn();
    const native = nativeLayer(f.map, "fake", custom, { setOpacity });
    getExternalNativePaintBridge("fake")?.setOpacity?.(0.5);
    expect(setOpacity).toHaveBeenCalledWith(0.5);
    native.dispose();
    expect(getExternalNativePaintBridge("fake")).toBeUndefined();
  });
});

describe("changed", () => {
  test("is true on the first settings, and then only for a key that moved", () => {
    const a = { x: 1, y: 2 };
    expect(changed(null, a, "x")).toBe(true);
    expect(changed(a, { x: 1, y: 3 }, "x")).toBe(false);
    expect(changed(a, { x: 1, y: 3 }, "x", "y")).toBe(true);
  });
});
