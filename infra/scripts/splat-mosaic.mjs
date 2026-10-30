// Every cleaned scan, in one frame, cut into 100 m tiles, the best scan per
// 1 m voxel. The spec is specs/splat-mosaic.md; which scan is best is
// voxel-quality.mjs's, behind the seam in specs/voxel-quality.md.
//
//   node scripts/splat-mosaic.mjs        # from infra/
//
// Reads every data/3dgs/clean/<scan>.ply and, for its frame, the header of
// data/3dgs/original/<scan>/point_cloud.ply; never writes either. Writes
// data/3dgs/tiles/<tile>.ply, tiles/mosaic.json and data/3dgs/georef.csv,
// replacing the previous mosaic whole, or leaving it as it was on a failure.
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { georeference, layout } from './ply-header.mjs';

const MOSAIC_REVISION = 1;
const TILE_M = 100;
const HALF_M = TILE_M / 2;
const COLUMNS = TILE_M * TILE_M; // 1 m voxel columns in a tile
// The ground: the lowest height bin holding at least this fraction of the
// peak bin's splats (specs/splat-mosaic.md, *The ground*).
const GROUND_BIN_M = 0.1;
const GROUND_PEAK_FRACTION = 0.2;

const ORIGINAL = process.env.SPLATS_ORIGINAL_DIR ?? 'data/3dgs/original';
const CLEAN = process.env.SPLATS_CLEAN_DIR ?? 'data/3dgs/clean';
const TILES = process.env.SPLATS_TILES_DIR ?? 'data/3dgs/tiles';
const GEOREF = process.env.SPLATS_GEOREF ?? 'data/3dgs/georef.csv';
// The fewest splats a tile keeps; fewer is a scan's stray fringe, with no
// ground to stand on. Overridable for tests only, whose scenes are tiny.
const MIN_TILE_SPLATS = Number(process.env.SPLATS_MIN_TILE_SPLATS || 10000);
// For tests and experiments only: another module with the same seam.
const QUALITY = process.env.SPLATS_QUALITY_MODULE
  ? resolve(process.env.SPLATS_QUALITY_MODULE)
  : fileURLToPath(new URL('./voxel-quality.mjs', import.meta.url));

// The tile's properties, in the order they are written. A cleaned scan must
// carry every one of them as a float; anything else it carries (the zero
// normals) is dropped. All but x y z are copied unchanged, bit for bit.
const PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

// A bucket record: the 14 properties as float32, each at its index in PROPS
// (AT), x y z already in the tile's frame; then, as int32, the voxel's height
// index (H_AT) and its column in the tile (COL_AT).
const AT = Object.fromEntries(PROPS.map((p, k) => [p, k]));
const H_AT = PROPS.length;
const COL_AT = PROPS.length + 1;
const REC_WORDS = PROPS.length + 2;
const REC_BYTES = REC_WORDS * 4;
// The quality seam's field for each property after x y z (specs/voxel-quality.md).
const VOXEL_COPIES = [['dc0', 'f_dc_0'], ['dc1', 'f_dc_1'], ['dc2', 'f_dc_2'], ['opacity', 'opacity'],
  ['scale0', 'scale_0'], ['scale1', 'scale_1'], ['scale2', 'scale_2'],
  ['rot0', 'rot_0'], ['rot1', 'rot_1'], ['rot2', 'rot_2'], ['rot3', 'rot_3']];
const CHUNK_VERTICES = 1 << 16;

let work; // the run's temporary directory, inside TILES
let made; // the first directory of TILES's path this run created, if any
let staged; // georef.csv, staged beside GEOREF until it is renamed in
try {
  await main();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
  // A failed run leaves no directory it made, either: what is under it is
  // this run's alone.
  if (made) rmSync(made, { recursive: true, force: true });
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
  if (staged) rmSync(staged, { force: true });
}

async function main() {
  if (!(Number.isInteger(MIN_TILE_SPLATS) && MIN_TILE_SPLATS > 0)) {
    throw new Error(`SPLATS_MIN_TILE_SPLATS is '${process.env.SPLATS_MIN_TILE_SPLATS}'; it must be a positive integer`);
  }
  const quality = await import(pathToFileURL(QUALITY).href);
  for (const k of ['name', 'version', 'score', 'choose']) {
    if (quality[k] === undefined) throw new Error(`${QUALITY} does not export ${k}`);
  }

  // The scans: every clean/<scan>.ply, in byte order. A leading '.' is a
  // temporary file of process-splat.sh's, not a scan.
  const names = existsSync(CLEAN)
    ? readdirSync(CLEAN).filter((f) => f.endsWith('.ply') && !f.startsWith('.')).map((f) => f.slice(0, -4)).sort(byteOrder)
    : [];
  if (names.length === 0) throw new Error(`no cleaned scans in ${CLEAN} (run ./scripts/process-splat.sh <scan> first)`);

  const scans = [];
  for (const scan of names) {
    if (!existsSync(join(ORIGINAL, scan))) throw new Error(`${scan}: ${join(CLEAN, scan)}.ply has no scan folder in ${ORIGINAL}`);
    const geo = await georeference(ORIGINAL, scan);
    const path = join(CLEAN, `${scan}.ply`);
    const ply = await layout(path, `${scan}: ${path}`);
    for (const p of PROPS) {
      if (!ply.props.has(p)) throw new Error(`${scan}: ${path} has no property ${p}`);
      if (!['float', 'float32'].includes(ply.props.get(p).type)) throw new Error(`${scan}: ${path} property ${p} must be float`);
    }
    if ([...ply.props.keys()].some((p) => p.startsWith('f_rest_'))) {
      throw new Error(`${scan}: ${path} carries spherical harmonics beyond degree 0, which the mosaic does not support`);
    }
    scans.push({ scan, path, ply, epsg: geo.epsg, offset: geo.offset, kept: 0, voxelsWon: 0 });
  }
  const epsgs = [...new Set(scans.map((s) => s.epsg))];
  if (epsgs.length > 1) {
    throw new Error(`the scans are in ${epsgs.length} CRSs (${scans.map((s) => `${s.scan} EPSG:${s.epsg}`).join(', ')}); the mosaic needs one UTM zone`);
  }
  // The common frame: the one UTM zone, heights ellipsoidal as RTK gave them.
  const epsg = epsgs[0];

  made = mkdirSync(TILES, { recursive: true });
  work = mkdtempSync(join(TILES, '.mosaic-'));
  console.log(`==> ${scans.length} scans, EPSG:${epsg}; ${TILE_M} m tiles, 1 m voxels, quality ${quality.name} v${quality.version}`);

  // 1. Bucket: each scan once, into (tile, scan) files.
  const tiles = new Map(); // tile key → { i, j, id, buckets: Map(scan index → bucket path) }
  scans.forEach((s, si) => bucket(s, si, epsg, tiles));

  // 2. Per tile: score, choose, write.
  // A tile under MIN_TILE_SPLATS is dropped: no file, no row, in no count.
  const all = [...tiles.values()].sort((a, b) => byteOrder(a.id, b.id));
  const keptTiles = [], report = [], dropped = [];
  for (const t of all) {
    const row = writeTile(t, scans, quality, epsg);
    if (row.dropped) dropped.push({ id: t.id, splats: row.splats });
    else { keptTiles.push(t); report.push(row); }
  }
  const steps = groundSteps(keptTiles, report);

  // The run's report and the tiles' georeference.
  const totals = {
    splats_in: scans.reduce((a, s) => a + s.ply.count, 0),
    splats_kept: report.reduce((a, t) => a + t.splats, 0),
    splats_dropped: dropped.reduce((a, t) => a + t.splats, 0),
    voxels: report.reduce((a, t) => a + t.voxels, 0),
    contested_voxels: report.reduce((a, t) => a + t.contested_voxels, 0),
    largest_ground_step_m: steps.length ? Math.max(...steps.map((p) => p.step_m)) : null,
  };
  const mosaic = {
    revision: MOSAIC_REVISION,
    quality: { name: quality.name, version: quality.version },
    ground: { bin_m: GROUND_BIN_M, peak_fraction: GROUND_PEAK_FRACTION },
    epsg,
    scans: scans.map((s) => ({ scan: s.scan, offset: s.offset, splats: s.ply.count, kept: s.kept, voxels_won: s.voxelsWon })),
    tiles: report,
    dropped_tiles: dropped,
    ground_steps: steps,
    totals,
  };
  writeFileSync(join(work, 'mosaic.json'), `${JSON.stringify(mosaic, null, 2)}\n`);
  // georef.csv is staged beside its destination, so that every rename of the
  // swap stays on one filesystem.
  const rows = keptTiles.map((t, k) => [t.id, `${t.id}.ply`, epsg, t.i * TILE_M + HALF_M, t.j * TILE_M + HALF_M, 0, report[k].ground.ground_m].join(','));
  mkdirSync(dirname(GEOREF), { recursive: true });
  staged = join(dirname(GEOREF), `.${basename(GEOREF)}.${process.pid}`);
  writeFileSync(staged, ['SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ,GROUNDZ', ...rows, ''].join('\n'));

  // 3. Swap.
  swap(keptTiles);

  for (const s of scans) console.log(`    ${s.scan}: ${s.ply.count} splats, ${s.kept} kept (${s.voxelsWon} voxels won)`);
  console.log(`    ${keptTiles.length} tiles, ${totals.voxels} voxels (${totals.contested_voxels} contested); ${totals.splats_kept} of ${totals.splats_in} splats kept`);
  if (dropped.length) {
    console.log(`    ${dropped.length} tiles under ${MIN_TILE_SPLATS} splats dropped, ${totals.splats_dropped} splats: ${dropped.map((t) => `${t.id} (${t.splats})`).join(', ')}`);
  }
  const largest = steps.find((p) => p.step_m === totals.largest_ground_step_m);
  console.log(largest
    ? `    largest ground step between neighbouring tiles: ${largest.step_m} m (${largest.tiles.join(' | ')})`
    : '    no two tiles share an edge: no ground steps');
  console.log(`    wrote ${TILES}/<tile>.ply, ${join(TILES, 'mosaic.json')} and ${GEOREF}`);
}

// The old tiles and mosaic.json aside into the work directory, the new ones
// in, georef.csv over the old one last. On any failure the new files are
// removed and the old ones moved back, so the previous mosaic stands.
function swap(keptTiles) {
  const aside = join(work, 'previous');
  mkdirSync(aside);
  const movedAside = [], placed = [];
  try {
    for (const f of readdirSync(TILES)) {
      if (f.startsWith('.') || !(f.endsWith('.ply') || f === 'mosaic.json')) continue;
      renameSync(join(TILES, f), join(aside, f));
      movedAside.push(f);
    }
    for (const f of [...keptTiles.map((t) => `${t.id}.ply`), 'mosaic.json']) {
      renameSync(join(work, f), join(TILES, f));
      placed.push(f);
    }
    renameSync(staged, GEOREF);
    staged = undefined;
  } catch (e) {
    for (const f of placed) rmSync(join(TILES, f), { force: true });
    for (const f of movedAside) renameSync(join(aside, f), join(TILES, f));
    throw e;
  }
}

// Streams one scan, moving each splat into the common frame in double
// precision and appending it, in its tile's frame, to its (tile, scan) bucket.
function bucket(s, si, epsg, tiles) {
  const { ply } = s;
  const [ox, oy, oz] = s.offset;
  const propAt = PROPS.map((p) => ply.props.get(p).offset);
  const writers = new Map(); // tile key → { fd, f32, i32, used }
  const fd = openSync(s.path, 'r');
  const buf = Buffer.alloc(CHUNK_VERTICES * ply.stride);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    for (let done = 0; done < ply.count;) {
      const want = Math.min(CHUNK_VERTICES, ply.count - done) * ply.stride;
      const got = readSync(fd, buf, 0, want, ply.headerLen + done * ply.stride);
      if (got !== want) throw new Error(`${s.scan}: ${s.path} ended early`);
      for (let o = 0; o < want; o += ply.stride) {
        const E = ox + dv.getFloat32(o + propAt[0], true);
        const N = oy + dv.getFloat32(o + propAt[1], true);
        const H = oz + dv.getFloat32(o + propAt[2], true);
        const i = Math.floor(E / TILE_M), j = Math.floor(N / TILE_M);
        const key = tileKey(i, j);
        let w = writers.get(key);
        if (!w) {
          let t = tiles.get(key);
          if (!t) {
            t = { i, j, id: `${epsg}-${i * TILE_M}-${j * TILE_M}`, buckets: new Map() };
            tiles.set(key, t);
          }
          const path = join(work, `b-${i}-${j}-${si}.bin`);
          const ab = new ArrayBuffer(CHUNK_VERTICES * REC_BYTES);
          w = { fd: openSync(path, 'w'), ab, f32: new Float32Array(ab), i32: new Int32Array(ab), used: 0 };
          writers.set(key, w);
          t.buckets.set(si, path);
        }
        const r = w.used * REC_WORDS;
        const cx = i * TILE_M + HALF_M, cy = j * TILE_M + HALF_M;
        w.f32[r + AT.x] = E - cx;
        w.f32[r + AT.y] = N - cy;
        w.f32[r + AT.z] = H;
        for (let a = 3; a < PROPS.length; a++) w.f32[r + a] = dv.getFloat32(o + propAt[a], true);
        w.i32[r + H_AT] = Math.floor(H);
        w.i32[r + COL_AT] = (Math.floor(E) - i * TILE_M) * TILE_M + (Math.floor(N) - j * TILE_M);
        if (++w.used === CHUNK_VERTICES) flush(w);
      }
      done += want / ply.stride;
    }
  } finally {
    closeSync(fd);
    for (const w of writers.values()) { flush(w); closeSync(w.fd); }
  }
}

function flush(w) {
  if (w.used) writeSync(w.fd, new Uint8Array(w.ab, 0, w.used * REC_BYTES));
  w.used = 0;
}

// Scores every (voxel, scan) of one tile, chooses each voxel's scan, and
// writes the tile's .ply into the work directory. Returns its report row.
function writeTile(t, scans, quality, epsg) {
  const scanIndices = [...t.buckets.keys()].sort((a, b) => a - b); // scan name order
  const { data, candidates } = scoreTile(t, scanIndices, quality);
  const { winners, wonBy, contested } = chooseWinners(candidates, quality);
  const { keptBy, total } = countKept(scanIndices, data, winners);
  if (total < MIN_TILE_SPLATS) {
    console.log(`    ${t.id}: ${total} splats, under ${MIN_TILE_SPLATS}: dropped`);
    return { id: t.id, splats: total, dropped: true };
  }
  const ground = groundOf(scanIndices, data, winners);
  writePly(join(work, `${t.id}.ply`), tileHeader(t, total, epsg, quality), scanIndices, data, winners);

  const won = {};
  for (const si of scanIndices) {
    const s = scans[si];
    s.kept += keptBy.get(si);
    s.voxelsWon += wonBy.get(si) ?? 0;
    if (wonBy.get(si)) won[s.scan] = wonBy.get(si);
  }
  console.log(`    ${t.id}: ${total} splats, ${candidates.size} voxels (${contested} contested), ground ${ground.ground_m} m`);
  return { id: t.id, splats: total, voxels: candidates.size, contested_voxels: contested, won_by: won, ground };
}

// Reads the tile's buckets, deleting each once read, and scores every voxel
// of every scan in it. Returns the records by scan index, and each voxel's
// candidates, in scan name order.
function scoreTile(t, scanIndices, quality) {
  const data = new Map(); // scan index → { f32, i32, n, keys }
  const candidates = new Map(); // voxel key → [{ si, score }], in scan name order
  for (const si of scanIndices) {
    const path = t.buckets.get(si);
    const bytes = readFileSync(path);
    unlinkSync(path);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const f32 = new Float32Array(ab), i32 = new Int32Array(ab);
    const n = bytes.byteLength / REC_BYTES;
    const keys = new Float64Array(n);
    for (let k = 0; k < n; k++) keys[k] = i32[k * REC_WORDS + H_AT] * COLUMNS + i32[k * REC_WORDS + COL_AT];
    data.set(si, { f32, i32, n, keys });
    for (const [key, score] of scoreVoxels(f32, i32, keys, n, quality)) {
      let c = candidates.get(key);
      if (!c) candidates.set(key, (c = []));
      c.push({ si, score });
    }
  }
  return { data, candidates };
}

// Each voxel's scan, by the quality module's choice.
function chooseWinners(candidates, quality) {
  const winners = new Map(); // voxel key → scan index
  const wonBy = new Map(); // scan index → voxels won
  let contested = 0;
  for (const [key, c] of candidates) {
    if (c.length > 1) contested++;
    const best = quality.choose(c.map((x) => x.score));
    if (!Array.isArray(best) || best.length === 0 || best.some((k) => !(k >= 0 && k < c.length))) {
      throw new Error(`${quality.name}: choose returned ${JSON.stringify(best)} for ${c.length} candidates`);
    }
    // The candidates are in scan name order, so the first index is the tie-break.
    const si = c[Math.min(...best)].si;
    winners.set(key, si);
    wonBy.set(si, (wonBy.get(si) ?? 0) + 1);
  }
  return { winners, wonBy, contested };
}

// The splats each scan keeps in the tile, and their sum.
function countKept(scanIndices, data, winners) {
  let total = 0;
  const keptBy = new Map(); // scan index → splats kept
  for (const si of scanIndices) {
    const { keys, n } = data.get(si);
    let count = 0;
    for (let k = 0; k < n; k++) if (winners.get(keys[k]) === si) count++;
    keptBy.set(si, count);
    total += count;
  }
  return { keptBy, total };
}

function tileHeader(t, total, epsg, quality) {
  return [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${total}`,
    `comment epsg ${epsg}`,
    `comment offsetx ${t.i * TILE_M + HALF_M}`,
    `comment offsety ${t.j * TILE_M + HALF_M}`,
    'comment offsetz 0',
    `comment mosaic splat-mosaic revision ${MOSAIC_REVISION}, quality ${quality.name} v${quality.version}`,
    ...PROPS.map((p) => `property float ${p}`),
    'end_header',
    '',
  ].join('\n');
}

// The kept splats, scan by scan, after the header. Each scan's records are
// let go once written.
function writePly(path, header, scanIndices, data, winners) {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, header);
    const out = new Float32Array(CHUNK_VERTICES * PROPS.length);
    for (const si of scanIndices) {
      const { f32, keys, n } = data.get(si);
      let used = 0;
      for (let k = 0; k < n; k++) {
        if (winners.get(keys[k]) !== si) continue;
        out.set(f32.subarray(k * REC_WORDS, k * REC_WORDS + PROPS.length), used * PROPS.length);
        if (++used === CHUNK_VERTICES) { writeSync(fd, new Uint8Array(out.buffer)); used = 0; }
      }
      if (used) writeSync(fd, new Uint8Array(out.buffer, 0, used * PROPS.length * 4));
      data.delete(si);
    }
  } finally {
    closeSync(fd);
  }
}

// The tile's ground: the lowest dense layer of its kept splats' heights, by
// a histogram of GROUND_BIN_M bins. Below the ground, 3DGS grows sparse
// layers of its own (reflections in puddles, glass and paving), which a low
// percentile would land in; the ground is usually the tile's largest
// horizontal surface, so it is the peak or a layer near it.
function groundOf(scanIndices, data, winners) {
  const forEachKeptZ = (fn) => {
    for (const si of scanIndices) {
      const { f32, keys, n } = data.get(si);
      for (let k = 0; k < n; k++) if (winners.get(keys[k]) === si) fn(f32[k * REC_WORDS + AT.z]);
    }
  };
  const bins = new Map();
  let lowest = Infinity;
  forEachKeptZ((z) => {
    const b = Math.floor(z / GROUND_BIN_M);
    bins.set(b, (bins.get(b) ?? 0) + 1);
    if (z < lowest) lowest = z;
  });
  // Two bins with the peak count: the lower is the peak, so peak_m does not
  // hang on the bins' order.
  let peak = -Infinity, peakCount = 0;
  for (const [b, c] of bins) if (c > peakCount || (c === peakCount && b < peak)) { peak = b; peakCount = c; }
  // At least a fifth of the peak, less a hair: 0.2 × 15 is
  // 3.0000000000000004, and a count of exactly a fifth must still count.
  let ground = Infinity;
  for (const [b, c] of bins) if (c >= GROUND_PEAK_FRACTION * peakCount - 1e-9 && b < ground) ground = b;
  const zs = [];
  forEachKeptZ((z) => { if (Math.floor(z / GROUND_BIN_M) === ground) zs.push(z); });
  return {
    ground_m: mm(median(zs)),
    bin_splats: zs.length,
    peak_m: mm(peak * GROUND_BIN_M),
    peak_splats: peakCount,
    lowest_m: mm(lowest),
  };
}

// Every pair of tiles sharing an edge, by id, and the step between their
// grounds.
function groundSteps(keptTiles, report) {
  const groundAt = new Map(keptTiles.map((t, k) => [tileKey(t.i, t.j), report[k].ground.ground_m]));
  const byKey = new Map(keptTiles.map((t) => [tileKey(t.i, t.j), t]));
  const steps = [];
  for (const t of keptTiles) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const n = byKey.get(tileKey(t.i + di, t.j + dj));
      if (!n) continue;
      const pair = [t.id, n.id].sort(byteOrder);
      steps.push({ tiles: pair, step_m: mm(Math.abs(groundAt.get(tileKey(t.i, t.j)) - groundAt.get(tileKey(n.i, n.j)))) });
    }
  }
  return steps.sort((a, b) => byteOrder(a.tiles[0], b.tiles[0]) || byteOrder(a.tiles[1], b.tiles[1]));
}

// A tile's key in the run's maps: its grid indices.
function tileKey(i, j) {
  return `${i},${j}`;
}

// To the millimetre, as a short decimal.
function mm(v) {
  return Math.round(v * 1000) / 1000;
}

// One scan's splats in one tile, grouped by voxel and scored there. Yields
// [voxel key, score].
function* scoreVoxels(f32, i32, keys, n, quality) {
  // Group by key: slots in first-seen order, then a counting sort.
  const slotOfKey = new Map();
  const slotOfSplat = new Int32Array(n);
  const counts = [];
  for (let k = 0; k < n; k++) {
    let slot = slotOfKey.get(keys[k]);
    if (slot === undefined) { slot = counts.length; slotOfKey.set(keys[k], slot); counts.push(0); }
    slotOfSplat[k] = slot;
    counts[slot]++;
  }
  const start = new Int32Array(counts.length + 1);
  for (let slot = 0; slot < counts.length; slot++) start[slot + 1] = start[slot] + counts[slot];
  const fill = start.slice(0, counts.length);
  const byVoxel = new Int32Array(n); // splat indices, voxel by voxel
  for (let k = 0; k < n; k++) byVoxel[fill[slotOfSplat[k]]++] = k;

  // The voxel's fields, reused from voxel to voxel; copies are the record's
  // properties after x y z, in VOXEL_COPIES's order.
  let cap = 0, fields, copies;
  for (const [key, slot] of slotOfKey) {
    const count = counts[slot];
    if (count > cap) {
      cap = Math.max(count, cap * 2, 64);
      fields = { x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap) };
      for (const [f] of VOXEL_COPIES) fields[f] = new Float32Array(cap);
      copies = VOXEL_COPIES.map(([f, p]) => [fields[f], AT[p]]);
    }
    for (let q = 0; q < count; q++) {
      const k = byVoxel[start[slot] + q], r = k * REC_WORDS;
      const h = i32[r + H_AT], col = i32[r + COL_AT];
      // Within the voxel, from its low corner: the tile's frame has its
      // origin at the centre, so the column's low corner is at col − 50.
      fields.x[q] = clamp01(f32[r + AT.x] + HALF_M - Math.floor(col / TILE_M));
      fields.y[q] = clamp01(f32[r + AT.y] + HALF_M - (col % TILE_M));
      fields.z[q] = clamp01(f32[r + AT.z] - h);
      for (const [arr, at] of copies) arr[q] = f32[r + at];
    }
    const view = { n: count };
    for (const f of Object.keys(fields)) view[f] = fields[f].subarray(0, count);
    yield [key, quality.score(view)];
  }
}

// [0, 1): the voxel and the splat were assigned in double precision, and the
// float32 tile coordinates can round onto a face.
function clamp01(a) {
  return a < 0 ? 0 : a >= 1 ? 0.99999994 : a;
}

// Byte order (UTF-8), which a plain sort (UTF-16 code units) is not.
function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function median(values) {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
