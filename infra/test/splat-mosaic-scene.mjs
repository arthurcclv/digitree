// Small binary PLYs for test/splat-mosaic.sh, written and read back, so no
// binary fixture is checked in.
//
//   node test/splat-mosaic-scene.mjs -- <out.ply> < scene.json   # write
//   node test/splat-mosaic-scene.mjs -- --read <in.ply>           # print JSON
//
// scene.json: { comments: { epsg, offsetx, … } (optional), props: [names]
// (optional; the delivered layout with zero normals by default), splats:
// [{ x, y, z, dc0, opacity, … }] }. A property a splat leaves out gets a
// default: an opaque, 5 cm, unrotated, grey Gaussian.
import { readFileSync, writeFileSync } from 'node:fs';
import { layout } from '../scripts/ply-header.mjs';

const LAYOUT = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const ALIAS = { dc0: 'f_dc_0', dc1: 'f_dc_1', dc2: 'f_dc_2', s0: 'scale_0', s1: 'scale_1', s2: 'scale_2', r0: 'rot_0', r1: 'rot_1', r2: 'rot_2', r3: 'rot_3' };
const DEFAULT = { f_dc_0: 0.5, f_dc_1: 0.5, f_dc_2: 0.5, opacity: 2, scale_0: Math.log(0.05), scale_1: Math.log(0.05), scale_2: Math.log(0.05), rot_0: 1 };

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

if (args[0] === '--read') {
  // The body is read through the mosaic's own reader of PLY layouts.
  const ply = await layout(args[1], args[1]);
  const buf = readFileSync(args[1]);
  const head = buf.subarray(0, ply.headerLen).toString('latin1').split('\n');
  const props = [...ply.props.keys()];
  const comments = Object.fromEntries(head.filter((l) => l.startsWith('comment ')).map((l) => {
    const [, k, ...v] = l.split(' ');
    return [k, v.join(' ')];
  }));
  const dv = new DataView(buf.buffer, buf.byteOffset + ply.headerLen);
  const splats = [];
  for (let i = 0; i < ply.count; i++) {
    splats.push(Object.fromEntries(props.map((p) => [p, dv.getFloat32(i * ply.stride + ply.props.get(p).offset, true)])));
  }
  console.log(JSON.stringify({ header: head.slice(0, -1), comments, props, splats }));
} else {
  const scene = JSON.parse(readFileSync(0, 'utf8'));
  const props = scene.props ?? LAYOUT;
  const comments = Object.entries(scene.comments ?? {}).map(([k, v]) => `comment ${k} ${v}`);
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${scene.splats.length}`, ...comments,
    ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  const body = new Float32Array(scene.splats.length * props.length);
  scene.splats.forEach((s, i) => {
    const v = {};
    for (const [k, x] of Object.entries(s)) v[ALIAS[k] ?? k] = x;
    props.forEach((p, k) => { body[i * props.length + k] = v[p] ?? DEFAULT[p] ?? 0; });
  });
  writeFileSync(args[0], Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(body.buffer)]));
}
