// A whole capture through splat-transform's library, for the node steps of
// process-splat.sh (splat-footprint.mjs, splat-density-cut.mjs): read it as
// one table, and write some of its rows back as a lossless .ply. The library
// exports no Node file system, so the file goes through its in-memory ones:
// read whole, written whole. ~1 GB for a 95 MB capture. Written against
// splat-transform 3.10.x, which process-splat.sh holds the version to.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// A node step's positional arguments, past the `--` that ends node's own.
export function stepArgs() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  return args;
}

// The library at <libPath> (dist/index.mjs of the global install).
export const loadLib = async (libPath) => import(pathToFileURL(libPath).href);

// { table, pool } for the capture at <path>, in any format the library reads;
// null when it holds no Gaussians, which the library cannot make a table of.
export async function readTable(lib, path) {
  const name = basename(path);
  const readFs = new lib.MemoryReadFileSystem();
  readFs.set(name, new Uint8Array(await readFile(path)));
  const [source] = await lib.readFile({ filename: name, inputFormat: lib.getInputFormat(name), fileSystem: readFs });
  if (source.meta.lodCounts.reduce((a, c) => a + c, 0) === 0) {
    source.close?.();
    return null;
  }
  const pool = lib.createChunkDataPool();
  const table = await lib.materializeToDataTable(source, pool);
  source.close?.();
  return { table, pool };
}

// Write the rows <keep> (indices, in order) of <table> to <outPath>. 3.10
// writes chunk sources only, so the kept rows are gathered into one.
export async function writeRows(lib, { table, pool }, keep, outPath) {
  const name = basename(outPath);
  const writeFs = new lib.MemoryFileSystem();
  await lib.writeSource({
    filename: name,
    outputFormat: lib.getOutputFormat(name, {}),
    source: lib.dataTableToChunkSource(table, undefined, Uint32Array.from(keep)),
    pool,
    options: {},
  }, writeFs);
  await writeFile(outPath, writeFs.results.get(name));
}

// The voxel of every row on a grid of edge <cell> sitting on multiples of
// it from the origin, so its boundaries do not move with the capture's
// extremes: { dims, key, coords, keyAt }. key[i] is row i's voxel key, each
// index offset by the lowest, so the key stays an exact integer for any
// capture that fits 2^53 voxels; null when it does not. coords(k) gives a
// key's [ix, iy, iz], and keyAt(ix, iy, iz) the key back, or undefined off
// the grid. (The library reads x and y negated, as --stats reports them; a
// grid does not care.)
export function voxelGrid(table, cell) {
  const n = table.numRows;
  const [x, y, z] = ['x', 'y', 'z'].map((c) => table.getColumnByName(c).data);
  const lo = [x, y, z].map((a) => Math.floor(a.reduce((m, v) => (v < m ? v : m), Infinity) / cell));
  const hi = [x, y, z].map((a) => Math.floor(a.reduce((m, v) => (v > m ? v : m), -Infinity) / cell));
  const dims = lo.map((l, i) => hi[i] - l + 1);
  if (dims[0] * dims[1] * dims[2] > Number.MAX_SAFE_INTEGER) return null;
  const keyAt = (ix, iy, iz) => (
    ix < 0 || iy < 0 || iz < 0 || ix >= dims[0] || iy >= dims[1] || iz >= dims[2]
      ? undefined
      : ix + dims[0] * (iy + dims[1] * iz));
  const coords = (k) => {
    const ix = k % dims[0], rest = (k - ix) / dims[0];
    const iy = rest % dims[1];
    return [ix, iy, (rest - iy) / dims[1]];
  };
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    key[i] = keyAt(Math.floor(x[i] / cell) - lo[0], Math.floor(y[i] / cell) - lo[1], Math.floor(z[i] / cell) - lo[2]);
  }
  return { dims, key, coords, keyAt };
}

// The error a step throws when <cell> is too fine for voxelGrid, naming the
// step's own flag.
export const gridTooFine = (cell, flag) =>
  new Error(`a ${cell} m voxel grid over this capture has too many cells; use a larger ${flag}`);
