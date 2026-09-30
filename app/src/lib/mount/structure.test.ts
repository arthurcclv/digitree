import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Assertions about the source tree itself: the guards that keep a layer
// portable. See `specs/spec.md`, *Structural guards*. They read files and
// import nothing, so this shared module still knows no layer.

const SRC = join(__dirname, "..", "..");
const HOST = join(SRC, "lib", "useMapEngine.ts");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Comments name things freely; only code counts. */
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

interface Import {
  /** `import type …` or `export type … from`. */
  typeOnly: boolean;
  /** The specifiers between braces, `type ` prefix kept. */
  names: string[];
  /** Anything outside the braces: a default or namespace import. */
  other: string;
  from: string;
}

/** Every `import … from` and `export … from` in a module. */
function importsOf(path: string): Import[] {
  const out: Import[] = [];
  for (const m of code(path).matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/g)) {
    const [, typeKw, clause, from] = m;
    const braces = clause.match(/\{([^}]*)\}/);
    out.push({
      typeOnly: Boolean(typeKw),
      names: braces ? braces[1].split(",").map((s) => s.trim()).filter(Boolean) : [],
      other: clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim(),
      from,
    });
  }
  return out;
}

/** Erased at compile time, so no runtime edge: `import type`, or all-`type` specifiers. */
const erased = (i: Import) => i.typeOnly || (!i.other && i.names.length > 0 && i.names.every((n) => n.startsWith("type ")));

describe("the host", () => {
  // Invariant 9. The allowlist is the only runtime surface a host needs.
  const ALLOWED = [
    /^mount[A-Z]\w*$/, // mount factories
    /^buildingsLayer$/, // the record-only layer's record builder…
    /^BUILDINGS_STYLE_LAYER_IDS$/, // …and its style-layer ids, for anchoring
    /^(anchorUnderLabels|hideBasemapBuildings)$/, // the basemaps extension's style surgery
    /^\w+_NATIVE_LAYER_ID$/, // custom-layer ids, for stacking only
    /^export\w+Usd$/, // the record-only layers' USD export functions
  ];

  test("imports from the layers only mount factories and stacking ids at runtime", () => {
    const disallowed = importsOf(HOST)
      .filter((i) => /\/layers\//.test(i.from) && !i.typeOnly)
      .flatMap((i) => i.names.filter((n) => !n.startsWith("type ")))
      .filter((n) => !ALLOWED.some((re) => re.test(n)));
    expect(disallowed).toEqual([]);
  });

  test("constructs, wires and names nothing of a layer", () => {
    const src = code(HOST);
    const found = [
      /\bThree[A-Z]\w*Layer\b/, // a layer class
      /\b[A-Z][A-Z0-9_]*_NODE\b/, // a DAG node id
      /\b[A-Z][A-Z0-9_]*_DEPS\b/, // a node's deps
      /\.addLayer\(/,
      /\b(set|clear)ExternalNativePaintBridge\b/,
      /\bgraph\s*\.\s*add\(/,
    ]
      .filter((re) => re.test(src))
      .map(String);
    expect(found).toEqual([]);
  });
});

describe("the layers", () => {
  // Invariant 10: what a layer needs from a sibling is a type it owns.
  test("no layer imports another layer's settings", () => {
    const offenders = filesUnder(join(SRC, "layers")).flatMap((path) =>
      importsOf(path)
        // Another layer's folder: `../<name>`, not `../../lib`.
        .filter((i) => /^\.\.\/[a-z-]+$/.test(i.from))
        .flatMap((i) => i.names.map((n) => n.replace(/^type\s+/, "").split(/\s+as\s+/)[0]))
        .filter((n) => /Settings$/.test(n))
        .map((n) => `${relative(SRC, path)}: ${n}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the module graph", () => {
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(from), spec);
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c)) return c;
    return null;
  };

  /** Runtime edges only: type imports are erased and cannot close a cycle. */
  const edges = new Map<string, string[]>();
  for (const path of filesUnder(SRC)) {
    edges.set(
      path,
      importsOf(path)
        .filter((i) => !erased(i))
        .map((i) => resolveImport(path, i.from))
        .filter((to): to is string => to !== null),
    );
  }

  /** Strongly connected components with more than one module (Tarjan). */
  function cycles(): string[][] {
    let next = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const found: string[][] = [];
    const visit = (v: string) => {
      index.set(v, next);
      low.set(v, next);
      next++;
      stack.push(v);
      onStack.add(v);
      for (const w of edges.get(v) ?? []) {
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        // A module importing itself is a cycle too.
        if (component.length > 1 || (edges.get(v) ?? []).includes(v)) found.push(component);
      }
    };
    for (const v of edges.keys()) if (!index.has(v)) visit(v);
    return found;
  }

  // Invariant 11. tsc does not report a cycle; an ES module cycle fails only
  // at runtime, as a binding read before its module has run.
  test("has no runtime import cycle", () => {
    expect(cycles().map((c) => c.map((p) => relative(SRC, p)).sort().join(" ⇄ "))).toEqual([]);
  });

  test("sees the whole tree", () => {
    // A detector that saw nothing would pass for the wrong reason.
    expect(edges.size).toBeGreaterThan(50);
    expect([...edges.values()].flat().length).toBeGreaterThan(100);
  });
});
