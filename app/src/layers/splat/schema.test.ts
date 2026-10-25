import { PbfWriter } from "pbf";
import { describe, expect, test } from "vitest";
import { decodeMvt, lngLatToMercator, tileOfLngLat, type TileGeometry, type TileId } from "../../lib/tiles";
import {
  lodUrlOf,
  splatOf,
  splatsIn,
  type Splat,
  type SplatSource,
} from "./schema";

// KZ0918-093638's solved origin, to the last bit the table holds.
const LNG = 121.5403129;
const LAT = 25.04008900123;
const PROPS = {
  splat_id: "KY0917A",
  file: "KY0917A.spz",
  bytes: 40422461,
  altitude_m: 0.4,
  heading_deg: 30,
  scale: 1.01,
  lng: LNG,
  lat: LAT,
};

/**
 * One-feature MVT for the `splats` layer, as Martin writes it: the point on
 * the tile's 4096 grid, `lng`/`lat` as doubles and the rest as Martin types
 * them. No MVT encoder is a dependency, so the few fields are written by hand
 * (vector_tile.proto, version 2).
 */
function splatsTile(t: TileId, props: Record<string, string | number>): ArrayBuffer {
  const EXTENT = 4096;
  const m = lngLatToMercator(props.lng as number, props.lat as number);
  const n = 2 ** t.z;
  const x = Math.round((m.x * n - t.x) * EXTENT);
  const y = Math.round((m.y * n - t.y) * EXTENT);
  const zigzag = (v: number) => (v << 1) ^ (v >> 31);
  const keys = Object.keys(props);
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_: unknown, layer: PbfWriter) => {
    layer.writeVarintField(15, 2);
    layer.writeStringField(1, "splats");
    layer.writeMessage(2, (_: unknown, f: PbfWriter) => {
      f.writeVarintField(1, 1);
      f.writePackedVarint(2, keys.flatMap((_, i) => [i, i]));
      f.writeVarintField(3, 1);
      f.writePackedVarint(4, [9, zigzag(x), zigzag(y)]);
    }, null);
    for (const k of keys) layer.writeStringField(3, k);
    for (const k of keys) {
      const v = props[k];
      layer.writeMessage(4, (_: unknown, w: PbfWriter) => {
        if (typeof v === "string") w.writeStringField(1, v);
        else if (k === "lng" || k === "lat") w.writeDoubleField(3, v);
        else if (Number.isInteger(v)) w.writeVarintField(5, v);
        else w.writeFloatField(2, v);
      }, null);
    }
    layer.writeVarintField(5, EXTENT);
  }, null);
  const out = pbf.finish();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

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
    expect(splatOf(PROPS)).toEqual({
      id: "KY0917A",
      file: "KY0917A.spz",
      lngLat: [LNG, LAT],
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
    ["no lng", { ...PROPS, lng: undefined }],
    ["no lat", { ...PROPS, lat: undefined }],
    ["a text lng", { ...PROPS, lng: "121.54" }],
    ["a non-finite lat", { ...PROPS, lat: Number.POSITIVE_INFINITY }],
    ["a lng past 180", { ...PROPS, lng: 180.5 }],
    ["a lat past Web Mercator's limit", { ...PROPS, lat: -85.1 }],
  ])("drops a feature with %s", (_, props) => {
    expect(splatOf(props as Record<string, unknown>)).toBeNull();
  });

  test("takes the origin from lng/lat, never from the geometry", () => {
    // About 0.3 m off, as a z14 point can be.
    const off = () => ({ type: "Point", coordinates: [LNG + 3e-6, LAT - 2e-6] }) as TileGeometry;
    const read = splatOf as (p: Record<string, unknown>, g: () => TileGeometry) => Splat | null;
    expect(read(PROPS, off)?.lngLat).toEqual([LNG, LAT]);
  });

  test("a z14 tile gives back the exact origin, where its point is snapped", () => {
    const t = tileOfLngLat(LNG, LAT);
    const buf = splatsTile(t, PROPS);
    const [s] = decodeMvt(buf, t, "splats", splatOf);
    expect(s.lngLat[0]).toBe(LNG);
    expect(s.lngLat[1]).toBe(LAT);
    expect(s).toMatchObject({ id: "KY0917A", file: "KY0917A.spz", bytes: 40422461 });
    // The point itself is on the 4096 grid, centimetres off: what the origin
    // used to be read from.
    const [g] = decodeMvt(buf, t, "splats", (_, geometry) => geometry());
    if (g.type !== "Point") throw new Error(`a ${g.type}, not a point`);
    const [gl, ga] = g.coordinates;
    const offM = Math.hypot((gl - LNG) * 111320 * Math.cos((LAT * Math.PI) / 180), (ga - LAT) * 110574);
    expect(offM).toBeGreaterThan(0.01);
    expect(offM).toBeLessThan(0.4);
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
