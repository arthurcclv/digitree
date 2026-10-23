import { describe, expect, test } from "vitest";
import { tileIntersects, tileOfLngLat, type TileId } from "./grid";
import { FETCH_CONCURRENCY, TileStore, type TileSource } from "./store";

// Fixture sources only: the store knows no dataset, so its tests name none.
// One source by template with bounds, one by TileJSON, as trees and buildings are.
const TILEJSON = "https://tiles.example.test/b.json";
const POINTS_TILES = "/fixture/points/{z}/{x}/{y}";
const inside = tileOfLngLat(121.55, 25.04);
const outside = tileOfLngLat(120.2, 22.6); // outside the points' bounds

const points: TileSource<string> = {
  location: { tiles: POINTS_TILES },
  decode: () => ["p"],
  mayHold: (t) => tileIntersects(t, [121.4, 24.9, 121.7, 25.2]),
};
const polys: TileSource<string> = { location: { tileJson: TILEJSON }, decode: () => ["b"] };
const both = { points, polys };

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
const ok = () => new Response(new ArrayBuffer(0), { status: 200 });

const settle = () => new Promise((r) => setTimeout(r, 0));
async function drain(store: TileStore<Record<string, TileSource<unknown>>>) {
  for (let i = 0; i < 50 && store.counts().pending; i++) await settle();
}

describe("TileStore", () => {
  test("a tile is covered once every held source has it", async () => {
    const { fn } = fakeFetch((url) => (url === TILEJSON ? tilejson() : ok()));
    const store = new TileStore(both, fn);
    store.want([inside]);
    expect(store.counts()).toMatchObject({ covered: 0 });
    await drain(store);
    expect(store.counts()).toEqual({ covered: 1, pending: 0, failed: 0 });
    expect(store.covered()).toEqual([inside]);
  });

  test("Martin's 204 for an empty tile counts as arrived", async () => {
    const { fn } = fakeFetch((url) =>
      url === TILEJSON ? tilejson() : url.startsWith("/fixture/points") ? new Response(null, { status: 204 }) : ok(),
    );
    const store = new TileStore(both, fn);
    store.want([inside]);
    await drain(store);
    expect(store.counts().covered).toBe(1);
  });

  test("a tile a source cannot hold is never requested, and counts as arrived", async () => {
    const { fn, calls } = fakeFetch((url) => (url === TILEJSON ? tilejson() : ok()));
    const store = new TileStore(both, fn);
    store.want([outside]);
    await drain(store);
    expect(calls.some((u) => u.startsWith("/fixture/points"))).toBe(false);
    expect(store.counts().covered).toBe(1);
  });

  test("a failed tile is uncovered, reported, and retried on the next want", async () => {
    let fail = true;
    const { fn } = fakeFetch((url) =>
      url === TILEJSON ? tilejson() : fail && url.includes("example.test") ? new Response(null, { status: 500 }) : ok(),
    );
    const store = new TileStore(both, fn);
    store.want([inside]);
    await drain(store);
    expect(store.counts()).toEqual({ covered: 0, pending: 0, failed: 1 });
    expect(store.covered()).toEqual([]);
    fail = false;
    store.want([inside]);
    await drain(store);
    expect(store.counts()).toEqual({ covered: 1, pending: 0, failed: 0 });
  });

  test("an unreadable TileJSON fails that source's tiles, and is retried", async () => {
    let broken = true;
    const { fn, calls } = fakeFetch((url) =>
      url === TILEJSON ? (broken ? new Response("nope", { status: 503 }) : tilejson()) : ok(),
    );
    const store = new TileStore(both, fn);
    store.want([inside]);
    await drain(store);
    expect(store.counts().failed).toBe(1);
    broken = false;
    store.want([inside]);
    await drain(store);
    expect(store.counts().covered).toBe(1);
    expect(calls.filter((u) => u === TILEJSON).length).toBe(2);
  });

  test("a tile already held is not fetched again", async () => {
    const { fn, calls } = fakeFetch((url) => (url === TILEJSON ? tilejson() : ok()));
    const store = new TileStore(both, fn);
    store.want([inside]);
    await drain(store);
    const before = calls.length;
    store.want([inside]);
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
      return ok();
    });
    const store = new TileStore(both, fn);
    const tiles: TileId[] = [];
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) tiles.push({ ...inside, x: inside.x + dx, y: inside.y + dy });
    store.want(tiles);
    await drain(store);
    expect(store.counts().covered).toBe(16);
    expect(peak).toBeLessThanOrEqual(FETCH_CONCURRENCY);
  });

  test("a store given one source never requests another, and covers on it alone", async () => {
    const { fn, calls } = fakeFetch((url) => (url === TILEJSON ? tilejson() : ok()));
    const store = new TileStore({ polys }, fn);
    store.want([inside]);
    await drain(store);
    expect(calls.some((u) => u.startsWith("/fixture/points"))).toBe(false);
    expect(store.counts()).toEqual({ covered: 1, pending: 0, failed: 0 });
  });

  test("features are read per source, once the tile is ready", async () => {
    const { fn } = fakeFetch((url) => (url === TILEJSON ? tilejson() : ok()));
    const store = new TileStore(both, fn);
    expect(store.featuresOf("points", inside)).toEqual([]);
    store.want([inside]);
    await drain(store);
    expect(store.featuresOf("points", inside)).toEqual(["p"]);
    expect(store.featuresOf("polys", inside)).toEqual(["b"]);
  });

  test("dispose aborts what is in flight, and the store does nothing after", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let changes = 0;
    // Answers only when aborted, as a real fetch rejects.
    const fn = ((_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    }) as typeof fetch;
    const store = new TileStore({ points }, fn);
    store.onChange = () => changes++;
    store.want([inside]);
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    store.dispose();
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(changes).toBe(0);
    expect(store.counts()).toEqual({ covered: 0, pending: 0, failed: 0 });

    store.want([inside]);
    await settle();
    expect(signals).toHaveLength(1);
  });

  test("a fetch that settles after dispose changes nothing", async () => {
    let answer: (r: Response) => void = () => {};
    const fn = (() => new Promise<Response>((resolve) => (answer = resolve))) as typeof fetch;
    const store = new TileStore({ points }, fn);
    store.want([inside]);
    await settle();
    store.dispose();
    answer(ok());
    await settle();
    expect(store.featuresOf("points", inside)).toEqual([]);
  });
});
