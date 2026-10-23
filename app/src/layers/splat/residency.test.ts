import { describe, expect, test } from "vitest";
import { frameAt, metreInMercator } from "../../lib/tiles";
import { SPLAT_KEEP_M, SPLAT_MAX_CAPTURES } from "./constants";
import { Residency, type View } from "./residency";
import type { Splat } from "./schema";

const LAT = 25.0386;
const LNG = 121.5385;
/** Degrees of longitude per metre, here, as the map measures it (Mercator x is lng / 360). */
const DEG_PER_M = 360 * metreInMercator(LAT);

/** A capture `m` metres east of (LNG, LAT). */
const at = (id: string, m: number): Splat => ({
  id,
  file: `${id}.spz`,
  lngLat: [LNG + m * DEG_PER_M, LAT],
  altitudeM: 0,
  headingDeg: 0,
  scale: 1,
  bytes: 1,
});

/** The view centred `m` metres east of (LNG, LAT). */
const viewAt = (m: number): View => frameAt(LNG + m * DEG_PER_M, LAT);

/** Load everything that is due, in order; the ids loaded. */
function drain(r: Residency<string>, view: View): string[] {
  const ids: string[] = [];
  for (let n = r.next(view); n; n = r.next(view)) {
    r.done(n.load, `mesh:${n.load.id}`);
    ids.push(n.load.id);
  }
  return ids;
}

describe("Residency", () => {
  test("queues each capture once, in the order offered, and says whether any was new", () => {
    const r = new Residency<string>();
    expect(r.offer([at("a", 0), at("b", 5)])).toBe(true);
    expect(r.offer([at("b", 5), at("a", 0)])).toBe(false);
    expect(r.counts()).toMatchObject({ known: 2, loaded: 0, loading: null });
    expect(drain(r, viewAt(0))).toEqual(["a", "b"]);
  });

  test("loads one at a time", () => {
    const r = new Residency<string>();
    r.offer([at("a", 0), at("b", 5)]);
    const first = r.next(viewAt(0))!;
    expect(first.load.id).toBe("a");
    expect(r.counts().loading).toBe("a");
    expect(r.next(viewAt(0))).toBeNull();
    r.done(first.load, "mesh");
    expect(r.next(viewAt(0))!.load.id).toBe("b");
  });

  test("keeps a failed capture known, so it is not retried, and counts it", () => {
    const r = new Residency<string>();
    r.offer([at("a", 0)]);
    r.failed(r.next(viewAt(0))!.load, "404");
    expect(r.counts()).toEqual({ known: 1, loaded: 0, loading: null, errors: [{ id: "a", message: "404" }] });
    expect(r.offer([at("a", 0)])).toBe(false);
    expect(r.next(viewAt(0))).toBeNull();
  });

  test("past SPLAT_MAX_CAPTURES a nearer capture evicts the farthest, and a farther one waits", () => {
    const r = new Residency<string>();
    const row = Array.from({ length: SPLAT_MAX_CAPTURES + 1 }, (_, i) => at(`c${String(i).padStart(2, "0")}`, i * 5));
    r.offer(row);
    // From the west end the last is the farthest: it waits.
    expect(drain(r, viewAt(0))).toEqual(row.slice(0, SPLAT_MAX_CAPTURES).map((s) => s.id));
    expect(r.next(viewAt(0))).toBeNull();
    // From the east end it is the nearest, and the first is the farthest.
    const next = r.next(viewAt(SPLAT_MAX_CAPTURES * 5))!;
    expect(next.load.id).toBe(row.at(-1)!.id);
    expect(next.evicted).toEqual({ splat: row[0], value: "mesh:c00" });
    r.done(next.load, "mesh");
    expect(r.held().map((h) => h.splat.id).sort()).toEqual(row.slice(1).map((s) => s.id));
    // The evicted one is forgotten, so its tile finds it again.
    expect(r.offer([row[0]])).toBe(true);
  });

  test("settle forgets loaded and queued captures past SPLAT_KEEP_M, and keeps the rest", () => {
    const r = new Residency<string>();
    r.offer([at("near", 0), at("loadedFar", 50)]);
    drain(r, viewAt(0));
    r.offer([at("queuedFar", 100)]);
    expect(r.settle(viewAt(-SPLAT_KEEP_M + 100))).toEqual({ unloaded: [], changed: false });
    const { unloaded, changed } = r.settle(viewAt(-SPLAT_KEEP_M + 20));
    expect(changed).toBe(true);
    expect(unloaded).toEqual([{ splat: at("loadedFar", 50), value: "mesh:loadedFar" }]);
    expect(r.counts()).toMatchObject({ known: 1, loaded: 1 });
    expect(r.offer([at("loadedFar", 50), at("queuedFar", 100)])).toBe(true);
  });

  test("a queued capture alone past SPLAT_KEEP_M is a change, with nothing to unload", () => {
    const r = new Residency<string>();
    r.offer([at("far", SPLAT_KEEP_M + 10)]);
    expect(r.settle(viewAt(0))).toEqual({ unloaded: [], changed: true });
    expect(r.counts().known).toBe(0);
  });

  test("clear returns what was loaded and forgets everything", () => {
    const r = new Residency<string>();
    r.offer([at("a", 0), at("b", 5), at("c", 10)]);
    r.done(r.next(viewAt(0))!.load, "mesh:a");
    r.next(viewAt(0));
    expect(r.clear()).toEqual([{ splat: at("a", 0), value: "mesh:a" }]);
    expect(r.counts()).toMatchObject({ known: 0, loaded: 0, loading: null });
    expect(r.next(viewAt(0))).toBeNull();
  });
});
