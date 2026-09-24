import { describe, expect, test } from "vitest";
import { tileOfLngLat, type TileId } from "./grid";
import { buildingHeight, FETCH_CONCURRENCY, TileStore } from "./store";

const TILEJSON = "https://tiles.openfreemap.org/planet";
const inTaipei = tileOfLngLat(121.55, 25.04);
const offshore = tileOfLngLat(120.2, 22.6); // Kaohsiung: outside the tree inventory

/** A fake fetch recording what was asked, answering by URL. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return answer(url);
  }) as typeof fetch;
  return { fn, calls };
}

const tilejson = () =>
  new Response(JSON.stringify({ tiles: ["https://example.test/b/{z}/{x}/{y}.pbf"] }), { status: 200 });
// An empty buffer is a valid, empty vector tile.
const empty = () => new Response(new ArrayBuffer(0), { status: 200 });

const settle = () => new Promise((r) => setTimeout(r, 0));
async function drain(store: TileStore) {
  for (let i = 0; i < 50 && store.counts().pending; i++) await settle();
}

describe("TileStore", () => {
  test("a tile is covered once both sources have arrived", async () => {
    const { fn } = fakeFetch((url) => (url === TILEJSON ? tilejson() : empty()));
    const store = new TileStore(fn);
    store.want([inTaipei]);
    expect(store.counts()).toMatchObject({ covered: 0 });
    await drain(store);
    expect(store.counts()).toEqual({ covered: 1, pending: 0, failed: 0 });
    expect(store.covered()).toEqual([inTaipei]);
  });

  test("Martin's 204 for an empty tile counts as arrived", async () => {
    const { fn } = fakeFetch((url) =>
      url === TILEJSON ? tilejson() : url.startsWith("/tiles/trees") ? new Response(null, { status: 204 }) : empty(),
    );
    const store = new TileStore(fn);
    store.want([inTaipei]);
    await drain(store);
    expect(store.counts().covered).toBe(1);
  });

  test("a tree tile outside the inventory is never requested", async () => {
    const { fn, calls } = fakeFetch((url) => (url === TILEJSON ? tilejson() : empty()));
    const store = new TileStore(fn);
    store.want([offshore]);
    await drain(store);
    expect(calls.some((u) => u.startsWith("/tiles/trees"))).toBe(false);
    expect(store.counts().covered).toBe(1);
  });

  test("a failed tile is uncovered, reported, and retried on the next want", async () => {
    let fail = true;
    const { fn } = fakeFetch((url) =>
      url === TILEJSON ? tilejson() : fail && url.includes("example.test") ? new Response(null, { status: 500 }) : empty(),
    );
    const store = new TileStore(fn);
    store.want([inTaipei]);
    await drain(store);
    expect(store.counts()).toEqual({ covered: 0, pending: 0, failed: 1 });
    expect(store.covered()).toEqual([]);
    fail = false;
    store.want([inTaipei]);
    await drain(store);
    expect(store.counts()).toEqual({ covered: 1, pending: 0, failed: 0 });
  });

  test("an unreadable TileJSON fails the building tiles, and is retried", async () => {
    let broken = true;
    const { fn, calls } = fakeFetch((url) =>
      url === TILEJSON ? (broken ? new Response("nope", { status: 503 }) : tilejson()) : empty(),
    );
    const store = new TileStore(fn);
    store.want([inTaipei]);
    await drain(store);
    expect(store.counts().failed).toBe(1);
    broken = false;
    store.want([inTaipei]);
    await drain(store);
    expect(store.counts().covered).toBe(1);
    expect(calls.filter((u) => u === TILEJSON).length).toBe(2);
  });

  test("a tile already held is not fetched again", async () => {
    const { fn, calls } = fakeFetch((url) => (url === TILEJSON ? tilejson() : empty()));
    const store = new TileStore(fn);
    store.want([inTaipei]);
    await drain(store);
    const before = calls.length;
    store.want([inTaipei]);
    await drain(store);
    expect(calls.length).toBe(before);
  });

  test(`never has more than ${FETCH_CONCURRENCY} requests in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    const { fn } = fakeFetch(async (url) => {
      if (url === TILEJSON) return tilejson();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await settle();
      inFlight--;
      return empty();
    });
    const store = new TileStore(fn);
    const tiles: TileId[] = [];
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) tiles.push({ ...inTaipei, x: inTaipei.x + dx, y: inTaipei.y + dy });
    store.want(tiles);
    await drain(store);
    expect(store.counts().covered).toBe(16);
    expect(peak).toBeLessThanOrEqual(FETCH_CONCURRENCY);
  });

  test("a buildings-only store never asks for trees, and covers on buildings alone", async () => {
    const { fn, calls } = fakeFetch((url) => (url === TILEJSON ? tilejson() : empty()));
    const store = new TileStore(fn, ["buildings"]);
    store.want([inTaipei]);
    await drain(store);
    expect(calls.some((u) => u.startsWith("/tiles/trees"))).toBe(false);
    expect(store.counts()).toEqual({ covered: 1, pending: 0, failed: 0 });
  });
});

describe("buildingHeight", () => {
  test("drops hide_3d and non-positive heights, as the extrusion filter does", () => {
    expect(buildingHeight({ render_height: 30 })).toBe(30);
    expect(buildingHeight({ render_height: "12.5" })).toBe(12.5);
    expect(buildingHeight({ render_height: 30, hide_3d: true })).toBeNull();
    expect(buildingHeight({ render_height: 0 })).toBeNull();
    expect(buildingHeight({})).toBeNull();
  });
});
