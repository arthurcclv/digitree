// XGRIDS Lixel L3 (`comment source LixelL3`). Its poses.csv starts with `#`
// lines, one of them `#OFFSET [x,y,z]`, and its poses are relative to that
// point — the PLY's own offset. Its lidar, in metadata.oct (Potree 2.1), is
// absolute UTM: less the #OFFSET, it is in the poses' frame.
// specs/scanners.md.
import { potreeLidar, readGnss, readLeverArm, readPoses, refuse } from './xgrids.mjs';

export const name = 'lixel-l3';
export const sources = ['LixelL3'];
export const files = ['gnss.csv', 'poses.csv', 'octree.bin', 'metadata.oct', 'map_config.json'];

export async function read(dir) {
  const gnss = await readGnss(dir);
  const { poses, offset } = await readPoses(dir);
  const leverArm = await readLeverArm(dir);
  // The #OFFSET, not metadata.oct's `shift` (equal on KZ1012-142213), is
  // subtracted: it names the frame the points must end in.
  if (!offset) refuse('poses.csv', 'has no #OFFSET [x,y,z] line; metadata.oct\'s lidar is absolute and is placed by it');
  const lidar = await potreeLidar(dir, 'metadata.oct', offset);
  return { gnss, poses, leverArm, lidar };
}
