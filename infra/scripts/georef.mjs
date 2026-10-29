// Write a scan's row of georef.csv: its point_cloud.ply header's georeference
// (EPSG and offsetx/y/z, as written), which the loader places the capture by
// in its `header` mode. The loader cannot read the header itself: the served
// .spz has none, and original/ is not mounted in the database.
//
//   node scripts/georef.mjs [<scan>…]   # from infra/; default: every scan
//
// Reads only the header of original/<scan>/point_cloud.ply, never writes
// original/. Replaces only the given scans' rows of georef.csv and keeps every
// other row byte for byte. The rules are in specs/georef.md.
import { PLY, georeference } from './ply-header.mjs';
import { fail, otherRows, replaceFile, scansToRun } from './scan-csv.mjs';

const ORIGINAL = process.env.SPLATS_ORIGINAL_DIR ?? 'data/3dgs/original';
const OUT = process.env.SPLATS_GEOREF ?? 'data/3dgs/georef.csv';
const HEADER = 'SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ';

async function rowFor(scan) {
  const { epsg, offsetx, offsety, offsetz } = (await georeference(ORIGINAL, scan)).raw;
  console.log(`${scan}: EPSG:${epsg}, offset ${offsetx} ${offsety} ${offsetz}`);
  return [scan, `${scan}.spz`, epsg, offsetx, offsety, offsetz].join(',');
}

// A missing scan is not refused here: georeference() names it.
const scans = scansToRun(ORIGINAL, [PLY]);
const { kept } = await otherRows(OUT, [HEADER], scans);

const generated = [];
for (const scan of scans) {
  try {
    generated.push(await rowFor(scan));
  } catch (e) {
    fail(e.message);
  }
}

await replaceFile(OUT, [HEADER, ...kept, ...generated]);
console.log(`wrote ${generated.length} row(s) to ${OUT}; kept ${kept.length} other row(s)`);
