// The align step of process-splat.sh: check where a scan's point_cloud.ply
// sits against the scanner's RTK trajectory and lidar, and move its Gaussians
// by the rigid correction found, in the PLY's own frame (UTM less the header
// offset). A port of steps 1–2 of the XGRIDS handoff's align.py; its ENU
// conversion is left out on purpose.
//
//   node scripts/splat-align.mjs -- <scan dir> <out.ply> <out.json>
//
// Reads <scan dir>/point_cloud.ply, gnss.csv, poses.csv, octree.bin,
// metadata.json and map_config.json. Prints one JSON line. Exits 0 having
// written both outputs; 4 when validation fails, having written <out.json>
// but no <out.ply>; 1 on bad input. The rules and their numbers are in
// specs/splat-align.md.
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { utm, utmZone } from './utm.mjs';

const RTK_FIXED = 4;
const TOLERANCE_M = 0.10;
const MATCH_TOL_S = 0.05; // half the GNSS interval
const GNSS_HEADER = '#timestamp,status,latitude,longitude,altitude,';
const GAUSSIAN_SAMPLE = 3_000_000;
const LIDAR_SAMPLE = 300_000;
const ICP_ITERATIONS = 30;
// Nearest-neighbour distances stop here. A query farther than this from every
// Gaussian costs most of the tree to answer exactly — lidar over the half of a
// split scan the PLY does not hold, as on KZ0918-101007-1, took 8 min — and
// its exact distance changes nothing unless the median itself is over CAP / 3,
// when the first rounds' limit (3 × median) differs from align.py's. A capture
// that far off fails validation either way.
const NN_CAP_M = 20;
const PLY_TYPES = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8 };
const POTREE_TYPES = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, double: 8 };

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [scanDir, outPly, outJson] = args;
if (!outJson) {
  console.error('usage: node splat-align.mjs -- <scan dir> <out.ply> <out.json>');
  process.exit(2);
}
const scan = scanDir.replace(/\/+$/, '').split('/').pop();
const fail = (file, msg) => { console.error(`error: ${scan}: ${file}: ${msg}`); process.exit(1); };
const num = (raw, file, what) => {
  const v = Number(raw);
  if (raw === undefined || String(raw).trim() === '' || !Number.isFinite(v)) fail(file, `${what}: '${raw}' is not a number`);
  return v;
};

// ---------- small linear algebra (row-major 3×3) ----------

const mulMV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const mulMM = (a, b) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return r;
};
const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Rotation of quaternion (x, y, z, w) applied to v; normalised as scipy does.
function rotateByQuat(qx, qy, qz, qw, v) {
  const s = Math.hypot(qx, qy, qz, qw);
  const x = qx / s, y = qy / s, z = qz / s, w = qw / s;
  // v + 2w(q×v) + 2 q×(q×v)
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

// Unit quaternion (w, x, y, z) of a rotation matrix (Shepperd).
function quatOf(m) {
  const tr = m[0] + m[4] + m[8];
  let w, x, y, z;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  return [w, x, y, z];
}

const rotationDeg = (m) => (Math.acos(Math.min(1, Math.max(-1, (m[0] + m[4] + m[8] - 1) / 2))) * 180) / Math.PI;

// Largest-eigenvalue eigenvector of a symmetric 4×4 matrix, by Jacobi sweeps.
function topEigenvector(a) {
  const m = a.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += m[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(m[p][q]) < 1e-300) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const mkp = m[k][p], mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < 4; k++) {
          const mpk = m[p][k], mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (m[i][i] > m[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

// R, t minimising ‖R·src + t − dst‖, no scale, never a reflection — what
// align.py's Kabsch gives, by Horn's quaternion method. src, dst: Float64Array
// of x, y, z triples; `use` (optional) picks the pairs.
function fitRigid(src, dst, use) {
  const idx = use ?? Array.from({ length: src.length / 3 }, (_, i) => i);
  const sc = [0, 0, 0], dc = [0, 0, 0];
  for (const i of idx) for (let k = 0; k < 3; k++) { sc[k] += src[3 * i + k]; dc[k] += dst[3 * i + k]; }
  for (let k = 0; k < 3; k++) { sc[k] /= idx.length; dc[k] /= idx.length; }
  const S = new Array(9).fill(0); // Σ (src − sc)(dst − dc)ᵀ
  for (const i of idx) {
    const a = [src[3 * i] - sc[0], src[3 * i + 1] - sc[1], src[3 * i + 2] - sc[2]];
    const b = [dst[3 * i] - dc[0], dst[3 * i + 1] - dc[1], dst[3 * i + 2] - dc[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[3 * r + c] += a[r] * b[c];
  }
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const [w, x, y, z] = topEigenvector([
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]);
  const R = [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
  const Rs = mulMV(R, sc);
  return { R, t: [dc[0] - Rs[0], dc[1] - Rs[1], dc[2] - Rs[2]] };
}

function transformInPlace(pts, R, t) {
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    pts[i] = R[0] * x + R[1] * y + R[2] * z + t[0];
    pts[i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
    pts[i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
}

// numpy's percentile (linear interpolation) and median.
function percentile(values, p) {
  const s = Float64Array.from(values).sort();
  if (s.length === 0) return NaN;
  const pos = (p / 100) * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const median = (values) => percentile(values, 50);

// ---------- sampling ----------

// mulberry32: a seeded PRNG, so a re-run draws the same samples. It does not
// reproduce numpy's draws; results match align.py's to the sampling's noise.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// k distinct indices of [0, n), by a partial Fisher–Yates shuffle; all of
// them, in order, when k >= n.
function sample(random, n, k) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  if (k >= n) return idx;
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(random() * (n - i));
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  return idx.subarray(0, k);
}

// ---------- nearest neighbours ----------

// A static 3D k-d tree: the points are reordered so each node is the middle of
// its range, split on the range's widest axis.
class KdTree {
  constructor(pts) {
    const n = pts.length / 3;
    this.n = n;
    this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    this.src = pts;
    this.axis = new Uint8Array(n);
    this.build(0, n);
    this.p = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) this.p[3 * i + k] = pts[3 * this.order[i] + k];
  }

  build(lo, hi) {
    while (hi - lo > 1) {
      const { order, src } = this;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = lo; i < hi; i++) {
        for (let k = 0; k < 3; k++) {
          const v = src[3 * order[i] + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const ax = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
      const mid = (lo + hi) >> 1;
      this.select(lo, hi - 1, mid, ax);
      this.axis[mid] = ax;
      this.build(lo, mid);
      lo = mid + 1;
    }
  }

  // Quickselect: order[k] ends where it would be if [l, r] were sorted on ax.
  select(l, r, k, ax) {
    const { order, src } = this;
    while (r > l) {
      const pivot = src[3 * order[(l + r) >> 1] + ax];
      let i = l, j = r;
      while (i <= j) {
        while (src[3 * order[i] + ax] < pivot) i++;
        while (src[3 * order[j] + ax] > pivot) j--;
        if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
      }
      if (k <= j) r = j; else if (k >= i) l = i; else return;
    }
  }

  // The distance to the nearest point, and that point's index in `pts`; or
  // `cap` and -1 when no point is that close.
  nearest(x, y, z, cap = NN_CAP_M) {
    this.bestD = cap * cap;
    this.bestI = -1;
    this.q = [x, y, z];
    this.off = [0, 0, 0];
    this.search(0, this.n, 0);
    return this.bestI < 0 ? [cap, -1] : [Math.sqrt(this.bestD), this.order[this.bestI]];
  }

  // `rd` is the squared distance from the query to the range's cell, kept
  // per axis in `off` (Arya & Mount's incremental distance), so a whole
  // subtree farther than the best so far is skipped, not just one past its
  // splitting plane.
  search(lo, hi, rd) {
    while (hi > lo) {
      const mid = (lo + hi) >> 1, p = this.p, o = 3 * mid, q = this.q;
      const dx = p[o] - q[0], dy = p[o + 1] - q[1], dz = p[o + 2] - q[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < this.bestD) { this.bestD = d; this.bestI = mid; }
      const ax = this.axis[mid];
      const diff = q[ax] - p[o + ax];
      const [nearLo, nearHi, farLo, farHi] = diff < 0 ? [lo, mid, mid + 1, hi] : [mid + 1, hi, lo, mid];
      this.search(nearLo, nearHi, rd);
      const old = this.off[ax];
      const farRd = rd - old * old + diff * diff;
      if (farRd >= this.bestD) return;
      this.off[ax] = diff;
      this.search(farLo, farHi, farRd);
      this.off[ax] = old;
      return;
    }
  }

  // Distances and indices for every point of `pts`, each searched no farther
  // than `cap`.
  query(pts, cap = NN_CAP_M) {
    const m = pts.length / 3, d = new Float64Array(m), j = new Int32Array(m);
    for (let i = 0; i < m; i++) [d[i], j[i]] = this.nearest(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], cap);
    return { d, j };
  }
}

// ---------- inputs ----------

async function readPly(path) {
  const file = 'point_cloud.ply';
  const { size } = await stat(path);
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    await fh.read(head, 0, head.length, 0);
    const text = head.toString('latin1');
    const end = text.indexOf('end_header\n');
    if (!text.startsWith('ply\n') || end < 0) fail(file, 'not a PLY with an LF header');
    const headerLen = end + 'end_header\n'.length;
    const lines = text.slice(0, end).split('\n').filter((l) => l !== '');
    if (!lines.includes('format binary_little_endian 1.0')) fail(file, 'only binary_little_endian 1.0 is supported');
    const elements = lines.filter((l) => l.startsWith('element '));
    if (elements.length !== 1 || !elements[0].startsWith('element vertex ')) fail(file, 'must have exactly one element, vertex');
    const count = num(elements[0].split(' ')[2], file, 'vertex count');
    const props = new Map();
    let stride = 0;
    for (const l of lines.filter((x) => x.startsWith('property '))) {
      const [, type, name] = l.split(' ');
      if (!PLY_TYPES[type]) fail(file, `property '${l}' is not supported`);
      props.set(name, { type, offset: stride });
      stride += PLY_TYPES[type];
    }
    for (const p of ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
      if (!props.has(p)) fail(file, `has no property ${p}`);
      if (!['float', 'float32'].includes(props.get(p).type)) fail(file, `property ${p} must be float`);
    }
    const normals = ['nx', 'ny', 'nz'].every((p) => ['float', 'float32'].includes(props.get(p)?.type));
    if (size !== headerLen + count * stride) fail(file, `is ${size} bytes; its header says ${headerLen + count * stride}`);
    const comments = new Map();
    for (const l of lines) {
      const [kw, key, value, ...rest] = l.trim().split(/\s+/);
      if (kw === 'comment' && key && value !== undefined && rest.length === 0) comments.set(key, value);
    }
    const field = (key) => {
      if (!comments.has(key)) fail(file, `has no 'comment ${key}' georeference`);
      return num(comments.get(key), file, `comment ${key}`);
    };
    const epsg = field('epsg');
    const zone = utmZone(epsg);
    if (!zone) fail(file, `is in EPSG:${epsg}; only WGS 84 / UTM (32601–32660, 32701–32760) is supported`);
    for (const axis of 'xyz') {
      if (comments.has(`shift${axis}`) && field(`shift${axis}`) !== 0) fail(file, `has shift${axis} ${comments.get(`shift${axis}`)}; only 0 is supported`);
      if (comments.has(`scale${axis}`) && field(`scale${axis}`) !== 1) fail(file, `has scale${axis} ${comments.get(`scale${axis}`)}; only 1 is supported`);
    }
    const offset = [field('offsetx'), field('offsety'), field('offsetz')];
    // Read whole, in chunks: readFile stops at 2 GB, and the body is edited in place.
    const body = Buffer.alloc(count * stride);
    for (let pos = 0; pos < body.length;) {
      const { bytesRead } = await fh.read(body, pos, Math.min(256 << 20, body.length - pos), headerLen + pos);
      if (bytesRead === 0) fail(file, 'ended early');
      pos += bytesRead;
    }
    return { lines, count, stride, props, normals, epsg, ...zone, offset, body };
  } finally {
    await fh.close();
  }
}

const textLines = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== '');

// gnss.csv: every fix's timestamp and status, sorted by time; numbers only for
// RTK fixes (a fix without a solution writes nan).
async function readGnss(path) {
  const file = 'gnss.csv';
  const [head, ...rows] = textLines(await readFile(path, 'utf8'));
  if (!head?.startsWith(GNSS_HEADER)) fail(file, `must start with the header ${GNSS_HEADER}…`);
  const fixes = rows.map((l, i) => {
    const f = l.split(',');
    const what = `line ${i + 2}`;
    const status = num(f[1], file, what);
    const fix = { t: num(f[0], file, what), status };
    if (status === RTK_FIXED) Object.assign(fix, { lat: num(f[2], file, what), lon: num(f[3], file, what), h: num(f[4], file, what) });
    return fix;
  });
  return fixes.sort((a, b) => a.t - b.t);
}

// poses.csv: timestamp,x,y,z,qx,qy,qz,qw, no header, sorted by time.
async function readPoses(path) {
  const file = 'poses.csv';
  return textLines(await readFile(path, 'utf8')).map((l, i) => {
    const f = l.split(',');
    if (f.length < 8) fail(file, `line ${i + 1} has ${f.length} columns; 8 are needed`);
    return f.slice(0, 8).map((v) => num(v, file, `line ${i + 1}`));
  }).sort((a, b) => a[0] - b[0]);
}

async function readLeverArm(path) {
  const file = 'map_config.json';
  let cfg;
  try { cfg = JSON.parse(await readFile(path, 'utf8')); } catch (e) { fail(file, `is not JSON: ${e.message}`); }
  const arm = cfg?.rtk_external_param;
  if (!Array.isArray(arm) || arm.length !== 3) fail(file, 'has no 3-number rtk_external_param');
  return arm.map((v) => num(v, file, 'rtk_external_param'));
}

// The lidar preview: octree.bin is a flat array of Potree 2.0 DEFAULT records;
// `position` is int32 × 3, times `scale` plus `offset`, in the poses' frame.
async function readLidar(dir, random) {
  let meta;
  try { meta = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')); } catch (e) { fail('metadata.json', `is not JSON: ${e.message}`); }
  if (meta.encoding !== 'DEFAULT') fail('metadata.json', `encoding is '${meta.encoding}'; only DEFAULT is supported`);
  let stride = 0, posOffset = -1;
  for (const a of meta.attributes ?? []) {
    const size = POTREE_TYPES[a.type];
    if (!size) fail('metadata.json', `attribute ${a.name} has unsupported type ${a.type}`);
    if (a.name === 'position') {
      if (a.type !== 'int32' || a.numElements !== 3) fail('metadata.json', 'position must be int32 × 3');
      posOffset = stride;
    }
    stride += size * a.numElements;
  }
  if (posOffset < 0) fail('metadata.json', 'has no position attribute');
  const scale = meta.scale, offset = meta.offset;
  if (![scale, offset].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) fail('metadata.json', 'needs 3-number scale and offset');
  const buf = await readFile(join(dir, 'octree.bin'));
  if (buf.length % stride !== 0) fail('octree.bin', `is ${buf.length} bytes, not a whole number of ${stride}-byte records`);
  const n = buf.length / stride;
  if (n === 0) fail('octree.bin', 'is empty');
  const pick = sample(random, n, LIDAR_SAMPLE);
  const pts = new Float64Array(3 * pick.length);
  pick.forEach((r, i) => {
    for (let k = 0; k < 3; k++) pts[3 * i + k] = buf.readInt32LE(r * stride + posOffset + 4 * k) * scale[k] + offset[k];
  });
  return pts;
}

// ---------- the steps ----------

// Index of the nearest ref time for each query time, or -1 past tol — as
// align.py's match_nearest.
function matchNearest(query, ref, tol) {
  return query.map((q) => {
    let lo = 0, hi = ref.length; // first index with ref >= q
    while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < q) lo = m + 1; else hi = m; }
    const right = Math.min(Math.max(lo, 1), ref.length - 1), left = right - 1;
    const near = Math.abs(ref[right] - q) < Math.abs(ref[left] - q) ? right : left;
    return Math.abs(ref[near] - q) <= tol ? near : -1;
  });
}

// 1. Poses → PLY frame, from RTK-fixed antenna positions; false fixes dropped
// at median + 6·MAD of the first fit's residuals.
function fitPosesToPly(gnss, poses, leverArm, ply) {
  const match = matchNearest(poses.map((p) => p[0]), gnss.map((g) => g.t), MATCH_TOL_S);
  const antenna = [], fix = [];
  poses.forEach((p, i) => {
    const g = match[i] >= 0 ? gnss[match[i]] : null;
    if (g?.status !== RTK_FIXED) return;
    const [E, N] = utm(g.lat, g.lon, ply.zone, ply.north);
    fix.push(E - ply.offset[0], N - ply.offset[1], g.h - ply.offset[2]);
    const arm = rotateByQuat(p[4], p[5], p[6], p[7], leverArm);
    antenna.push(p[1] + arm[0], p[2] + arm[1], p[3] + arm[2]);
  });
  const pairs = fix.length / 3;
  if (pairs < 3) return { pairs, reason: `${pairs} RTK-fixed pose/GNSS pair(s); at least 3 are needed` };
  const src = Float64Array.from(antenna), dst = Float64Array.from(fix);
  const residuals = ({ R, t }, idx) => idx.map((i) => {
    const p = mulMV(R, [src[3 * i], src[3 * i + 1], src[3 * i + 2]]);
    return Math.hypot(p[0] + t[0] - dst[3 * i], p[1] + t[1] - dst[3 * i + 1], p[2] + t[2] - dst[3 * i + 2]);
  });
  const all = Array.from({ length: pairs }, (_, i) => i);
  const res0 = residuals(fitRigid(src, dst), all);
  const med = median(res0), mad = median(res0.map((r) => Math.abs(r - med)));
  const keep = all.filter((i) => res0[i] < med + 6 * mad);
  const fit = fitRigid(src, dst, keep);
  const res = residuals(fit, keep);
  return {
    ...fit,
    pairs,
    stats: {
      rtk_fixed_pairs: pairs,
      false_fixes_dropped: pairs - keep.length,
      residual_p50_m: median(res),
      residual_p95_m: percentile(res, 95),
    },
  };
}

// Trimmed point-to-point ICP: R, t taking src onto the tree's points, and the
// final nearest distances. As align.py's icp.
function icp(src, tree) {
  let R = IDENTITY, t = [0, 0, 0];
  const cur = Float64Array.from(src);
  for (let i = 0; i < ICP_ITERATIONS; i++) {
    // After round 5 the limit is a fixed 0.2 m, so nothing past it is needed:
    // the search stops there, which makes those rounds cheap and changes no
    // pair. The first five need every distance, for the median.
    const { d, j } = i < 5 ? tree.query(cur) : tree.query(cur, 0.2);
    const limit = i < 5 ? Math.max(0.3, 3 * median(d)) : 0.2;
    const keep = [];
    for (let k = 0; k < d.length; k++) if (d[k] < limit && j[k] >= 0) keep.push(k);
    if (keep.length < 3) return { R, t, d: tree.query(cur).d };
    const target = new Float64Array(cur.length);
    for (const k of keep) for (let a = 0; a < 3; a++) target[3 * k + a] = tree.src[3 * j[k] + a];
    const step = fitRigid(cur, target, keep);
    transformInPlace(cur, step.R, step.t);
    R = mulMM(step.R, R);
    const tt = mulMV(step.R, t);
    t = [tt[0] + step.t[0], tt[1] + step.t[1], tt[2] + step.t[2]];
  }
  return { R, t, d: tree.query(cur).d };
}

const ply = await readPly(join(scanDir, 'point_cloud.ply'));
const [gnss, poses, leverArm] = await Promise.all([
  readGnss(join(scanDir, 'gnss.csv')),
  readPoses(join(scanDir, 'poses.csv')),
  readLeverArm(join(scanDir, 'map_config.json')),
]);
const random = rng(0); // per scan: a re-run draws the same samples

const { body, stride, props, count } = ply;
const f32 = (i, name) => body.readFloatLE(i * stride + props.get(name).offset);

// 1. poses → PLY frame
const rtk = fitPosesToPly(gnss, poses, leverArm, ply);

// 2. lidar vs the solid Gaussians
const pick = sample(random, count, GAUSSIAN_SAMPLE);
const target = [];
for (const i of pick) {
  const solid = f32(i, 'opacity') > 0 // sigmoid > 0.5
    && Math.exp(Math.max(f32(i, 'scale_0'), f32(i, 'scale_1'), f32(i, 'scale_2'))) < 0.3;
  if (solid) target.push(f32(i, 'x'), f32(i, 'y'), f32(i, 'z'));
}
const lidar = await readLidar(scanDir, random);

let reason = rtk.reason ?? null;
let R = IDENTITY, t = [0, 0, 0], nnBefore = [NaN], nnAfter = [NaN], inliers = 0;
if (!reason && target.length < 9) reason = `${target.length / 3} solid Gaussian(s) in the sample`;
if (!reason) {
  transformInPlace(lidar, rtk.R, rtk.t);
  const tree = new KdTree(Float64Array.from(target));
  nnBefore = tree.query(lidar).d;
  const fit = icp(lidar, tree);
  nnAfter = fit.d;
  // ICP takes the lidar onto the PLY; the PLY's correction is its inverse.
  R = transpose(fit.R);
  const rt = mulMV(R, fit.t);
  t = [-rt[0], -rt[1], -rt[2]];
  inliers = nnAfter.reduce((a, d) => a + (d < 0.1), 0) / nnAfter.length;
  if (!(inliers > 0.4)) reason = `ICP inliers ${inliers.toFixed(2)} <= 0.4`;
  else if (rtk.stats.residual_p95_m > TOLERANCE_M) reason = `RTK p95 ${rtk.stats.residual_p95_m.toFixed(2)} m > ${TOLERANCE_M.toFixed(2)} m`;
}

// How far the correction moves the capture: the most any bounding-box corner moves.
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < count; i++) {
  ['x', 'y', 'z'].forEach((c, k) => {
    const v = f32(i, c);
    if (v < lo[k]) lo[k] = v;
    if (v > hi[k]) hi[k] = v;
  });
}
let correctionMax = 0;
for (const cx of [lo[0], hi[0]]) for (const cy of [lo[1], hi[1]]) for (const cz of [lo[2], hi[2]]) {
  const p = mulMV(R, [cx, cy, cz]);
  correctionMax = Math.max(correctionMax, Math.hypot(p[0] + t[0] - cx, p[1] + t[1] - cy, p[2] + t[2] - cz));
}

const status = reason ? 'fail' : correctionMax <= TOLERANCE_M ? 'pass' : 'corrected';
const applied = status !== 'fail';
const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);
const report = {
  scan,
  status,
  ...(reason ? { reason } : {}),
  tolerance_m: TOLERANCE_M,
  source_ply: { epsg: ply.epsg, offset: ply.offset, gaussians: count },
  rtk_fit: rtk.stats ? Object.fromEntries(Object.entries(rtk.stats).map(([k, v]) => [k, r6(v)])) : { rtk_fixed_pairs: rtk.pairs },
  lidar_vs_ply: {
    nn_p50_m_before: r6(median(nnBefore)),
    nn_p50_m_after: r6(median(nnAfter)),
    'inliers_lt_0.1m_after': r6(inliers),
    correction_max_m: r6(correctionMax),
    correction_rot_deg: r6(rotationDeg(R)),
    correction_applied: applied,
  },
  correction: {
    rotation: [R.slice(0, 3), R.slice(3, 6), R.slice(6, 9)].map((row) => row.map((v) => Math.round(v * 1e12) / 1e12)),
    translation_m: t.map(r6),
  },
};
await writeFile(outJson, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  status, reason, rtk_p50_m: report.rtk_fit.residual_p50_m, rtk_p95_m: report.rtk_fit.residual_p95_m,
  correction_max_m: r6(correctionMax), correction_rot_deg: r6(rotationDeg(R)), correction_applied: applied,
}));
if (!applied) process.exit(4);

// 3. Apply: every centre p' = R·p + t; every rotation q(R)·q, keeping its
// stored magnitude (a zero quaternion becomes q(R), as in align.py); normals
// turned by R. Every other property is left byte for byte.
const [qw, qx, qy, qz] = quatOf(R);
const off = (name) => props.get(name).offset;
const [ox, oy, oz, or0, or1, or2, or3] = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map(off);
const nrm = ply.normals ? ['nx', 'ny', 'nz'].map(off) : null;
for (let i = 0; i < count; i++) {
  const b = i * stride;
  const p = mulMV(R, [body.readFloatLE(b + ox), body.readFloatLE(b + oy), body.readFloatLE(b + oz)]);
  body.writeFloatLE(p[0] + t[0], b + ox);
  body.writeFloatLE(p[1] + t[1], b + oy);
  body.writeFloatLE(p[2] + t[2], b + oz);
  if (nrm) {
    const nv = mulMV(R, nrm.map((o) => body.readFloatLE(b + o)));
    nrm.forEach((o, k) => body.writeFloatLE(nv[k], b + o));
  }
  let w = body.readFloatLE(b + or0), x = body.readFloatLE(b + or1), y = body.readFloatLE(b + or2), z = body.readFloatLE(b + or3);
  let mag = Math.hypot(w, x, y, z);
  if (mag === 0) { w = 1; x = y = z = 0; mag = 1; } else { w /= mag; x /= mag; y /= mag; z /= mag; }
  body.writeFloatLE(mag * (qw * w - qx * x - qy * y - qz * z), b + or0);
  body.writeFloatLE(mag * (qw * x + qx * w + qy * z - qz * y), b + or1);
  body.writeFloatLE(mag * (qw * y - qx * z + qy * w + qz * x), b + or2);
  body.writeFloatLE(mag * (qw * z + qx * y - qy * x + qz * w), b + or3);
}

// The header as it was, but for minx…maxz, which now describe the moved capture.
const nlo = [Infinity, Infinity, Infinity], nhi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < count; i++) {
  [ox, oy, oz].forEach((o, k) => {
    const v = body.readFloatLE(i * stride + o);
    if (v < nlo[k]) nlo[k] = v;
    if (v > nhi[k]) nhi[k] = v;
  });
}
const bounds = { minx: nlo[0], miny: nlo[1], minz: nlo[2], maxx: nhi[0], maxy: nhi[1], maxz: nhi[2] };
const header = ['ply', ...ply.lines.slice(1).map((l) => {
  const [kw, key, value, ...rest] = l.trim().split(/\s+/);
  return kw === 'comment' && key in bounds && value !== undefined && rest.length === 0 ? `comment ${key} ${bounds[key].toFixed(7)}` : l;
}), 'end_header', ''].join('\n');
const fh = await open(outPly, 'w');
try {
  await fh.write(Buffer.from(header, 'latin1'));
  for (let pos = 0; pos < body.length; pos += 256 << 20) await fh.write(body.subarray(pos, Math.min(body.length, pos + (256 << 20))));
} finally {
  await fh.close();
}
