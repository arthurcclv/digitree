import { describe, expect, test } from "vitest";
import { AO_INTENSITY_MAX, AO_LAYER_ID, AO_NATIVE_LAYER_ID, ambientOcclusionRecord, DEFAULT_AO_SETTINGS } from "./index";

describe("ambientOcclusionRecord", () => {
  test("is an external-native three.js record, on by default", () => {
    const r = ambientOcclusionRecord(DEFAULT_AO_SETTINGS, { visible: true });
    expect(r.id).toBe(AO_LAYER_ID);
    expect(r.visible).toBe(true);
    expect(r.metadata).toMatchObject({
      customLayerType: "threejs",
      nativeLayerIds: [AO_NATIVE_LAYER_ID],
      paintMode: "plugin",
    });
    expect(r.source).toEqual({});
  });

  test("defaults to full intensity, within the panel's range", () => {
    expect(DEFAULT_AO_SETTINGS.intensity).toBe(1);
    expect(DEFAULT_AO_SETTINGS.intensity).toBeLessThanOrEqual(AO_INTENSITY_MAX);
  });

  test("is hidden when either the setting or the buildings are off", () => {
    expect(ambientOcclusionRecord({ ...DEFAULT_AO_SETTINGS, enabled: false }, { visible: true }).visible).toBe(false);
    expect(ambientOcclusionRecord(DEFAULT_AO_SETTINGS, { visible: false }).visible).toBe(false);
  });
});

describe("the shaded extrusion", () => {
  // The layer reads the buildings' data through their schema, never their
  // settings: a host with another extrusion layer maps onto ShadedExtrusion.
  test("no module of the layer imports another layer's settings type", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const offenders = readdirSync(__dirname)
      .filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name))
      .filter((name) => /\b\w+Settings\b[^;]*from\s+["']\.\.\//.test(readFileSync(`${__dirname}/${name}`, "utf8")));
    expect(offenders).toEqual([]);
  });
});
