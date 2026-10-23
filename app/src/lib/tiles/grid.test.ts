import { describe, expect, test } from "vitest";
import { trueMetreAxes } from "./grid";

describe("trueMetreAxes", () => {
  // Computed outside the app (double precision, from a, f and R). At the
  // equator they are the closed forms R/a and R·a/b², b = a·(1 − f).
  test.each([
    [0, 0.9988824009267909, 1.0056143656137544],
    [25.04, 0.998283271388187, 1.0038059486253645],
    [60, 0.9963716586027896, 0.9980504194896022],
  ])("at %d° is %d east, %d north", (lat, east, north) => {
    const axes = trueMetreAxes(lat);
    expect(Math.abs(axes.east - east)).toBeLessThan(1e-9);
    expect(Math.abs(axes.north - north)).toBeLessThan(1e-9);
  });

  test("the equator's closed forms", () => {
    const a = 6_378_137;
    const b = a * (1 - 1 / 298.257223563);
    const R = 6_371_008.8;
    expect(trueMetreAxes(0).east).toBeCloseTo(R / a, 12);
    expect(trueMetreAxes(0).north).toBeCloseTo((R * a) / (b * b), 12);
  });

  // N ≥ a > R, so east is always under 1; M < N off the poles, so east < north.
  // North is not always over 1: M passes R near 48°.
  test("east is under 1 and under north, north or south", () => {
    for (let lat = -89; lat <= 89; lat += 1) {
      const { east, north } = trueMetreAxes(lat);
      expect(east).toBeLessThan(1);
      expect(east).toBeLessThan(north);
    }
  });
});
