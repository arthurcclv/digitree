// Write a scan's rows of control_points.csv from its own georeference: three
// RTK-fixed GNSS fixes spread wide and off a line, each put into the splat
// file's coordinates through the UTM offset in its PLY header.
//
//   node scripts/control-points.mjs [<scan>…]   # from infra/; default: every scan
//
// Reads original/<scan>/gnss.csv and point_cloud.ply's header, never writes
// original/. Replaces only the given scans' rows of control_points.csv and
// keeps every other row byte for byte. The rules and their numbers are in
// specs/control-points.md.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { utm } from './utm.mjs';

const ORIGINAL = process.env.SPLATS_ORIGINAL_DIR ?? 'data/3dgs/original';
const OUT = process.env.SPLATS_CONTROL_POINTS ?? 'data/3dgs/control_points.csv';
const HEADER = 'SplatID,File,Point,X,Y,Z,LAT,LON,H,Note';
const GNSS_HEADER = '#timestamp,status,latitude,longitude,altitude,';
const RTK_FIXED = '4';
const MIN_SPREAD_M = 2; // the loader's own minimums, caught here instead of at load
// process-splat.sh's single-file formats: a scan has exactly one of them.
const CAPTURES = ['ply', 'compressed.ply', 'sog', 'spz', 'splat', 'ksplat'].map((e) => `point_cloud.${e}`);
const PLY = 'point_cloud.ply';

const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

const hasBoth = (scan) => ['gnss.csv', PLY].every((f) => existsSync(join(ORIGINAL, scan, f)));

function scansToRun() {
  const given = process.argv.slice(2).filter((a) => a !== '--');
  if (given.length === 0) {
    if (!existsSync(ORIGINAL)) fail(`${ORIGINAL} does not exist`);
    const all = readdirSync(ORIGINAL).filter((d) => statSync(join(ORIGINAL, d)).isDirectory() && hasBoth(d)).sort();
    if (all.length === 0) fail(`no scan folder in ${ORIGINAL} has both gnss.csv and ${PLY}`);
    return all;
  }
  for (const scan of given) {
    if (scan.includes('/') || scan === '.' || scan === '..') fail(`'${scan}' must be a bare scan folder name, not a path`);
    const gnss = join(ORIGINAL, scan, 'gnss.csv');
    if (!existsSync(gnss)) fail(`${scan}: ${gnss} is missing`);
  }
  return given;
}

const lines = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== '');

function num(raw, what) {
  const v = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(v)) fail(`${what}: '${raw}' is not a number`);
  return v;
}

// The PLY header's comments, read without the vertices (the files are ~1 GB):
// `comment <key> <value>` lines up to end_header.
async function plyComments(path) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('latin1');
    const end = text.indexOf('end_header');
    if (!text.startsWith('ply') || end < 0) return null;
    const comments = new Map();
    for (const l of text.slice(0, end).split(/\r?\n/)) {
      const [kw, key, value, ...rest] = l.trim().split(/\s+/);
      if (kw === 'comment' && key && value !== undefined && rest.length === 0) comments.set(key, value);
    }
    return comments;
  } finally {
    await fh.close();
  }
}

// The capture's georeference: file (x, y, z) = (E, N, h) − offset, in the UTM
// zone `epsg` names. Verified on the KZ0918 scans, where the offset is the
// first GNSS fix to under 1 mm (specs/control-points.md). A shift or scale
// other than the identity is refused: what it would mean is unverified.
async function georeference(scan) {
  const found = CAPTURES.filter((f) => existsSync(join(ORIGINAL, scan, f)));
  if (found.length === 0) fail(`${scan}: no ${PLY} in ${join(ORIGINAL, scan)}`);
  if (found.length > 1) fail(`${scan}: more than one capture (${found.join(', ')}); keep one of them`);
  if (found[0] !== PLY) fail(`${scan}: ${found[0]} carries no georeference; only a ${PLY} with one can be placed from GNSS`);
  const c = await plyComments(join(ORIGINAL, scan, PLY));
  if (!c) fail(`${scan}: ${PLY} has no PLY header`);
  const field = (key) => {
    if (!c.has(key)) fail(`${scan}: ${PLY} has no 'comment ${key}' georeference`);
    return num(c.get(key), `${scan}: ${PLY} comment ${key}`);
  };
  const epsg = field('epsg');
  const north = epsg >= 32601 && epsg <= 32660;
  if (!north && !(epsg >= 32701 && epsg <= 32760)) fail(`${scan}: ${PLY} is in EPSG:${c.get('epsg')}; only WGS 84 / UTM (32601–32660, 32701–32760) is supported`);
  for (const axis of 'xyz') {
    if (c.has(`shift${axis}`) && field(`shift${axis}`) !== 0) fail(`${scan}: ${PLY} has shift${axis} ${c.get(`shift${axis}`)}; only 0 is supported`);
    if (c.has(`scale${axis}`) && field(`scale${axis}`) !== 1) fail(`${scan}: ${PLY} has scale${axis} ${c.get(`scale${axis}`)}; only 1 is supported`);
  }
  return { epsg, zone: epsg % 100, north, offset: [field('offsetx'), field('offsety'), field('offsetz')] };
}

// gnss.csv: #timestamp,status,latitude,longitude,altitude,… A fix without a
// solution writes `nan` (1,966 of KZ0918-075047's, none of them status 4), so
// only an RTK fix must have numbers. LAT/LON are kept as written.
async function readFixes(scan) {
  const [head, ...rows] = lines(await readFile(join(ORIGINAL, scan, 'gnss.csv'), 'utf8'));
  if (!head.startsWith(GNSS_HEADER)) fail(`${scan}: gnss.csv must start with the header ${GNSS_HEADER}…`);
  const fixes = [];
  rows.forEach((l, i) => {
    const f = l.split(',');
    if ((f[1] ?? '').trim() !== RTK_FIXED) return;
    const what = `${scan}: gnss.csv line ${i + 2}`;
    fixes.push({
      t: num(f[0], what), latV: num(f[2], what), lonV: num(f[3], what), h: num(f[4], what),
      tRaw: f[0].trim(), lat: f[2].trim(), lon: f[3].trim(),
    });
  });
  return fixes.sort((a, b) => a.t - b.t);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const offLine = (p, a, b) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / dist(a, b);

// The loader's own measure of how far points are from a line (04_splats.sql):
// the smallest singular value of the centred n×2 matrix of their x, y, the
// square root of the smaller eigenvalue of its 2×2 scatter matrix. Distance
// off the line 1–2 is not the same: (0,0) (100,0) (50,2) is 2 m off it, but
// its singular value is 1.63 m, and the loader refuses it.
function sigmaMin(ps) {
  const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
  const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of ps) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  return Math.sqrt(Math.max(0, (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2)));
}

// Points 1 and 2 are the farthest-apart pair, point 3 the farthest from the
// line through them, on the ground (x, y). Strict comparisons in time order,
// so a tie goes to the earlier fix and a re-run picks the same three.
function pick(scan, c) {
  if (c.length < 3) fail(`${scan}: ${c.length} RTK-fixed GNSS fix(es); at least 3 are needed`);
  let best = -1, p1, p2;
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      const d = dist(c[i], c[j]);
      if (d > best) { best = d; p1 = c[i]; p2 = c[j]; }
    }
  }
  let far = -1, p3;
  if (best > 0) {
    for (const p of c) {
      const d = offLine(p, p1, p2);
      if (d > far) { far = d; p3 = p; }
    }
  }
  if (best < MIN_SPREAD_M) fail(`${scan}: the RTK fixes are all within ${best.toFixed(3)} m; the loader needs points at least ${MIN_SPREAD_M} m apart`);
  const d13 = dist(p1, p3), d23 = dist(p2, p3);
  if (Math.min(d13, d23) < MIN_SPREAD_M) fail(`${scan}: point 3 is ${Math.min(d13, d23).toFixed(3)} m from another point; at least ${MIN_SPREAD_M} m is needed`);
  const across = sigmaMin([p1, p2, p3]);
  if (across < MIN_SPREAD_M) fail(`${scan}: the RTK fixes are too close to a line (spread across it is ${across.toFixed(3)} m); the loader needs at least ${MIN_SPREAD_M} m`);
  console.log(`${scan}: ${c.length} RTK fixes; 1–2 ${best.toFixed(2)} m, 1–3 ${d13.toFixed(2)} m, 2–3 ${d23.toFixed(2)} m, 3 is ${far.toFixed(2)} m off the line 1–2, spread across it ${across.toFixed(2)} m`);
  return [p1, p2, p3];
}

// Rounded first, so a value a hair below zero is written 0.000, not -0.000.
const fixed3 = (v) => { const r = Math.round(v * 1000) / 1000; return (r === 0 ? 0 : r).toFixed(3); };

async function rowsFor(scan) {
  const [geo, fixes] = await Promise.all([georeference(scan), readFixes(scan)]);
  const [ox, oy, oz] = geo.offset;
  console.log(`${scan}: EPSG:${geo.epsg}, offset ${ox} ${oy} ${oz}`);
  // The fix in the file's coordinates. 04_splats.sql reads X, Y, Z as file
  // coordinates and solves the scan's heading and origin from LAT/LON.
  const candidates = fixes.map((f) => {
    const [E, N] = utm(f.latV, f.lonV, geo.zone, geo.north);
    return { ...f, x: E - ox, y: N - oy, z: f.h - oz };
  });
  return pick(scan, candidates).map((p, i) =>
    // H blank: the loader reads it as 0, so the antenna sits on the map's ground.
    [scan, `${scan}.spz`, i + 1, fixed3(p.x), fixed3(p.y), fixed3(p.z), p.lat, p.lon, '', `gnss ${p.tRaw}; EPSG:${geo.epsg}`].join(','));
}

const scans = scansToRun();

// Every other capture's rows are kept as they are, in order.
let kept = [];
if (existsSync(OUT)) {
  const [head, ...rest] = (await readFile(OUT, 'utf8')).split('\n');
  if (head.replace(/\r$/, '') !== HEADER) fail(`${OUT} does not start with the header ${HEADER}; left untouched`);
  kept = rest.filter((l) => l.trim() !== '' && !scans.includes(l.slice(0, l.indexOf(','))));
}

const generated = [];
for (const scan of scans) generated.push(...await rowsFor(scan));

// Every scan succeeded: only now is the file replaced, through a rename.
const tmp = join(dirname(OUT), `.control_points.${process.pid}.tmp`);
try {
  await writeFile(tmp, [HEADER, ...kept, ...generated].join('\n') + '\n');
  await rename(tmp, OUT);
} catch (e) {
  await rm(tmp, { force: true });
  fail(`could not write ${OUT}: ${e.message}`);
}
console.log(`wrote ${generated.length} rows for ${scans.length} scan(s) to ${OUT}; kept ${kept.length} other row(s)`);
