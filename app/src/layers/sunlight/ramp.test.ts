import { describe, expect, test } from "vitest";
import { hexRgb } from "../../lib/colour";
import { SUNLIGHT_RAMP, sunlightRampAt } from "./ramp";

// The spec's *Ramp* table, restated here so the table and the code are checked against each other.
const SPEC = [
  [0, "#2b2f6b"],
  [0.25, "#5a4f9c"],
  [0.5, "#a0679e"],
  [0.75, "#e39a6d"],
  [1, "#ffe3a1"],
] as const;

describe("the direct-sun ramp", () => {
  test("is the spec's table", () => {
    expect(SUNLIGHT_RAMP).toEqual(SPEC);
  });

  test("its JS twin hits each stop, interpolates linearly, and clamps", () => {
    for (const [index, hex] of SPEC) expect(sunlightRampAt(index)).toEqual(hexRgb(hex));
    const [a, b] = [hexRgb(SPEC[1][1]), hexRgb(SPEC[2][1])];
    const mid = sunlightRampAt(0.375);
    for (let k = 0; k < 3; k++) expect(mid[k]).toBeCloseTo((a[k] + b[k]) / 2, 12);
    expect(sunlightRampAt(-1)).toEqual(hexRgb(SPEC[0][1]));
    expect(sunlightRampAt(2)).toEqual(hexRgb(SPEC[4][1]));
  });
});
