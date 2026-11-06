// Footprint pruning, process-splat.sh's first cut: keep only the Gaussians of
// the capture's largest connected body, and write them as a .ply.
//
//   node scripts/splat-footprint.mjs -- <lib> <in> <out.ply> <cell m>
//
// <lib> is splat-transform's library entry (dist/index.mjs of the global
// install). Every Gaussian goes in a cubic voxel of edge <cell> by its centre;
// a voxel holding one or more is valid; valid voxels that share a face, an
// edge or a corner (26-connectivity) form groups; the group with the most
// valid voxels is kept — ties to the most Gaussians, then to the group holding
// the lowest voxel (x, then y, then z). Prints one JSON line — before, groups,
// voxels (the kept group's), kept — and writes <out.ply>: the kept group
// holds at least one Gaussian. Exits 3, writing nothing, on an empty capture.
// The rule is in specs/process-splat.md, *Footprint pruning*.
import { gridTooFine, loadLib, readTable, stepArgs, voxelGrid, writeRows } from './splat-table.mjs';

const [libPath, inPath, outPath, cellArg] = stepArgs();
const lib = await loadLib(libPath);
const cell = Number(cellArg);

const capture = await readTable(lib, inPath);
if (!capture) {
  console.log(JSON.stringify({ before: 0, groups: 0, voxels: 0, kept: 0 }));
  process.exit(3);
}
const n = capture.table.numRows;
const grid = voxelGrid(capture.table, cell);
if (!grid) throw gridTooFine(cell, '--footprint-cell');
const { key, coords, keyAt } = grid;

// The valid voxels, numbered in the order first seen: their keys, and how many
// Gaussians each holds.
const voxelOf = new Map();
const keys = [];
const counts = [];
const voxel = new Uint32Array(n);
for (let i = 0; i < n; i++) {
  let v = voxelOf.get(key[i]);
  if (v === undefined) {
    v = keys.length;
    voxelOf.set(key[i], v);
    keys.push(key[i]);
    counts.push(0);
  }
  counts[v]++;
  voxel[i] = v;
}
const m = keys.length;

// Union-find over the valid voxels.
const parent = new Uint32Array(m);
for (let v = 0; v < m; v++) parent[v] = v;
const find = (v) => {
  while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; }
  return v;
};
const union = (a, b) => {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
};
// Each voxel is joined to the 13 of its 26 neighbours that come after it in
// key order; the other 13 join it from their side.
const FORWARD = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
  if (dz > 0 || (dz === 0 && (dy > 0 || (dy === 0 && dx > 0)))) FORWARD.push([dx, dy, dz]);
}
for (let v = 0; v < m; v++) {
  const [ix, iy, iz] = coords(keys[v]);
  for (const [dx, dy, dz] of FORWARD) {
    const k = keyAt(ix + dx, iy + dy, iz + dz);
    const w = k === undefined ? undefined : voxelOf.get(k);
    if (w !== undefined) union(v, w);
  }
}

// Each group's voxels, Gaussians and lowest voxel (x, then y, then z), in the
// file's own coordinates: the library reads x and y negated, so their indices
// are negated back before they are compared.
const lower = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};
const groups = new Map();
for (let v = 0; v < m; v++) {
  const r = find(v);
  const [ix, iy, iz] = coords(keys[v]);
  const c = [-ix, -iy, iz];
  const g = groups.get(r);
  if (!g) { groups.set(r, { voxels: 1, gaussians: counts[v], lowest: c }); continue; }
  g.voxels++;
  g.gaussians += counts[v];
  if (lower(c, g.lowest)) g.lowest = c;
}
const better = (a, b) => {
  if (a.voxels !== b.voxels) return a.voxels > b.voxels;
  if (a.gaussians !== b.gaussians) return a.gaussians > b.gaussians;
  return lower(a.lowest, b.lowest);
};
let best = null, bestRoot = -1;
for (const [r, g] of groups) if (best === null || better(g, best)) { best = g; bestRoot = r; }

const keep = [];
for (let i = 0; i < n; i++) if (find(voxel[i]) === bestRoot) keep.push(i);
console.log(JSON.stringify({ before: n, groups: groups.size, voxels: best.voxels, kept: keep.length }));

await writeRows(lib, capture, keep, outPath);
