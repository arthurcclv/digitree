import { describe, expect, test } from "vitest";
import { TREE_FORMS } from "../tree";
import { alphaOf, BUILDING_TAU, FORM_ALPHA, SPECIES_ALPHA, tauOf } from "./transmittance";

describe("transmittance", () => {
  test("every table value is a fraction", () => {
    for (const v of [...Object.values(FORM_ALPHA), ...Object.values(SPECIES_ALPHA)]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("names every form", () => {
    expect(Object.keys(FORM_ALPHA).sort()).toEqual([...TREE_FORMS].sort());
  });

  test("falls back to the form's default for an unlisted or missing species", () => {
    expect(alphaOf("榕樹")).toBe(FORM_ALPHA.spreading);
    expect(alphaOf("no such tree")).toBe(FORM_ALPHA.generic);
    expect(alphaOf(null)).toBe(FORM_ALPHA.generic);
  });

  test("τ is −ln α, with opaque mapped to the building τ", () => {
    expect(tauOf(0.5)).toBeCloseTo(Math.LN2, 12);
    expect(tauOf(1)).toBe(-0);
    expect(tauOf(0)).toBe(BUILDING_TAU);
    // Two crowns multiply: τ adds.
    expect(Math.exp(-(tauOf(0.5) + tauOf(0.5)))).toBeCloseTo(0.25, 12);
  });
});
