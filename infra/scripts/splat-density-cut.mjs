// The density cut of process-splat.sh: drop the Gaussians whose voxel is far
// emptier than the capture's typical one, and write the rest as a .ply.
//
//   node scripts/splat-density-cut.mjs -- <lib> <in> <out.ply> <cell m> <min-density>
//
// <lib> is splat-transform's library entry (dist/index.mjs of the global
// install). Prints one JSON line — before, typical, kept — and exits 3 when
// nothing would be kept, without writing <out.ply>. The rule and its numbers
// are in specs/process-splat.md.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [libPath, inPath, outPath, cellArg, minArg] = args;
const lib = await import(pathToFileURL(libPath).href);
const cell = Number(cellArg);
const minDensity = Number(minArg);

// The library exports no Node file system, so the capture goes through its
// in-memory ones: read whole, written whole. ~1 GB for a 95 MB capture.
const inName = basename(inPath);
const readFs = new lib.MemoryReadFileSystem();
readFs.set(inName, new Uint8Array(await readFile(inPath)));
const [source] = await lib.readFile({ filename: inName, inputFormat: lib.getInputFormat(inName), fileSystem: readFs });
const pool = lib.createChunkDataPool();
const table = await lib.materializeToDataTable(source, pool);
source.close?.();

const n = table.numRows;
const [x, y, z] = ['x', 'y', 'z'].map((c) => table.getColumnByName(c).data);

// Voxels sit on multiples of `cell` from the capture's origin, so where their
// boundaries fall does not depend on which Gaussians are the extremes. The
// indices are offset by the lowest one, so the key stays an exact integer for
// any capture that fits 2^53 voxels. (The library reads x and y negated, as
// --stats reports them; a count does not care.)
const lo = [x, y, z].map((a) => Math.floor(a.reduce((m, v) => (v < m ? v : m), Infinity) / cell));
const hi = [x, y, z].map((a) => Math.floor(a.reduce((m, v) => (v > m ? v : m), -Infinity) / cell));
const dims = lo.map((l, i) => hi[i] - l + 1);
if (dims[0] * dims[1] * dims[2] > Number.MAX_SAFE_INTEGER) {
  throw new Error(`a ${cell} m voxel grid over this capture has too many cells; use a larger --cell`);
}
const key = new Float64Array(n);
const counts = new Map();
for (let i = 0; i < n; i++) {
  const k = (Math.floor(x[i] / cell) - lo[0])
    + dims[0] * ((Math.floor(y[i] / cell) - lo[1]) + dims[1] * (Math.floor(z[i] / cell) - lo[2]));
  key[i] = k;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

// The typical density: the count of the voxel the median Gaussian is in, so
// half of all Gaussians sit in voxels at least that full.
const perGaussian = new Uint32Array(n);
for (let i = 0; i < n; i++) perGaussian[i] = counts.get(key[i]);
const typical = perGaussian.slice().sort()[n >> 1];
const threshold = minDensity * typical;

const keep = [];
for (let i = 0; i < n; i++) if (perGaussian[i] >= threshold) keep.push(i);
console.log(JSON.stringify({ before: n, typical, kept: keep.length }));
if (keep.length === 0) process.exit(3);

// 3.10 writes chunk sources only, so the kept rows are gathered into one.
const outName = basename(outPath);
const writeFs = new lib.MemoryFileSystem();
await lib.writeSource({
  filename: outName,
  outputFormat: lib.getOutputFormat(outName, {}),
  source: lib.dataTableToChunkSource(table, undefined, Uint32Array.from(keep)),
  pool,
  options: {},
}, writeFs);
await writeFile(outPath, writeFs.results.get(outName));
