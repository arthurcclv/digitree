import { describe, expect, test } from "vitest";
import { AO_INTENSITY_MAX, AO_NOISE_SIZE, AO_SAMPLES, aoKernel, aoNoise, compositeFactor } from "./kernel";

describe("aoKernel", () => {
  const k = aoKernel();

  test(`has ${AO_SAMPLES} samples, all in the unit +Z hemisphere`, () => {
    expect(k).toHaveLength(AO_SAMPLES);
    for (const [x, y, z] of k) {
      expect(z).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  test("crowds the centre: lengths never shrink with the index", () => {
    const lengths = k.map((v) => Math.hypot(...v));
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
  });

  test("is deterministic for a seed", () => {
    expect(aoKernel(AO_SAMPLES, 7)).toEqual(aoKernel(AO_SAMPLES, 7));
    expect(aoKernel(AO_SAMPLES, 7)).not.toEqual(aoKernel(AO_SAMPLES, 8));
  });
});

describe("aoNoise", () => {
  test("fills the rotation tile with unit vectors", () => {
    const n = aoNoise();
    expect(n).toHaveLength(AO_NOISE_SIZE * AO_NOISE_SIZE);
    for (const v of n) expect(Math.hypot(...v)).toBeCloseTo(1, 12);
  });
});

describe("compositeFactor", () => {
  test("intensity 0 leaves the frame unchanged, whatever the occlusion", () => {
    for (const ao of [0, 0.3, 1]) expect(compositeFactor(ao, 0)).toBe(1);
  });

  test("intensity 1 multiplies by the occlusion itself", () => {
    for (const ao of [0, 0.3, 1]) expect(compositeFactor(ao, 1)).toBeCloseTo(ao, 12);
  });

  test("intensity 2 doubles the darkening and clamps at black", () => {
    expect(compositeFactor(0.75, AO_INTENSITY_MAX)).toBeCloseTo(0.5, 12);
    expect(compositeFactor(0.5, AO_INTENSITY_MAX)).toBe(0);
    expect(compositeFactor(0, AO_INTENSITY_MAX)).toBe(0);
  });

  test("an unoccluded pixel is never darkened, at any intensity", () => {
    for (const i of [0, 0.6, 1, 1.5, AO_INTENSITY_MAX]) expect(compositeFactor(1, i)).toBe(1);
  });
});
