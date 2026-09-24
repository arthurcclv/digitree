import { describe, expect, test } from "vitest";
import { rotationOf } from "./placement";

const TAU = Math.PI * 2;
const deg = (radians: number) => (radians / TAU) * 360;

/** The inventory's real id shape: a fixed prefix and a zero-padded counter. */
const id = (n: number) => `BT0015${String(n).padStart(6, "0")}`;

/** The smaller of the two ways round the circle, in degrees. */
function gap(a: number, b: number): number {
  const d = Math.abs(deg(a) - deg(b));
  return Math.min(d, 360 - d);
}

describe("rotationOf", () => {
  test("is a pure function of the id", () => {
    expect(rotationOf("BT0015000001")).toBe(rotationOf("BT0015000001"));
    expect(rotationOf("BT0015000001")).not.toBe(rotationOf("BT0015000002"));
  });

  // The whole point of hashing rather than drawing: a tree faces the same way
  // on every reload. These are the values the current arithmetic produces, and
  // changing them is a reshuffle of every tree in Taipei, not a refactor.
  test("is pinned, so a reload cannot re-orient the city", () => {
    expect(deg(rotationOf("BT0015000001"))).toBeCloseTo(352.414476, 5);
    expect(deg(rotationOf("BT0015000002"))).toBeCloseTo(35.811413, 5);
    expect(deg(rotationOf("BT0614021096"))).toBeCloseTo(137.693646, 5);
  });

  test("stays inside one turn", () => {
    for (let n = 1; n <= 5000; n += 1) {
      const angle = rotationOf(id(n));
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(TAU);
    }
  });

  test("handles an empty id and a non-ASCII one without throwing", () => {
    // A custom drop-in supplies its own ids and need not follow the city's shape.
    for (const value of ["", "榕樹-01", "  ", "x".repeat(500)]) {
      expect(Number.isFinite(rotationOf(value))).toBe(true);
    }
  });

  /**
   * The failure this module's finalizer exists for.
   *
   * The city's ids are sequential and one street's trees carry consecutive
   * ones, so neighbouring ids are the case that matters. Plain FNV-1a put them
   * 1.4° apart — a boulevard of identical-facing trees. For angles spread
   * independently the mean gap is 90°; anything under ~45° means the hash is
   * leaking the id's ordering into the map.
   */
  test("does not leak sequential ids into neighbouring angles", () => {
    const gaps: number[] = [];
    for (let n = 1; n < 2000; n += 1) gaps.push(gap(rotationOf(id(n)), rotationOf(id(n + 1))));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(45);
  });

  test("scatters a single street rather than fanning it", () => {
    // Ten consecutive trees, as a real block would be. If the hash carried the
    // ordering, these would arrive as a near-arithmetic sequence.
    const angles = Array.from({ length: 10 }, (_, i) => deg(rotationOf(id(i + 1))));
    for (let i = 1; i < angles.length; i += 1) {
      expect(gap(rotationOf(id(i)), rotationOf(id(i + 1)))).toBeGreaterThan(5);
    }
  });

  test("spreads evenly over the circle", () => {
    const buckets = new Array(8).fill(0);
    const n = 20_000;
    for (let i = 1; i <= n; i += 1) buckets[Math.floor((deg(rotationOf(id(i))) / 360) * 8)] += 1;
    // Even eighths would be 2,500 each; ±12% is loose enough not to be brittle
    // and tight enough to catch a hash that collapses onto part of the circle.
    for (const count of buckets) {
      expect(count).toBeGreaterThan((n / 8) * 0.88);
      expect(count).toBeLessThan((n / 8) * 1.12);
    }
  });

  test("distinguishes ids that differ only in a middle character", () => {
    const angles = new Set(
      ["BT0015000001", "BT0025000001", "BT0035000001", "BT0045000001"].map(rotationOf),
    );
    expect(angles.size).toBe(4);
  });
});
