// The Gaussians under a scan's fixes, for control-points.mjs's antenna-height
// tests: rewrites <dir>/point_cloud.ply with a body of x, y, z, opacity,
// keeping its header's comments, from the RTK fixes in <dir>/gnss.csv.
//
//   node test/control-points-scene.mjs -- <dir> ['<options as JSON>']
//
// Options (all optional):
//   depth m          the ground's depth below each fix (default 1.6)
//   ground k         a ground under only the first k fixes in time (default all)
//   floaters         sparse Gaussians 2.0–2.9 m below every fix
//   roof             a denser layer 0.8 m below every fifth fix
//   transparent      a still denser layer 1.2 m below every fix, opacity logit −2
//   recenter         the offset comments become the first fix's UTM (E, N, h),
//                    so float32 x, y stay precise
//   noOpacity        leave the opacity property out
//   doubleZ          write z as a double
//
// Fixes are expected 3 m or more apart, so one fix's layers never reach
// another's 1 m disc. Seeded: the same options give the same bytes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { utm } from '../scripts/utm.mjs';

const [dir, json] = process.argv.slice(2).filter((a) => a !== '--');
const o = { depth: 1.6, ...JSON.parse(json || '{}') };

const plyPath = join(dir, 'point_cloud.ply');
const head = readFileSync(plyPath).toString('latin1');
const comments = new Map(head.slice(0, head.indexOf('end_header')).split('\n')
  .filter((l) => l.startsWith('comment ')).map((l) => { const [, k, v] = l.trim().split(/\s+/); return [k, v]; }));
const epsg = Number(comments.get('epsg'));
const zone = epsg % 100, north = epsg < 32700;

const fixes = readFileSync(join(dir, 'gnss.csv'), 'utf8').split('\n').slice(1)
  .map((l) => l.split(',')).filter((f) => f[1] === '4')
  .map((f) => ({ t: Number(f[0]), lat: Number(f[2]), lon: Number(f[3]), h: Number(f[4]) }))
  .sort((a, b) => a.t - b.t)
  .map((f) => { const [E, N] = utm(f.lat, f.lon, zone, north); return { E, N, h: f.h }; });

if (o.recenter) {
  comments.set('offsetx', String(fixes[0].E));
  comments.set('offsety', String(fixes[0].N));
  comments.set('offsetz', String(fixes[0].h));
}
const off = ['offsetx', 'offsety', 'offsetz'].map((k) => Number(comments.get(k)));

// mulberry32, seed 0
let seed = 0;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const out = []; // [x, y, z, opacity]
// A disc of Gaussians on a square grid, radius 1.2 m: wider than the 1 m the
// script looks within.
const disc = (x, y, z, step, opacity) => {
  for (let dx = -1.2; dx <= 1.2 + 1e-9; dx += step) {
    for (let dy = -1.2; dy <= 1.2 + 1e-9; dy += step) {
      if (dx * dx + dy * dy <= 1.44) out.push([x + dx, y + dy, z, opacity]);
    }
  }
};
fixes.forEach((f, i) => {
  const x = f.E - off[0], y = f.N - off[1], z = f.h - off[2];
  if (o.ground === undefined || i < o.ground) disc(x, y, z - o.depth, 0.1, 3);
  if (o.roof && i % 5 === 0) disc(x, y, z - 0.8, 0.07, 3);
  if (o.transparent) disc(x, y, z - 1.2, 0.05, -2);
  if (o.floaters) {
    for (let k = 0; k < 100; k++) {
      const r = 1.2 * Math.sqrt(random()), a = 2 * Math.PI * random();
      out.push([x + r * Math.cos(a), y + r * Math.sin(a), z - 2 - 0.9 * random(), 3]);
    }
  }
});

const props = [['float', 'x'], ['float', 'y'], [o.doubleZ ? 'double' : 'float', 'z']];
if (!o.noOpacity) props.push(['float', 'opacity']);
const stride = props.reduce((a, [t]) => a + (t === 'double' ? 8 : 4), 0);
const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${out.length}`,
  ...[...comments].map(([k, v]) => `comment ${k} ${v}`),
  ...props.map(([t, n]) => `property ${t} ${n}`), 'end_header', ''].join('\n');
const body = Buffer.alloc(out.length * stride);
out.forEach((v, i) => {
  let p = i * stride;
  props.forEach(([t, n]) => {
    const value = v[['x', 'y', 'z', 'opacity'].indexOf(n)];
    if (t === 'double') { body.writeDoubleLE(value, p); p += 8; } else { body.writeFloatLE(value, p); p += 4; }
  });
});
writeFileSync(plyPath, Buffer.concat([Buffer.from(header, 'latin1'), body]));
