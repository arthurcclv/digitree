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
