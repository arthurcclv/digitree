// A synthetic scan folder for splat-align.mjs's tests: a street canyon of
// Gaussians, the scanner's trajectory as poses.csv and gnss.csv, and its
// lidar as a Potree octree.bin, all consistent with one another.
//
//   node test/splat-align-scene.mjs -- <dir> ['<options as JSON>']
//
// Options (all optional):
//   shift [x,y,z], turnDeg   the Gaussians' misplacement: turned about z at the
//                            origin, then shifted; the correction must undo it
//   lidar 'random'           lidar unrelated to the Gaussians
//   gnssNoise σ              metres of noise on every RTK fix
//   falseFix                 one RTK fix 5 m off
//   lever [x,y,z]            the true lever arm (default [1, 0, 0.5])
//   mapLever [x,y,z]         the one map_config.json states (default: lever)
//   omit [files]             files not written
//   encoding                 metadata.json's encoding (default DEFAULT)
//   noEpsg, noRtkParam       leave those out
//
// Gaussian 0 has a known rotation (non-unit) and normal, Gaussian 1 a zero
// quaternion. Seeded throughout: the same options give the same bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { utmInverse } from '../scripts/utm.mjs';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [dir, json] = args;
const o = { shift: [0, 0, 0], turnDeg: 0, lever: [1, 0, 0.5], gnssNoise: 0, omit: [], encoding: 'DEFAULT', ...JSON.parse(json || '{}') };
o.mapLever ??= o.lever;
mkdirSync(dir, { recursive: true });
const write = (name, data) => { if (!o.omit.includes(name)) writeFileSync(join(dir, name), data); };

// KZ0918-075047's georeference.
const OFFSET = [352796.8287235790048726, 2770099.7470906949602067, 26.9006];
const EPSG = 32651, ZONE = 51;

let seed = 7;
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

const rotZ = (deg) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const mul = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const tr = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);

// The canyon, in the PLY's frame: ground 40 × 20 m, walls 8 m high on all four
// sides, six 1 × 1 × 3 m pillars, so ICP is held on every axis.
const rects = [
  [[-20, -10, 0], [40, 0, 0], [0, 20, 0]],
  [[-20, -10, 0], [40, 0, 0], [0, 0, 8]],
  [[-20, 10, 0], [40, 0, 0], [0, 0, 8]],
  [[-20, -10, 0], [0, 20, 0], [0, 0, 8]],
  [[20, -10, 0], [0, 20, 0], [0, 0, 8]],
];
for (const [px, py] of [[-12, -6], [-4, 6], [3, -7], [9, 2], [15, -3], [-16, 4]]) {
  rects.push(
    [[px, py, 0], [1, 0, 0], [0, 0, 3]], [[px, py + 1, 0], [1, 0, 0], [0, 0, 3]],
    [[px, py, 0], [0, 1, 0], [0, 0, 3]], [[px + 1, py, 0], [0, 1, 0], [0, 0, 3]],
    [[px, py, 3], [1, 0, 0], [0, 1, 0]],
  );
}
const area = ([, a, b]) => Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
function surface(perM2) {
  const pts = [];
  for (const r of rects) {
    for (let k = Math.round(area(r) * perM2); k > 0; k--) {
      const u = random(), v = random();
      pts.push([0, 1, 2].map((i) => r[0][i] + u * r[1][i] + v * r[2][i]));
    }
  }
  return pts;
}

// ---- point_cloud.ply: solid Gaussians on the surfaces, misplaced by D, plus
// a translucent haze that the ICP target must leave out.
const D = rotZ(o.turnDeg);
const solid = surface(60).map((p) => add(mul(D, p), o.shift));
const haze = Array.from({ length: Math.round(solid.length / 10) }, () => [-20 + 40 * random(), -10 + 20 * random(), 8 * random()]);
const PROPS = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const rows = [...solid.map((p) => [p, 3]), ...haze.map((p) => [p, -3])];
const body = Buffer.alloc(rows.length * PROPS.length * 4);
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
rows.forEach(([p, opacity], i) => {
  let rot = [1, 0, 0, 0], normal = [0, 0, 1];
  if (i === 0) { rot = [1.6, 0.4, -0.6, 0.2]; normal = [0.6, 0, 0.8]; }
  if (i === 1) rot = [0, 0, 0, 0];
  const s = Math.log(0.03);
  const values = [...p, ...normal, 0.1 * (i % 7), 0.2, 0.3, opacity, s, s + 0.1, s - 0.1, ...rot];
  values.forEach((v, k) => body.writeFloatLE(v, (i * PROPS.length + k) * 4));
  p.forEach((v, k) => { lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); });
});
const header = [
  'ply', 'format binary_little_endian 1.0', 'comment source L2Pro',
  `comment offsetx ${OFFSET[0].toFixed(16)}`, `comment offsety ${OFFSET[1].toFixed(16)}`, `comment offsetz ${OFFSET[2].toFixed(16)}`,
  ...['x', 'y', 'z'].flatMap((a) => [`comment shift${a} 0.0000000000000000`, `comment scale${a} 1.0000000000000000`]),
  ...(o.noEpsg ? [] : [`comment epsg ${EPSG}`]),
  ...['x', 'y', 'z'].flatMap((a, k) => [`comment min${a} ${lo[k].toFixed(7)}`, `comment max${a} ${hi[k].toFixed(7)}`]),
  `element vertex ${rows.length}`,
  ...PROPS.map((p) => `property float ${p}`),
  'end_header', '',
].join('\n');
write('point_cloud.ply', Buffer.concat([Buffer.from(header, 'latin1'), body]));

// ---- the trajectory: out along y = −4 heading +x, a U-turn of radius 4,
// back along y = +4 heading −x, at 1.5 m/s, a pose every 0.2 s. The poses'
// frame is the PLY's turned 30° and moved to the first pose, as SLAM's is.
const Rp = rotZ(30), tp = [-18, -4, 1.5];
const track = [];
for (let s = 0; ; s += 0.3) {
  if (s <= 36) track.push([[-18 + s, -4, 1.5], 0]);
  else if (s <= 36 + 4 * Math.PI) {
    const a = (s - 36) / 4;
    track.push([[18 + 4 * Math.sin(a), -4 * Math.cos(a), 1.5], (a * 180) / Math.PI]);
  } else if (s <= 72 + 4 * Math.PI) track.push([[18 - (s - 36 - 4 * Math.PI), 4, 1.5], 180]);
  else break;
}
const T0 = 1789690000;
const poses = [], gnss = ['#timestamp,status,latitude,longitude,altitude,undulation,pdop,hdop,vdop,variance,satellite_num,satellite_utc'];
track.forEach(([c, yawDeg], i) => {
  const t = T0 + 0.2 * i;
  const body2ply = rotZ(yawDeg);
  // The pose: position and orientation in the poses' frame.
  const cP = mul(tr(Rp), sub(c, tp));
  const half = ((yawDeg - 30) * Math.PI) / 360;
  poses.push([t, ...cP, 0, 0, Math.sin(half), Math.cos(half)].map((v) => v.toFixed(9)).join(','));
  // The fix: the antenna, lever arm turned with the scanner, plus any noise.
  const ant = add(c, mul(body2ply, o.lever)).map((v) => v + o.gnssNoise * gauss());
  if (o.falseFix && i === 50) ant[0] += 5;
  const [lat, lon] = utmInverse(ant[0] + OFFSET[0], ant[1] + OFFSET[1], ZONE, true);
  gnss.push(`${(t + 0.01).toFixed(6)},4,${lat.toFixed(10)},${lon.toFixed(10)},${(ant[2] + OFFSET[2]).toFixed(4)},17.9,1,1,1,0.01,30,0`);
  // Between fixes, one without a solution: never matched, never read.
  gnss.push(`${(t + 0.11).toFixed(6)},1,nan,nan,nan,17.9,1,1,1,0.01,30,0`);
});
write('poses.csv', poses.join('\n') + '\n');
write('gnss.csv', gnss.join('\n') + '\n');
write('map_config.json', JSON.stringify(o.noRtkParam ? { epsg: EPSG } : { epsg: EPSG, rtk_external_param: o.mapLever }, null, 2));

// ---- the lidar, in the poses' frame, as Potree DEFAULT records.
const truth = o.lidar === 'random'
  ? Array.from({ length: 20000 }, () => [-20 + 40 * random(), -10 + 20 * random(), 8 * random()])
  : surface(15);
const lidar = truth.map((p) => mul(tr(Rp), sub(p, tp)));
const SCALE = 1e-4;
const lmin = [0, 1, 2].map((k) => Math.min(...lidar.map((p) => p[k])));
const oct = Buffer.alloc(lidar.length * 16);
lidar.forEach((p, i) => {
  p.forEach((v, k) => oct.writeInt32LE(Math.round((v - lmin[k]) / SCALE), i * 16 + 4 * k));
  oct.writeUInt8(100, i * 16 + 12);
});
write('octree.bin', oct);
write('metadata.json', JSON.stringify({
  version: '2.0', encoding: o.encoding, scale: [SCALE, SCALE, SCALE], offset: lmin,
  attributes: [
    { name: 'position', type: 'int32', numElements: 3 },
    { name: 'intensity', type: 'uint8', numElements: 1 },
    { name: 'rgb', type: 'uint8', numElements: 3 },
  ],
}, null, 2));
