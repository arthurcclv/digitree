import { expect, test } from "vitest";
import { hexRgb, interpolateStops, srgbToLinear, type Rgb } from "./colour";

test("hexRgb reads #rrggbb as sRGB 0–1", () => {
  expect(hexRgb("#ff8000")).toEqual([1, 128 / 255, 0]);
});

test("srgbToLinear is the sRGB transfer function: linear toe, then the 2.4 power", () => {
  expect(srgbToLinear([0, 1, 0.04])).toEqual([0, 1, 0.04 / 12.92]);
  expect(srgbToLinear([0.5, 0.5, 0.5])[0]).toBeCloseTo(0.214, 3);
});

test("interpolateStops is linear between stops and clamps beyond the ends", () => {
  const black: Rgb = [0, 0, 0];
  const white: Rgb = [1, 1, 1];
  const red: Rgb = [1, 0, 0];
  const stops = [[0, black], [10, white], [30, red]] as const;
  expect(interpolateStops(stops, -5)).toEqual(black);
  expect(interpolateStops(stops, 5)).toEqual([0.5, 0.5, 0.5]);
  expect(interpolateStops(stops, 20)).toEqual([1, 0.5, 0.5]);
  expect(interpolateStops(stops, 99)).toEqual(red);
});
