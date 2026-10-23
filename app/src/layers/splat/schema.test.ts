import { describe, expect, test } from "vitest";
import { lngLatToMercator, type TileGeometry } from "../../lib/tiles";
import {
  lodUrlOf,
  splatOf,
  splatsIn,
  type Splat,
  type SplatSource,
} from "./schema";

const PROPS = { splat_id: "KY0917A", file: "KY0917A.spz", bytes: 40422461, altitude_m: 0.4, heading_deg: 30, scale: 1.01 };
const point = (lng: number, lat: number) => () => ({ type: "Point", coordinates: [lng, lat] }) as TileGeometry;

const splat = (id: string, lng: number, lat: number): Splat => ({
  id,
  file: `${id}.spz`,
  lngLat: [lng, lat],
  altitudeM: 0,
  headingDeg: 0,
  scale: 1,
  bytes: 1,
});

describe("splatOf", () => {
  test("reads every published property", () => {
    expect(splatOf(PROPS, point(121.539, 25.0386))).toEqual({
      id: "KY0917A",
      file: "KY0917A.spz",
      lngLat: [121.539, 25.0386],
      altitudeM: 0.4,
      headingDeg: 30,
      scale: 1.01,
      bytes: 40422461,
    });
  });

  test.each([
    ["no id", { ...PROPS, splat_id: undefined }],
    ["an empty id", { ...PROPS, splat_id: "" }],
    ["no file", { ...PROPS, file: undefined }],
    ["a path for a file", { ...PROPS, file: "../KY0917A.spz" }],
    ["a text heading", { ...PROPS, heading_deg: "30" }],
    ["a non-finite altitude", { ...PROPS, altitude_m: Number.NaN }],
    ["a zero scale", { ...PROPS, scale: 0 }],
    ["no bytes", { ...PROPS, bytes: undefined }],
  ])("drops a feature with %s", (_, props) => {
    expect(splatOf(props as Record<string, unknown>, point(121.539, 25.0386))).toBeNull();
  });

  test("drops a feature that is not a point", () => {
    const line = () => ({ type: "LineString", coordinates: [[0, 0], [1, 1]] }) as TileGeometry;
    expect(splatOf(PROPS, line)).toBeNull();
  });
});

// The name rule infra's loader checks (`04_splats.sql`, *its LoD*): File less
// its last extension, plus -lod.rad.
describe("lodUrlOf", () => {
  const source = { lodFiles: "/files/3dgs-lod/" } as SplatSource;
  const url = (file: string) => lodUrlOf(source, { file });

  test("is the descriptor's lodFiles plus <stem>-lod.rad", () => {
    expect(url("KZ0918-075047.spz")).toBe("/files/3dgs-lod/KZ0918-075047-lod.rad");
  });
  test("drops only the last extension", () => {
    expect(url("scan.ply")).toBe("/files/3dgs-lod/scan-lod.rad");
    expect(url("a.b.spz")).toBe("/files/3dgs-lod/a.b-lod.rad");
  });
  test("keeps a stem that already says -lod", () => {
    expect(url("x-lod.spz")).toBe("/files/3dgs-lod/x-lod-lod.rad");
  });
  test("encodes the name", () => {
    expect(url("KY 0917A.spz")).toBe("/files/3dgs-lod/KY%200917A-lod.rad");
  });
});

describe("splatsIn", () => {
  test("keeps each capture once, nearest the centre first", () => {
    const far = splat("far", 121.55, 25.04);
    const near = splat("near", 121.5391, 25.0386);
    const centre = lngLatToMercator(121.539, 25.0386);
    expect(splatsIn([[far, near], [near]], centre).map((s) => s.id)).toEqual(["near", "far"]);
  });
});
