// A scan's georeference, from its point_cloud.ply header. Shared by
// control-points.mjs (GNSS fixes into the file's frame) and georef.mjs (the
// header copied into georef.csv for the loader). Every refusal throws, naming
// the scan; the caller prints it and exits. `num` is shared too, and throws
// the same way. The rules are in
// specs/control-points.md, step 1, and specs/georef.md.
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

// process-splat.sh's single-file formats: a scan has exactly one of them.
const CAPTURES = ['ply', 'compressed.ply', 'sog', 'spz', 'splat', 'ksplat'].map((e) => `point_cloud.${e}`);
export const PLY = 'point_cloud.ply';

export function num(raw, what) {
  const v = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(v)) throw new Error(`${what}: '${raw}' is not a number`);
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
// `raw` keeps the header's text for each value, for a CSV that copies it as
// written.
export async function georeference(original, scan) {
  const found = CAPTURES.filter((f) => existsSync(join(original, scan, f)));
  if (found.length === 0) throw new Error(`${scan}: no ${PLY} in ${join(original, scan)}`);
  if (found.length > 1) throw new Error(`${scan}: more than one capture (${found.join(', ')}); keep one of them`);
  if (found[0] !== PLY) throw new Error(`${scan}: ${found[0]} carries no georeference; only a ${PLY} with one can be placed`);
  const c = await plyComments(join(original, scan, PLY));
  if (!c) throw new Error(`${scan}: ${PLY} has no PLY header`);
  const field = (key) => {
    if (!c.has(key)) throw new Error(`${scan}: ${PLY} has no 'comment ${key}' georeference`);
    return num(c.get(key), `${scan}: ${PLY} comment ${key}`);
  };
  // Digits only, as the loader reads EPSG: `32651.0` is a number in range,
  // but the row georef.mjs copies it into would be refused.
  const epsg = field('epsg');
  if (!/^\d+$/.test(c.get('epsg'))) throw new Error(`${scan}: ${PLY} has epsg ${c.get('epsg')}; it must be a whole number`);
  const north = epsg >= 32601 && epsg <= 32660;
  if (!north && !(epsg >= 32701 && epsg <= 32760)) throw new Error(`${scan}: ${PLY} is in EPSG:${c.get('epsg')}; only WGS 84 / UTM (32601–32660, 32701–32760) is supported`);
  for (const axis of 'xyz') {
    if (c.has(`shift${axis}`) && field(`shift${axis}`) !== 0) throw new Error(`${scan}: ${PLY} has shift${axis} ${c.get(`shift${axis}`)}; only 0 is supported`);
    if (c.has(`scale${axis}`) && field(`scale${axis}`) !== 1) throw new Error(`${scan}: ${PLY} has scale${axis} ${c.get(`scale${axis}`)}; only 1 is supported`);
  }
  return {
    epsg, zone: epsg % 100, north, offset: [field('offsetx'), field('offsety'), field('offsetz')],
    raw: { epsg: c.get('epsg'), offsetx: c.get('offsetx'), offsety: c.get('offsety'), offsetz: c.get('offsetz') },
  };
}
