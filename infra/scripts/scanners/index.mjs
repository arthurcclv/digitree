// The scanner modules splat-align.mjs reads a scan through, found by the
// PLY's `comment source`. Adding a scanner is one module here and one line
// below; the interface is specs/scanners.md.
import * as k2 from './k2.mjs';
import * as l2pro from './l2pro.mjs';
import * as lixelL3 from './lixel-l3.mjs';

// source → module, throwing when two modules claim one source.
export function registry(modules) {
  const bySource = new Map();
  for (const m of modules) {
    for (const s of m.sources) {
      if (bySource.has(s)) throw new Error(`scanner modules ${bySource.get(s).name} and ${m.name} both claim source '${s}'`);
      bySource.set(s, m);
    }
  }
  return bySource;
}

const bySource = registry([l2pro, k2, lixelL3]);

// The module for a `comment source` value, or null.
export const scannerFor = (source) => bySource.get(source) ?? null;
