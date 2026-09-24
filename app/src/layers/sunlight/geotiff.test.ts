import { describe, expect, test } from "vitest";
import { writeGeoTiff } from "./geotiff";

/** Just enough of a TIFF reader to check what the writer claims. */
function readTiff(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(0, true)).toBe(0x4949);
  expect(view.getUint16(2, true)).toBe(42);
  const ifd = view.getUint32(4, true);
  const n = view.getUint16(ifd, true);
  const size: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const tags = new Map<number, number[] | string>();
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const code = view.getUint16(e, true);
    const type = view.getUint16(e + 2, true);
    const count = view.getUint32(e + 4, true);
    const bytesLen = count * size[type];
    const at = bytesLen <= 4 ? e + 8 : view.getUint32(e + 8, true);
    codes.push(code);
    if (type === 2) {
      let s = "";
      for (let k = 0; k < count - 1; k++) s += String.fromCharCode(view.getUint8(at + k));
      tags.set(code, s);
    } else {
      const vals: number[] = [];
      for (let k = 0; k < count; k++) {
        const o = at + k * size[type];
        vals.push(type === 3 ? view.getUint16(o, true) : type === 4 ? view.getUint32(o, true) : view.getFloat64(o, true));
      }
      tags.set(code, vals);
    }
  }
  const num = (c: number) => tags.get(c) as number[];
  const width = num(256)[0];
  const height = num(257)[0];
  const offsets = num(273);
  const pixels = new Float32Array(width * height);
  const rowsPerStrip = num(278)[0];
  offsets.forEach((off, s) => {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    for (let i = 0; i < rows * width; i++) {
      pixels[s * rowsPerStrip * width + i] = view.getFloat32(off + i * 4, true);
    }
  });
  return { codes, tags, width, height, pixels };
}

describe("writeGeoTiff", () => {
  const width = 70;
  const height = 130; // more than one strip, with a short last one
  const data = new Float32Array(width * height).map((_, i) => (i % 7 === 0 ? -1 : (i % 100) / 100));
  const bytes = writeGeoTiff({
    width,
    height,
    data,
    originX: 13_532_000.5,
    originY: 2_880_000.25,
    pixelSize: 0.5517,
    epsg: 3857,
    noData: -1,
    metadata: { sun_time: "2026-06-21T04:00:00Z", note: "a < b & c" },
  });
  const tiff = readTiff(bytes);

  test("tags are in ascending order, as TIFF requires", () => {
    expect([...tiff.codes]).toEqual([...tiff.codes].sort((a, b) => a - b));
  });

  test("size and sample format", () => {
    expect(tiff.width).toBe(width);
    expect(tiff.height).toBe(height);
    expect(tiff.tags.get(258)).toEqual([32]);
    expect(tiff.tags.get(339)).toEqual([3]);
    expect(tiff.tags.get(277)).toEqual([1]);
  });

  test("pixels come back exactly", () => {
    expect(tiff.pixels).toEqual(data);
  });

  test("georeferencing", () => {
    expect(tiff.tags.get(33550)).toEqual([0.5517, 0.5517, 0]);
    expect(tiff.tags.get(33922)).toEqual([0, 0, 0, 13_532_000.5, 2_880_000.25, 0]);
    const keys = tiff.tags.get(34735) as number[];
    // ProjectedCSType is the last key.
    expect(keys.slice(-4)).toEqual([3072, 0, 1, 3857]);
    expect(keys.slice(4, 8)).toEqual([1024, 0, 1, 1]);
  });

  test("NoData and metadata", () => {
    expect(tiff.tags.get(42113)).toBe("-1");
    expect(tiff.tags.get(42112)).toContain('<Item name="sun_time">2026-06-21T04:00:00Z</Item>');
    expect(tiff.tags.get(42112)).toContain("a &lt; b &amp; c");
  });

  test("rejects data of the wrong length", () => {
    expect(() =>
      writeGeoTiff({ width: 2, height: 2, data: new Float32Array(3), originX: 0, originY: 0, pixelSize: 1, epsg: 3857, noData: -1 }),
    ).toThrow();
  });
});
