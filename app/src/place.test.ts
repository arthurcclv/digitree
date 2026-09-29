import { describe, expect, test } from "vitest";
import { PLACE } from "./place";

// Pins what the app showed before the place moved out of the layers.
describe("PLACE", () => {
  test("is Taipei, at a fixed UTC+8", () => {
    expect(PLACE).toMatchObject({ name: "Taipei", timeZone: "Asia/Taipei", utcOffsetMin: 480 });
  });

  test("starts at the Xinyi view", () => {
    expect(PLACE.home).toEqual({
      id: "xinyi",
      label: "Xinyi",
      sub: "信義 · Taipei 101",
      center: [121.5608, 25.0345],
      zoom: 15.4,
      pitch: 66,
      bearing: -28,
    });
  });

  test("offers 05:00 to 19:00 in the panel", () => {
    expect(PLACE.daylight).toEqual({ fromMin: 300, toMin: 1140 });
  });
});
