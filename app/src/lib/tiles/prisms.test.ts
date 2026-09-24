import { describe, expect, test } from "vitest";
import { tileOfLngLat } from "./grid";
import { addPrism, placeTile, TILE_UNITS, triangulateTile } from "./prisms";

/** Every undirected edge of a triangle soup, with how many triangles share it. */
function edgeCounts(tris: ArrayLike<number>): Map<string, number> {
  const key = (i: number) => `${tris[i]},${tris[i + 1]},${tris[i + 2]}`;
  const counts = new Map<string, number>();
  for (let t = 0; t < tris.length; t += 9) {
    const v = [key(t), key(t + 3), key(t + 6)];
    for (const [a, b] of [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]]) {
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
  }
  return counts;
}

describe("addPrism", () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  test("floors cover the footprint once, and the prism is closed", () => {
    const prism: number[] = [];
    const floor: number[] = [];
    addPrism([square], 20, prism, floor);
    // Two floor triangles; floor + roof + 4 walls × 2 in the prism.
    expect(floor.length / 9).toBe(2);
    expect(prism.length / 9).toBe(2 + 2 + 8);
    const area = (tris: number[]) => {
      let a = 0;
      for (let i = 0; i < tris.length; i += 9) {
        const [x1, y1, , x2, y2, , x3, y3] = tris.slice(i, i + 9);
        a += Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2;
      }
      return a;
    };
    expect(area(floor)).toBeCloseTo(100, 9);
    // Every z is the ground or the roof.
    for (let i = 2; i < prism.length; i += 3) expect([0, 20]).toContain(prism[i]);
  });

  test("a hole is left out of the floor", () => {
    const hole: [number, number][] = [
      [3, 3],
      [3, 7],
      [7, 7],
      [7, 3],
    ];
    const floor: number[] = [];
    addPrism([square, hole], 5, [], floor);
    let a = 0;
    for (let i = 0; i < floor.length; i += 9) {
      const [x1, y1, , x2, y2, , x3, y3] = floor.slice(i, i + 9);
      a += Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2;
    }
    expect(a).toBeCloseTo(100 - 16, 9);
  });
});

describe("addPrism closure", () => {
  test("every edge of a prism is shared by exactly two triangles", () => {
    const l: [number, number][] = [
      [0, 0],
      [20, 0],
      [20, 8],
      [8, 8],
      [8, 20],
      [0, 20],
    ];
    const prism: number[] = [];
    addPrism([l], 12, prism, []);
    for (const n of edgeCounts(prism).values()) expect(n).toBe(2);
  });
});

describe("triangulateTile and placeTile", () => {
  const tile = tileOfLngLat(121.55, 25.04);
  const n = 2 ** tile.z;
  // A lng/lat inside the tile at a fraction (fx, fy) of its width from its NW corner.
  const at = (fx: number, fy: number): [number, number] => {
    const lng = ((tile.x + fx) / n) * 360 - 180;
    const my = (tile.y + fy) / n;
    const lat = (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - 2 * my))) - 90;
    return [lng, lat];
  };
  const box = (x0: number, y0: number, x1: number, y1: number) => [
    [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)],
  ];

  test("records each building's run and true height", () => {
    const tp = triangulateTile(tile, [
      { heightM: 10, polygons: [box(0.1, 0.1, 0.2, 0.2)] },
      { heightM: 40, polygons: [box(0.5, 0.5, 0.6, 0.6)] },
    ]);
    expect(tp.count).toBe(2);
    expect(tp.features.map((f) => f.heightM)).toEqual([10, 40]);
    expect(tp.features[0].start).toBe(0);
    expect(tp.features[0].end).toBe(tp.features[1].start);
    expect(tp.features[1].end).toBe(tp.prism.length);
  });

  test("places tile units into a frame's metres, scaling z", () => {
    const src = new Float32Array([0, 0, 10, TILE_UNITS, TILE_UNITS, 20]);
    const metre = 1e-7;
    const frame = { origin: { x: tile.x / n, y: tile.y / n }, metre };
    const out = new Float32Array(6);
    expect(placeTile(frame, tile, src, out, 0, 2)).toBe(6);
    const side = 1 / n / metre;
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBe(20);
    expect(out[3]).toBeCloseTo(side, 3);
    expect(out[4]).toBeCloseTo(-side, 3); // tile y runs south, local y north
    expect(out[5]).toBe(40);
  });
});
