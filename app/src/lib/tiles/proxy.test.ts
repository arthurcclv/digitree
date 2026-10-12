import { describe, expect, test } from "vitest";
import { tileProxy } from "./proxy";

// See `specs/proxy.md`, *Invariants*.

const targetOf = (value: string | undefined) => tileProxy({ TILES_PROXY_TARGET: value }).target;

describe("tileProxy", () => {
  test("defaults to Martin on localhost:3000 when unset or empty", () => {
    expect(tileProxy({}).target).toBe("http://localhost:3000");
    expect(targetOf(undefined)).toBe("http://localhost:3000");
    expect(targetOf("")).toBe("http://localhost:3000");
    expect(targetOf("  ")).toBe("http://localhost:3000");
  });

  test("uses a valid origin as given, minus a trailing slash", () => {
    expect(targetOf("http://localhost:3001")).toBe("http://localhost:3001");
    expect(targetOf("http://martin:3000/")).toBe("http://martin:3000");
    expect(targetOf("https://tiles.example.org")).toBe("https://tiles.example.org");
  });

  test.each(["ftp://x", "localhost:3000", "http://h/tiles", "http://h?x=1", "http://h#x", "not a url"])(
    "rejects %s, naming the setting",
    (value) => {
      expect(() => targetOf(value)).toThrow(/TILES_PROXY_TARGET/);
      expect(() => targetOf(value)).toThrow(JSON.stringify(value));
    },
  );

  test("strips the /tiles prefix and nothing else", () => {
    const { rewrite } = tileProxy({});
    expect(rewrite?.("/tiles/trees/15/1/2")).toBe("/trees/15/1/2");
    expect(rewrite?.("/trees/15/1/2")).toBe("/trees/15/1/2");
  });

  test("rewrites the Host header to the target's", () => {
    expect(tileProxy({}).changeOrigin).toBe(true);
  });
});
