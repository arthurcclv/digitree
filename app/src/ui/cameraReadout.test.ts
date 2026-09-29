import { describe, expect, test } from "vitest";
import { cameraReadout, formatCoord, formatZoom } from "./cameraReadout";

describe("formatCoord", () => {
  test("states the hemisphere and drops the sign", () => {
    expect(formatCoord(25.03391, "lat")).toBe("25.0339° N");
    expect(formatCoord(-33.8688, "lat")).toBe("33.8688° S");
    expect(formatCoord(121.56451, "lng")).toBe("121.5645° E");
    expect(formatCoord(-0.1276, "lng")).toBe("0.1276° W");
  });

  test("keeps four decimals, padded", () => {
    expect(formatCoord(25, "lat")).toBe("25.0000° N");
  });
});

describe("formatZoom", () => {
  test("keeps two decimals", () => {
    expect(formatZoom(15.2)).toBe("15.20");
    expect(formatZoom(16.456)).toBe("16.46");
  });
});

describe("cameraReadout", () => {
  test("is lat, lon, zoom and nothing else; only zoom is labelled", () => {
    expect(cameraReadout({ lat: 25.0339, lng: 121.5645, zoom: 15.2 })).toEqual([
      { v: "25.0339° N" },
      { v: "121.5645° E" },
      { k: "Zoom", v: "15.20" },
    ]);
  });
});
