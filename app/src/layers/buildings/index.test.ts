import { describe, expect, test } from "vitest";
import { BASEMAPS } from "../basemaps";
import { buildingsLayer, DEFAULT_BUILDING_SETTINGS, PALETTES } from "./index";

describe("default settings", () => {
  test("paint flat — no ramp is reachable from the UI", () => {
    expect(DEFAULT_BUILDING_SETTINGS.paletteId).toBeNull();
  });

  test("carry the initial basemap's building colour", () => {
    // The app patches `flatColor` only when the basemap *changes*, so a
    // default that disagrees with BASEMAPS[0] paints the first frame for the
    // wrong ground. See both specs.
    expect(DEFAULT_BUILDING_SETTINGS.flatColor).toBe(BASEMAPS[0].buildingColor);
  });
});

describe("buildingsLayer", () => {
  test("disables advanced styling and paints flatColor when there is no palette", () => {
    const { style } = buildingsLayer(DEFAULT_BUILDING_SETTINGS);
    expect(style.extrusionAdvancedStyleEnabled).toBe(false);
    expect(style.extrusionColorExpression).toBe("");
    expect(style.extrusionColor).toBe(DEFAULT_BUILDING_SETTINGS.flatColor);
  });

  test("an unknown palette id falls back to flat rather than throwing", () => {
    const { style } = buildingsLayer({ ...DEFAULT_BUILDING_SETTINGS, paletteId: "no-such-ramp" });
    expect(style.extrusionAdvancedStyleEnabled).toBe(false);
    expect(style.extrusionColor).toBe(DEFAULT_BUILDING_SETTINGS.flatColor);
  });

  // The ramps outlive the panel that chose them: no control sets `paletteId`
  // today, but the expression stays part of this layer's contract.
  test("still compiles a ramp for a caller that sets paletteId", () => {
    const palette = PALETTES[0];
    const { style } = buildingsLayer({
      ...DEFAULT_BUILDING_SETTINGS,
      paletteId: palette.id,
      heightScale: 3,
    });

    expect(style.extrusionAdvancedStyleEnabled).toBe(true);
    expect(JSON.parse(style.extrusionColorExpression as string)).toEqual([
      "interpolate",
      ["linear"],
      ["to-number", ["get", "render_height"], 0],
      ...palette.stops.flat(),
    ]);
  });
});
