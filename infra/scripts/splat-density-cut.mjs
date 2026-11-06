// The density cut of process-splat.sh: drop the Gaussians whose voxel is far
// emptier than the capture's typical one, and write the rest as a .ply.
//
//   node scripts/splat-density-cut.mjs -- <lib> <in> <out.ply> <cell m> <min-density>
//
// <lib> is splat-transform's library entry (dist/index.mjs of the global
// install). Prints one JSON line — before, typical, kept, typical_scale — and
// exits 3 when nothing would be kept, without writing <out.ply>. The rule and its numbers
// are in specs/process-splat.md.
import { gridTooFine, loadLib, readTable, stepArgs, voxelGrid, writeRows } from './splat-table.mjs';

const [libPath, inPath, outPath, cellArg, minArg] = stepArgs();
const lib = await loadLib(libPath);
const cell = Number(cellArg);
const minDensity = Number(minArg);

const capture = await readTable(lib, inPath);
const { table } = capture;
const n = table.numRows;

// Voxels sit on multiples of `cell` from the capture's origin, so where their
// boundaries fall does not depend on which Gaussians are the extremes.
const grid = voxelGrid(table, cell);
if (!grid) throw gridTooFine(cell, '--cell');
const { key } = grid;
const counts = new Map();
for (let i = 0; i < n; i++) counts.set(key[i], (counts.get(key[i]) ?? 0) + 1);

// The typical density: the count of the voxel the median Gaussian is in, so
// half of all Gaussians sit in voxels at least that full.
const perGaussian = new Uint32Array(n);
for (let i = 0; i < n; i++) perGaussian[i] = counts.get(key[i]);
const typical = perGaussian.slice().sort()[n >> 1];
const threshold = minDensity * typical;

const keep = [];
for (let i = 0; i < n; i++) if (perGaussian[i] >= threshold) keep.push(i);
if (keep.length === 0) {
  console.log(JSON.stringify({ before: n, typical, kept: 0, typical_scale: null }));
  process.exit(3);
}

// The typical size, for the size cut's limit: the median largest axis of the
// Gaussians kept, so the floaters this cut removes do not shift it. The file
// stores log scale and exp is monotonic, so the median is taken in log.
const [s0, s1, s2] = ['scale_0', 'scale_1', 'scale_2'].map((c) => table.getColumnByName(c).data);
const largest = new Float32Array(keep.length);
for (let j = 0; j < keep.length; j++) {
  const i = keep[j];
  largest[j] = Math.max(s0[i], s1[i], s2[i]);
}
largest.sort();
const typicalScale = Math.exp(largest[largest.length >> 1]);
console.log(JSON.stringify({ before: n, typical, kept: keep.length, typical_scale: typicalScale }));

await writeRows(lib, capture, keep, outPath);
