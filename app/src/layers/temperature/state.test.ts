import { describe, expect, test } from "vitest";
import { temperatureState } from "./state";

describe("temperatureState", () => {
  test("is off when hidden, whatever the direct-sun layer is doing", () => {
    expect(temperatureState(false, "ready")).toBe("off");
    expect(temperatureState(false, "low-sun")).toBe("off");
  });

  test("follows the direct-sun state when shown", () => {
    for (const s of ["zoom", "low-sun", "unsupported", "waiting", "ready"] as const) {
      expect(temperatureState(true, s)).toBe(s);
    }
  });

  test("waits while its demand has not yet reached the direct-sun layer", () => {
    expect(temperatureState(true, "off")).toBe("waiting");
  });
});
