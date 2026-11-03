// XGRIDS Lixel L2 Pro (`comment source L2Pro`). Its poses are in a SLAM frame
// of their own, which the RTK fit finds; its lidar, in metadata.json (Potree
// 2.0), is already in the poses' frame. specs/scanners.md.
import { potreeLidar, readGnss, readLeverArm, readPoses } from './xgrids.mjs';

export const name = 'l2pro';
export const sources = ['L2Pro'];
export const files = ['gnss.csv', 'poses.csv', 'octree.bin', 'metadata.json', 'map_config.json'];

export async function read(dir) {
  // One after another, so a scan with two bad files always names the same one.
  const gnss = await readGnss(dir);
  const { poses } = await readPoses(dir);
  const leverArm = await readLeverArm(dir);
  const lidar = await potreeLidar(dir, 'metadata.json');
  return { gnss, poses, leverArm, lidar };
}
