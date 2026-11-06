import { describe, expect, test } from "vitest";
import type { SplatStatus } from "../layers/splat";
import { splatStateText } from "./splatStateText";

const status = (s: Partial<SplatStatus>): SplatStatus => ({
  state: "ready",
  known: 0,
  loaded: 0,
  loading: [],
  errors: [],
  platformBudget: null,
  ...s,
});

describe("splatStateText", () => {
  test("below the min zoom, asks to zoom in, whatever the status", () => {
    expect(splatStateText(status({ state: "loading", loading: ["a"] }), 15, 14.9)).toBe("zoom in to z15");
  });

  test("with no status or none known, says none in view", () => {
    expect(splatStateText(null, 15, 16)).toBe("none in view");
    expect(splatStateText(status({ state: "idle" }), 15, 16)).toBe("none in view");
  });

  test("names the one loading capture", () => {
    expect(splatStateText(status({ state: "loading", loading: ["a"], loaded: 2, known: 5 }), 15, 16)).toBe(
      "loading a (2/5)",
    );
  });

  test("counts several loading captures", () => {
    expect(
      splatStateText(status({ state: "loading", loading: ["a", "b", "c"], loaded: 2, known: 5 }), 15, 16),
    ).toBe("loading 3 (2/5)");
  });

  test("when ready, counts loaded and failed", () => {
    expect(splatStateText(status({ loaded: 4, known: 4 }), 15, 16)).toBe("4/4 loaded");
    expect(splatStateText(status({ loaded: 3, known: 4, errors: [{ id: "x", message: "404" }] }), 15, 16)).toBe(
      "3/4 loaded · 1 failed",
    );
  });
});
