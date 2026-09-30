import { describe, expect, test } from "vitest";
import { tileOfLngLat } from "./grid";
import { settle } from "./settle";
import { TileStore, type TileSource } from "./store";

// Fixture sources only, as in `store.test.ts`.
const a = tileOfLngLat(121.55, 25.04);
const b = tileOfLngLat(121.6, 25.08);
const source: TileSource<string> = { location: { tiles: "/fixture/{z}/{x}/{y}" }, decode: () => ["f"] };

const fetchBy = (answer: (url: string) => Response) => (async (input: RequestInfo | URL) => answer(String(input))) as typeof fetch;

test("resolves once every tile is ready, and lets go of onChange", async () => {
  const store = new TileStore({ s: source }, fetchBy(() => new Response(new ArrayBuffer(0), { status: 200 })));
  const counts = await settle(store, [a, b]);
  expect(counts).toEqual({ covered: 2, pending: 0, failed: 0 });
  expect(store.onChange).toBeNull();
});

describe("settle", () => {
  const source = (): TileSource<number> => ({
    location: { tiles: "/t/{z}/{x}/{y}" },
    decode: () => [1],
  });
  const fetchFn = (fail: Set<string>) =>
    (async (url: string) =>
      fail.has(url) ? new Response(null, { status: 500 }) : new Response(new ArrayBuffer(1))) as unknown as typeof fetch;

  test("resolves once every tile is ready or failed", async () => {
    const fail = new Set(["/t/14/2/1"]);
    const store = new TileStore({ s: source() }, fetchFn(fail));
    const counts = await settle(store, [
      { x: 1, y: 1, z: 14 },
      { x: 2, y: 1, z: 14 },
    ]);
    expect(counts).toEqual({ covered: 1, pending: 0, failed: 1 });
    expect(store.featuresOf("s", { x: 1, y: 1, z: 14 })).toEqual([1]);
  });

  test("resolves at once when there is nothing to fetch", async () => {
    const store = new TileStore({ s: source() }, fetchFn(new Set()));
    expect(await settle(store, [])).toEqual({ covered: 0, pending: 0, failed: 0 });
  });
});
