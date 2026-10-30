import { describe, expect, test } from "vitest";
import { DEFAULT_SPLAT_SETTINGS, SPLAT_MIN_ZOOM } from "./index";
import { splatStatus } from "./state";

describe("DEFAULT_SPLAT_SETTINGS", () => {
  test("hidden, opaque, from the layer's min zoom, at Spark's platform budget, each tile on its own ground", () => {
    expect(DEFAULT_SPLAT_SETTINGS).toEqual({
      visible: false,
      opacity: 1,
      minZoom: SPLAT_MIN_ZOOM,
      lodSplatCount: null,
      lodSplatScale: 1,
      snapToGround: true,
    });
  });
});

describe("splatStatus", () => {
  const err = { id: "a", message: "HTTP 404" };
  const status = (known: number, loaded: number, loading: string | null, errors: (typeof err)[], platformBudget: number | null = null) =>
    splatStatus({ known, loaded, loading, errors, platformBudget });

  test.each([
    ["idle", 0, 0, null, []],
    ["loading", 2, 0, "a", []],
    ["ready", 2, 1, null, [err]],
    ["error", 1, 0, null, [err]],
  ] as const)("%s", (state, known, loaded, loading, errors) => {
    expect(status(known, loaded, loading, [...errors]).state).toBe(state);
  });

  test("carries the platform budget once known", () => {
    expect(status(0, 0, null, []).platformBudget).toBeNull();
    expect(status(1, 1, null, [], 2_500_000).platformBudget).toBe(2_500_000);
  });
});
