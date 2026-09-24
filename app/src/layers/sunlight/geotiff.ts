/**
 * A minimal GeoTIFF writer — single band, Float32, uncompressed, stripped,
 * little-endian — for *Readouts, probe and export* in `specs/spec.md`. Written
 * by hand because the one thing needed is small and a dependency for it is not.
 *
 * Tags written, and nothing else:
 *   256 ImageWidth · 257 ImageLength · 258 BitsPerSample (32)
 *   259 Compression (1, none) · 262 Photometric (1, black is zero)
 *   273 StripOffsets · 277 SamplesPerPixel (1) · 278 RowsPerStrip
 *   279 StripByteCounts · 284 PlanarConfiguration (1) · 339 SampleFormat (3, float)
 *   33550 ModelPixelScale · 33922 ModelTiepoint · 34735 GeoKeyDirectory
 *   42112 GDAL_METADATA · 42113 GDAL_NODATA
 *
 * GeoKeys: GTModelType = projected, GTRasterType = PixelIsArea, and
 * ProjectedCSType = the given EPSG code.
 */

export interface GeoTiffInput {
  width: number;
  height: number;
  /** Row-major, row 0 at the **top** (north). */
  data: Float32Array;
  /** The top-left corner of the top-left pixel, in CRS units. */
  originX: number;
  originY: number;
  pixelSize: number;
  epsg: number;
  noData: number;
  metadata?: Record<string, string>;
}

const ROWS_PER_STRIP = 64;

type TagType = 2 | 3 | 4 | 12; // ASCII, SHORT, LONG, DOUBLE
const TYPE_SIZE: Record<TagType, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };

interface Tag {
  code: number;
  type: TagType;
  values: number[] | string;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function writeGeoTiff(input: GeoTiffInput): Uint8Array<ArrayBuffer> {
  const { width, height, data } = input;
  if (data.length !== width * height) throw new Error("data length does not match width × height");

  const strips = Math.ceil(height / ROWS_PER_STRIP);
  const stripBytes: number[] = [];
  for (let s = 0; s < strips; s++) {
    const rows = Math.min(ROWS_PER_STRIP, height - s * ROWS_PER_STRIP);
    stripBytes.push(rows * width * 4);
  }

  const tags: Tag[] = [
    { code: 256, type: 4, values: [width] },
    { code: 257, type: 4, values: [height] },
    { code: 258, type: 3, values: [32] },
    { code: 259, type: 3, values: [1] },
    { code: 262, type: 3, values: [1] },
    { code: 273, type: 4, values: new Array(strips).fill(0) }, // patched below
    { code: 277, type: 3, values: [1] },
    { code: 278, type: 4, values: [ROWS_PER_STRIP] },
    { code: 279, type: 4, values: stripBytes },
    { code: 284, type: 3, values: [1] },
    { code: 339, type: 3, values: [3] },
    { code: 33550, type: 12, values: [input.pixelSize, input.pixelSize, 0] },
    { code: 33922, type: 12, values: [0, 0, 0, input.originX, input.originY, 0] },
    {
      code: 34735,
      type: 3,
      // Header (version 1.1.0, 3 keys), then key, location, count, value.
      values: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, input.epsg],
    },
  ];
  if (input.metadata && Object.keys(input.metadata).length) {
    const items = Object.entries(input.metadata)
      .map(([k, v]) => `<Item name="${escapeXml(k)}">${escapeXml(v)}</Item>`)
      .join("");
    tags.push({ code: 42112, type: 2, values: `<GDALMetadata>${items}</GDALMetadata>` });
  }
  tags.push({ code: 42113, type: 2, values: String(input.noData) });

  const count = (t: Tag) => (typeof t.values === "string" ? t.values.length + 1 : t.values.length);
  const bytesOf = (t: Tag) => count(t) * TYPE_SIZE[t.type];

  // Layout: header (8) · IFD · out-of-line tag values · pixel strips.
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 0;
  for (const t of tags) if (bytesOf(t) > 4) extra += bytesOf(t) + (bytesOf(t) % 2);
  const pixelsAt = 8 + ifdSize + extra;
  const total = pixelsAt + width * height * 4;

  // Strip offsets are known now.
  const offsets = tags.find((t) => t.code === 273)!;
  let at = pixelsAt;
  offsets.values = stripBytes.map((b) => {
    const o = at;
    at += b;
    return o;
  });

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  const writeValues = (t: Tag, offset: number) => {
    if (typeof t.values === "string") {
      for (let i = 0; i < t.values.length; i++) view.setUint8(offset + i, t.values.charCodeAt(i) & 0x7f);
      view.setUint8(offset + t.values.length, 0);
      return;
    }
    t.values.forEach((v, i) => {
      const o = offset + i * TYPE_SIZE[t.type];
      if (t.type === 3) view.setUint16(o, v, true);
      else if (t.type === 4) view.setUint32(o, v, true);
      else view.setFloat64(o, v, true);
    });
  };

  let p = 8;
  view.setUint16(p, tags.length, true);
  p += 2;
  let valuesAt = 8 + ifdSize;
  for (const t of tags) {
    view.setUint16(p, t.code, true);
    view.setUint16(p + 2, t.type, true);
    view.setUint32(p + 4, count(t), true);
    if (bytesOf(t) <= 4) {
      writeValues(t, p + 8);
    } else {
      view.setUint32(p + 8, valuesAt, true);
      writeValues(t, valuesAt);
      valuesAt += bytesOf(t) + (bytesOf(t) % 2);
    }
    p += 12;
  }
  view.setUint32(p, 0, true); // no further IFD

  // Float32 little-endian; the platform is little-endian everywhere this runs,
  // but go through DataView rather than assume it.
  for (let i = 0; i < data.length; i++) view.setFloat32(pixelsAt + i * 4, data[i], true);
  return bytes;
}
