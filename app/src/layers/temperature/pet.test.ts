import { describe, expect, test } from "vitest";
import {
  classOf,
  PET_CLASSES,
  PET_RAMP,
  PET_RAMP_RGB,
  PET_RAMP_STEP,
  petGlsl,
  petOf,
  petProbeOf,
  petRampAt,
  petRange,
} from "./pet";

const defaults = { g0: 800, ta: 32, v: 1 };

describe("petOf", () => {
  test("matches the formula at the defaults", () => {
    expect(petOf(0, defaults)).toBeCloseTo(36.04, 2);
    expect(petOf(1, defaults)).toBeCloseTo(42.08, 2);
    const raw = (lpi: number, g0: number, ta: number, v: number) =>
      0.0126 * (g0 * (0.5986 * lpi + 0.0116)) + 1.2537 * ta - 2.5537 * v - 1.6374;
    expect(petOf(0.37, { g0: 640, ta: 27.5, v: 3.2 })).toBeCloseTo(raw(0.37, 640, 27.5, 3.2), 12);
  });

  test("is affine in LPI with slope 0.0126 · 0.5986 · G0", () => {
    for (const g0 of [0, 250, 1200]) {
      const p = { ...defaults, g0 };
      const slope = 0.0126 * 0.5986 * g0;
      for (const lpi of [0, 0.2, 0.5, 0.9]) {
        expect(petOf(lpi + 0.1, p) - petOf(lpi, p)).toBeCloseTo(0.1 * slope, 10);
      }
    }
  });

  test("petRange is full shade to full sun", () => {
    expect(petRange(defaults)).toEqual([petOf(0, defaults), petOf(1, defaults)]);
  });
});

describe("petGlsl", () => {
  test("the generated shader expression evaluates to petOf", () => {
    const expr = petGlsl();
    // GLSL float literals and arithmetic are valid JS, so run it as JS.
    const f = new Function("lpi", "uG0", "uTa", "uV", `return ${expr};`) as (...a: number[]) => number;
    for (const lpi of [0, 0.25, 0.5, 1]) {
      for (const g0 of [0, 800, 1200]) {
        for (const [ta, v] of [[15, 10], [32, 1], [40, 0]]) {
          expect(f(lpi, g0, ta, v)).toBeCloseTo(petOf(lpi, { g0, ta, v }), 10);
        }
      }
    }
  });

  test("every literal is a GLSL float", () => {
    // Numbers not inside an identifier (uG0).
    const literals = petGlsl().match(/(?<![\w.])\d+(\.\d+)?/g)!;
    expect(literals).toHaveLength(6);
    for (const l of literals) expect(l).toContain(".");
  });
});

describe("ramp", () => {
  test("stops rise evenly in PET, as the shader's indexing assumes", () => {
    for (let i = 1; i < PET_RAMP.length; i++) expect(PET_RAMP[i][0] - PET_RAMP[i - 1][0]).toBe(PET_RAMP_STEP);
    expect(PET_RAMP[0][0]).toBe(22);
    expect(PET_RAMP[PET_RAMP.length - 1][0]).toBe(46);
  });

  test("hits each stop and clamps outside 22–46 °C", () => {
    PET_RAMP.forEach(([pet], i) => {
      petRampAt(pet).forEach((c, k) => expect(c).toBeCloseTo(PET_RAMP_RGB[i][k], 10));
    });
    expect(petRampAt(0)).toEqual(petRampAt(22));
    expect(petRampAt(60)).toEqual(petRampAt(46));
  });
});

describe("classOf", () => {
  test("names each class from its lower bound, inclusive", () => {
    expect(classOf(-5)).toBe("very cold");
    expect(classOf(13.99)).toBe("very cold");
    for (const { from, cls } of PET_CLASSES.slice(1)) {
      expect(classOf(from)).toBe(cls);
      expect(classOf(from + 1.5)).toBe(cls);
    }
    expect(classOf(29.9)).toBe("neutral");
    expect(classOf(55)).toBe("very hot");
  });
});

describe("petProbeOf", () => {
  test("answers a value in PET, from the same point's LPI", () => {
    expect(petProbeOf({ kind: "value", index: 0.5 }, defaults)).toEqual({
      kind: "value",
      lpi: 0.5,
      pet: petOf(0.5, defaults),
      cls: classOf(petOf(0.5, defaults)),
    });
  });

  test("passes every non-value through", () => {
    for (const kind of ["roof", "incomplete", "outside", "none"] as const) {
      expect(petProbeOf({ kind }, defaults)).toEqual({ kind });
    }
  });
});
