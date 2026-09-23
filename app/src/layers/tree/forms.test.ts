import { describe, expect, test } from "vitest";
import { formOf, SPECIES_FORMS, type TreeForm } from "./forms";

/** The eight classes `specs/spec.md` defines. Changing this is a spec change. */
const FORMS: readonly TreeForm[] = [
  "spreading",
  "upright",
  "tiered",
  "columnar",
  "conic",
  "palm-feather",
  "palm-fan",
  "generic",
];

describe("formOf", () => {
  test("resolves a classified species to its form", () => {
    expect(formOf("榕樹")).toBe("spreading");
    expect(formOf("黑板樹")).toBe("tiered");
    expect(formOf("蒲葵")).toBe("palm-fan");
    expect(formOf("大王椰子")).toBe("palm-feather");
    expect(formOf("龍柏")).toBe("columnar");
    expect(formOf("落羽杉")).toBe("conic");
  });

  test("holds the contested assignments the spec calls out", () => {
    // Each of these is a judgement recorded in the spec, not a fact about the
    // data — a change here has to change the spec's list too.
    expect(formOf("楓香")).toBe("upright");
    expect(formOf("木棉")).toBe("tiered");
    expect(formOf("阿勃勒")).toBe("spreading");
  });

  test("classifies by shape, not by taxonomy", () => {
    // 福木 is a broadleaf, 竹柏 and 羅漢松 are podocarps, 龍柏 is a cypress.
    // One silhouette, four families — the reason the classes are not taxa.
    for (const species of ["福木", "竹柏", "羅漢松", "龍柏"]) {
      expect(formOf(species)).toBe("columnar");
    }
  });

  test("falls back to generic for everything it does not name", () => {
    expect(formOf("臺灣杉")).toBe("generic"); // a real tree, simply unclassified
    expect(formOf("")).toBe("generic");
    expect(formOf(null)).toBe("generic"); // the 18 rows carrying no species
    expect(formOf(undefined)).toBe("generic");
    expect(formOf(42)).toBe("generic");
  });

  test("never guesses from a substring or a genus", () => {
    // 榕樹 is classified; these share its characters and are not.
    expect(formOf("榕")).toBe("generic");
    expect(formOf("榕樹X")).toBe("generic");
    expect(formOf(" 榕樹")).toBe("generic");
  });
});

describe("SPECIES_FORMS", () => {
  test("carries the 100 species the spec claims", () => {
    // A duplicated key would silently collapse in the object literal and show
    // up here as a short count.
    expect(Object.keys(SPECIES_FORMS)).toHaveLength(100);
  });

  test("splits them the way the spec's table does", () => {
    const counts = new Map<TreeForm, number>();
    for (const form of Object.values(SPECIES_FORMS)) {
      counts.set(form, (counts.get(form) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      spreading: 44,
      upright: 30,
      tiered: 5,
      columnar: 10,
      conic: 5,
      "palm-feather": 4,
      "palm-fan": 2,
    });
  });

  test("never names generic explicitly — it is the fallback only", () => {
    expect(Object.values(SPECIES_FORMS)).not.toContain("generic");
  });

  test("uses only forms the layer can draw", () => {
    for (const form of Object.values(SPECIES_FORMS)) {
      expect(FORMS).toContain(form);
    }
  });

  test("keys are exact — matching depends on it", () => {
    for (const species of Object.keys(SPECIES_FORMS)) {
      expect(species).toBe(species.trim());
      expect(species).not.toBe("");
      expect(species).not.toMatch(/\s/);
    }
  });
});
