import { describe, expect, test, vi } from "vitest";
import { createGraph } from "../../lib/dag";
import { EXPORT_MAX_CELLS, exportGridFor, fromLocal, makeDomain, cellM } from "./frame";
import { exportTiles, FETCH_MARGIN_M, tileOfLngLat, tileSquareLocal } from "./tileGrid";
import { ThreeSunlightLayer } from "./sunlightLayer";
import { LPI_NODE } from "./lpi";

describe("the export grid", () => {
  test("is 0.5 m cells up to a 2,048 m side, then 4,096 cells stretched over it", () => {
    expect(exportGridFor(500, EXPORT_MAX_CELLS)).toEqual({ domainM: 500, size: 1000 });
    expect(exportGridFor(2000, EXPORT_MAX_CELLS)).toEqual({ domainM: 2000, size: 4000 });
    expect(exportGridFor(2048, EXPORT_MAX_CELLS)).toEqual({ domainM: 2048, size: 4096 });
    const big = exportGridFor(10_000, EXPORT_MAX_CELLS);
    expect(big.size).toBe(EXPORT_MAX_CELLS);
    expect(big.domainM / big.size).toBeCloseTo(2.441, 3);
  });

  test("is capped by the GPU's texture limit", () => {
    expect(exportGridFor(2048, 2048)).toEqual({ domainM: 2048, size: 2048 });
  });

  test("fetches every tile within the frame grown by the fetch margin, and no farther", () => {
    const d = makeDomain(121.5654, 25.033, 1000, 500);
    const tiles = exportTiles(d);
    const reach = d.domainM / 2 + FETCH_MARGIN_M;
    // Every tile touches the grown square…
    for (const t of tiles) {
      const [w, s, e, n] = tileSquareLocal(d, t);
      expect(e > -reach && w < reach && n > -reach && s < reach).toBe(true);
    }
    // …and the tiles under the grown square's corners are all fetched.
    const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
    const inset = reach - 1;
    for (const [x, y] of [[-inset, -inset], [inset, inset], [-inset, inset], [inset, -inset]]) {
      const t = tileOfLngLat(...fromLocal(d, x, y));
      expect(keys.has(`${t.x}/${t.y}`)).toBe(true);
    }
    expect(cellM(d)).toBe(0.5);
    expect(tiles.length).toBeGreaterThanOrEqual(4);
  });
});

describe("readFrame", () => {
  const sources = {
    trees: { tiles: "/t/{z}/{x}/{y}", sourceLayer: "t", minzoom: 14, maxzoom: 14, bounds: [0, 0, 1, 1] as [number, number, number, number], attribution: "", name: "", sourceKind: "", fallbackHeightM: 9 },
    buildings: { tileJson: "/b", sourceLayer: "building", attribution: "", name: "", sourceKind: "" },
  };
  const frame = { centre: { lng: 121.5654, lat: 25.033 }, sizeM: 2 };

  function layer() {
    const graph = createGraph();
    graph.add(LPI_NODE, []);
    const l = new ThreeSunlightLayer(graph, sources);
    const domain = makeDomain(121.5654, 25.033, 2, 2);
    // The GPU half, stubbed: an index grid with one cell of no value.
    const pass = vi.fn(async (_frame: unknown, key: string) => ({
      key,
      domain,
      values: Float32Array.from([1, 0.5, NaN, 0]),
      sunTime: 0,
      azimuthDeg: 180,
      elevationDeg: 60,
    }));
    (l as unknown as { exportPass: typeof pass }).exportPass = pass;
    return { l, pass };
  }
  const job = (f: (v: number) => number, nodata: number) => ({ transform: f, nodata, metadata: {} });

  test("maps the index through the job, NoData where there is none", async () => {
    const { l } = layer();
    const r = await l.readFrame(frame, job((v) => v * 10, -9999));
    expect([...r.grid.values]).toEqual([10, 5, -9999, 0]);
    expect(r.grid.nodata).toBe(-9999);
    l.dispose();
  });

  test("runs one pass for both overlays of a frame and sun, and a new one when either changes", async () => {
    const { l, pass } = layer();
    await l.readFrame(frame, job((v) => v, -1));
    await l.readFrame(frame, job((v) => v * 2, -9999));
    expect(pass).toHaveBeenCalledTimes(1);
    await l.readFrame({ ...frame, sizeM: 4 }, job((v) => v, -1));
    expect(pass).toHaveBeenCalledTimes(2);
    l.setSunTime(Date.UTC(2026, 5, 21, 4));
    await l.readFrame({ ...frame, sizeM: 4 }, job((v) => v, -1));
    expect(pass).toHaveBeenCalledTimes(3);
    l.dispose();
  });

  test("joins a pass still running: two requests made together run it once", async () => {
    const { l, pass } = layer();
    const [a, b] = await Promise.all([l.readFrame(frame, job((v) => v, -1)), l.readFrame(frame, job((v) => v * 2, -9999))]);
    expect(pass).toHaveBeenCalledTimes(1);
    expect([...a.grid.values]).toEqual([1, 0.5, -1, 0]);
    expect([...b.grid.values]).toEqual([2, 1, -9999, 0]);
    l.dispose();
  });

  test("does not keep a failed pass: the next request runs a new one", async () => {
    const { l, pass } = layer();
    pass.mockRejectedValueOnce(new Error("lost"));
    await expect(l.readFrame(frame, job((v) => v, -1))).rejects.toThrow("lost");
    await l.readFrame(frame, job((v) => v, -1));
    expect(pass).toHaveBeenCalledTimes(2);
    l.dispose();
  });
});
