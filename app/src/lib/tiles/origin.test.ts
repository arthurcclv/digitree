import { describe, expect, test } from "vitest";
import { originOf } from "./origin";

// See `specs/origins.md`, *Invariants* 1.

const FALLBACK = "http://localhost:3000";
const of = (value: string | undefined) => originOf("VITE_TILES_URL", value, FALLBACK);

describe("originOf", () => {
  test("is the fallback when unset or blank", () => {
    expect(of(undefined)).toBe(FALLBACK);
    expect(of("")).toBe(FALLBACK);
    expect(of("  ")).toBe(FALLBACK);
  });

  test("uses a valid origin as given, minus a trailing slash", () => {
    expect(of("http://localhost:3001")).toBe("http://localhost:3001");
    expect(of("http://martin:3000/")).toBe("http://martin:3000");
    expect(of("https://192.168.81.32:3443")).toBe("https://192.168.81.32:3443");
  });

  test.each(["ftp://x", "localhost:3000", "http://h/tiles", "http://h?x=1", "http://h#x", "not a url"])(
    "rejects %s, naming the setting and the value",
    (value) => {
      expect(() => of(value)).toThrow(/VITE_TILES_URL/);
      expect(() => of(value)).toThrow(JSON.stringify(value));
    },
  );
});
