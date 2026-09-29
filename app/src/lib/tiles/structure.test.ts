import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// Assertions about the source tree itself: the data-source seam holds only if
// nothing quietly reaches back across it. See `specs/spec.md`, *Invariants*.

const SRC = join(__dirname, "..", "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const isTest = (path: string) => /\.test\.tsx?$/.test(path);

describe("the data-source seam", () => {
  // `useMapEngine.ts` also lives in src/lib, but it is the host: composing the
  // layers is its job. The shared modules must not know them.
  test("no shared module in src/lib imports from src/layers", () => {
    const shared = ["tiles", "mount", "dag", "three"].flatMap((d) => filesUnder(join(SRC, "lib", d)));
    const offenders = shared.filter((path) =>
      /from\s+["'][^"']*\/layers\//.test(readFileSync(path, "utf8")),
    );
    expect(offenders.map((p) => relative(SRC, p))).toEqual([]);
  });

  test("no layer but basemaps names a tile endpoint", () => {
    const layers = ["tree", "buildings", "sunlight", "ambient-occlusion", "temperature"];
    const offenders = layers
      .flatMap((l) => filesUnder(join(SRC, "layers", l)))
      .filter((path) => !isTest(path))
      // A URL-shaped string literal: a same-origin tile path, a template, or the
      // OSM host. Quoted only: backticks here are doc comments naming paths.
      .filter((path) => /["'](\/tiles\/|[^"'\n]*\{z\}|[^"'\n]*openfreemap\.org)/.test(readFileSync(path, "utf8")));
    expect(offenders.map((p) => relative(SRC, p))).toEqual([]);
  });
});

// The GL rules live in one place, `src/lib/three`. See its spec, invariant 7.
describe("the three.js host seam", () => {
  test("no layer makes a renderer, resets GL state, or reads mainMatrix itself", () => {
    const offenders = filesUnder(join(SRC, "layers"))
      .filter((path) => !isTest(path))
      .filter((path) =>
        /new\s+THREE\.WebGLRenderer\b|\.resetState\(|defaultProjectionData\.mainMatrix/.test(readFileSync(path, "utf8")),
      );
    expect(offenders.map((p) => relative(SRC, p))).toEqual([]);
  });
});
