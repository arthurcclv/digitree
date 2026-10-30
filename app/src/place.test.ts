import { describe, expect, test } from "vitest";
import { PLACE } from "./place";

describe("PLACE", () => {
  test("is Taipei, at a fixed UTC+8", () => {
    expect(PLACE).toMatchObject({ name: "Taipei", timeZone: "Asia/Taipei", utcOffsetMin: 480 });
  });

  test("starts at the Da'an view, facing north", () => {
    expect(PLACE.home).toEqual({
      id: "daan",
      label: "Da'an",
      sub: "大安 · Taipei",
      center: [121.539873, 25.039784],
      zoom: 17.36,
      pitch: 66,
      bearing: 0,
    });
  });

  test("offers 05:00 to 19:00 in the panel", () => {
    expect(PLACE.daylight).toEqual({ fromMin: 300, toMin: 1140 });
  });
});
