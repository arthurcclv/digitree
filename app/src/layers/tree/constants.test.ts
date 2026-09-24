import { describe, expect, test } from "vitest";
import { TREES_TOTAL } from "./constants";

describe("TREES_TOTAL", () => {
  test("is the size of the surveyed inventory infra/ loads", () => {
    expect(TREES_TOTAL).toBe(162_930);
  });

  // The panel prints it, and a bare `toLocaleString()` would group it by
  // whichever locale the browser happens to run in — 162.930 on a German one,
  // which reads as a decimal. The readout pins the locale; this pins the shape.
  test("prints grouped, in the panel's locale", () => {
    expect(TREES_TOTAL.toLocaleString("en-US")).toBe("162,930");
  });
});
