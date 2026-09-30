import { expect, test } from "vitest";
import { geoTransform3857, makeDomain } from "./frame";
import type { NearGrid } from "./lpi";
import { nearGridTiff } from "./nearGrid";

test("a grid is written as a little-endian GeoTIFF of its own size", async () => {
  const grid: NearGrid = {
    size: 4,
    values: new Float32Array(16).fill(0.5),
    nodata: -1,
    domain: makeDomain(121.5654, 25.033, 4, 1000),
    sunTime: 0,
    metadata: { sun_time: "t", cell_m: "x", definition: "d" },
  };
  const bytes = new Uint8Array(await nearGridTiff(grid).arrayBuffer());
  const v = new DataView(bytes.buffer);
  expect(String.fromCharCode(bytes[0], bytes[1])).toBe("II");
  const ifd = v.getUint32(4, true);
  const tags = new Map<number, number>();
  for (let i = 0; i < v.getUint16(ifd, true); i++) tags.set(v.getUint16(ifd + 2 + i * 12, true), v.getUint32(ifd + 10 + i * 12, true));
  expect(tags.get(256)).toBe(4);
  expect(tags.get(257)).toBe(4);
  // The cell size in the metadata is the grid's, whatever the read said.
  expect(new TextDecoder().decode(bytes)).toContain(">250<");
  expect(geoTransform3857(grid.domain).pixel).toBeGreaterThan(250);
});
