// Readers shared by the XGRIDS deliveries (L2 Pro, K2, Lixel L3). Not a
// scanner module: it claims no source. The interface the scanner modules
// implement, and what each reads, are specs/scanners.md.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RTK_FIXED = 4;
const GNSS_HEADER = '#timestamp,status,latitude,longitude,altitude,';
const POTREE_TYPES = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, double: 8 };

// A delivered file that is there but wrong. splat-align.mjs prints
// `error: <scan>: <file>: <message>` and exits 1.
export class ScanFileError extends Error {
  constructor(file, message) {
    super(message);
    this.file = file;
  }
}

// Throws a ScanFileError: the file is there but wrong.
export const refuse = (file, msg) => { throw new ScanFileError(file, msg); };

export const num = (raw, file, what) => {
  const v = Number(raw);
  if (raw === undefined || String(raw).trim() === '' || !Number.isFinite(v)) refuse(file, `${what}: '${raw}' is not a number`);
  return v;
};

const textLines = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== '');

async function readJson(dir, file) {
  try { return JSON.parse(await readFile(join(dir, file), 'utf8')); } catch (e) { refuse(file, `is not JSON: ${e.message}`); }
}

// gnss.csv: every fix's timestamp and whether it is RTK-fixed, sorted by time;
// numbers only for RTK fixes (a fix without a solution writes nan).
export async function readGnss(dir) {
  const file = 'gnss.csv';
  const [head, ...rows] = textLines(await readFile(join(dir, file), 'utf8'));
  if (!head?.startsWith(GNSS_HEADER)) refuse(file, `must start with the header ${GNSS_HEADER}…`);
  const fixes = rows.map((l, i) => {
    const f = l.split(',');
    const what = `line ${i + 2}`;
    const fixed = num(f[1], file, what) === RTK_FIXED;
    const fix = { t: num(f[0], file, what), fixed };
    if (fixed) Object.assign(fix, { lat: num(f[2], file, what), lon: num(f[3], file, what), h: num(f[4], file, what) });
    return fix;
  });
  return fixes.sort((a, b) => a.t - b.t);
}

// poses.csv: timestamp,x,y,z,qx,qy,qz,qw, sorted by time. The L2 Pro and K2
// write no header; the L3 writes `#` lines first, one of them
// `#OFFSET [x,y,z]`, the UTM point its poses are relative to — returned as
// `offset`, else null.
export async function readPoses(dir) {
  const file = 'poses.csv';
  let offset = null;
  const poses = [];
  (await readFile(join(dir, file), 'utf8')).split(/\r?\n/).forEach((l, i) => {
    if (l.trim() === '') return;
    if (l.startsWith('#')) {
      if (l.startsWith('#OFFSET')) {
        const m = /^#OFFSET\s+\[([^\]]*)\]\s*$/.exec(l.trim());
        const v = m ? m[1].split(',') : [];
        if (v.length !== 3) refuse(file, `line ${i + 1}: #OFFSET must be [x,y,z], got '${l.trim()}'`);
        offset = v.map((x) => num(x.trim(), file, `line ${i + 1} #OFFSET`));
      }
      return;
    }
    const f = l.split(',');
    if (f.length < 8) refuse(file, `line ${i + 1} has ${f.length} columns; 8 are needed`);
    poses.push(f.slice(0, 8).map((v) => num(v, file, `line ${i + 1}`)));
  });
  return { poses: poses.sort((a, b) => a[0] - b[0]), offset };
}

// map_config.json: `rtk_external_param` only, the antenna's lever arm in the
// IMU frame. Its epsg and offset_xyz are not read.
export async function readLeverArm(dir) {
  const file = 'map_config.json';
  const arm = (await readJson(dir, file))?.rtk_external_param;
  if (!Array.isArray(arm) || arm.length !== 3) refuse(file, 'has no 3-number rtk_external_param');
  return arm.map((v) => num(v, file, 'rtk_external_param'));
}

// The lidar: octree.bin is a flat array of Potree DEFAULT records (every node
// is whole records; the hierarchy is not read); `position` is int32 × 3,
// times `scale` plus `offset`, less `shift`. Returns lidar(pick), which reads
// only the sampled records, by offset: an L3 octree.bin is 9 GB.
export async function potreeLidar(dir, metadataFile, shift = [0, 0, 0]) {
  const file = metadataFile;
  const meta = await readJson(dir, file);
  if (meta.encoding !== 'DEFAULT') refuse(file, `encoding is '${meta.encoding}'; only DEFAULT is supported`);
  let stride = 0, posOffset = -1;
  for (const a of meta.attributes ?? []) {
    const size = POTREE_TYPES[a.type];
    if (!size) refuse(file, `attribute ${a.name} has unsupported type ${a.type}`);
    if (a.name === 'position') {
      if (a.type !== 'int32' || a.numElements !== 3) refuse(file, 'position must be int32 × 3');
      posOffset = stride;
    }
    stride += size * a.numElements;
  }
  if (posOffset < 0) refuse(file, 'has no position attribute');
  const scale = meta.scale, offset = meta.offset;
  if (![scale, offset].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) refuse(file, 'needs 3-number scale and offset');
  // Offset less shift first, in float64: both are ~10^6 m on the L3.
  const base = offset.map((v, k) => v - shift[k]);
  return (pick) => {
    const fd = openSync(join(dir, 'octree.bin'), 'r');
    try {
      const { size } = fstatSync(fd);
      if (size % stride !== 0) refuse('octree.bin', `is ${size} bytes, not a whole number of ${stride}-byte records`);
      const n = size / stride;
      if (n === 0) refuse('octree.bin', 'is empty');
      const idx = pick(n);
      // Read in file order, stored in draw order: ICP sums over the points
      // in that order, and the draws must give what they always gave.
      const order = Array.from(idx.keys()).sort((a, b) => idx[a] - idx[b]);
      const pts = new Float64Array(3 * idx.length), rec = Buffer.alloc(12);
      for (const i of order) {
        if (readSync(fd, rec, 0, 12, idx[i] * stride + posOffset) !== 12) refuse('octree.bin', 'ended early');
        for (let k = 0; k < 3; k++) pts[3 * i + k] = rec.readInt32LE(4 * k) * scale[k] + base[k];
      }
      return pts;
    } finally {
      closeSync(fd);
    }
  };
}
