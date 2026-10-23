import { describe, expect, test } from "vitest";
import { DEFAULT_LAYER_STYLE } from "@geolibre/core";
import { DEFAULT_SPLAT_SETTINGS } from "./index";
import { SPLAT_LAYER_ID, SPLAT_NATIVE_LAYER_ID } from "./constants";
import { splatRecord } from "./records";

describe("splatRecord", () => {
  test("is an external-native gaussian-splat record", () => {
    expect(splatRecord({ ...DEFAULT_SPLAT_SETTINGS, visible: true, opacity: 0.6 })).toEqual({
      id: SPLAT_LAYER_ID,
      name: "Gaussian splats · three.js",
      type: "gaussian-splat",
      source: {},
      visible: true,
      opacity: 0.6,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {
        customLayerType: "threejs",
        nativeLayerIds: [SPLAT_NATIVE_LAYER_ID],
        paintMode: "plugin",
      },
    });
  });
});
