// What control-points.mjs and georef.mjs share around their own rows: which
// scans to run, the rows of every other capture, and replacing the CSV in one
// rename. Each rewrites only the rows of the scans it runs and keeps every
// other row byte for byte (specs/control-points.md and specs/georef.md,
// *Output contract*).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

// The scans named on the command line, or, with none, every folder in
// `original` holding all of `files`. A path, or a scan named twice, is refused:
// twice would write its rows twice, which the loader refuses.
export function scansToRun(original, files) {
  const given = process.argv.slice(2).filter((a) => a !== '--');
  if (given.length === 0) {
    if (!existsSync(original)) fail(`${original} does not exist`);
    const all = readdirSync(original)
      .filter((d) => statSync(join(original, d)).isDirectory() && files.every((f) => existsSync(join(original, d, f))))
      .sort();
    if (all.length === 0) fail(`no scan folder in ${original} has ${files.length === 1 ? `a ${files[0]}` : `both ${files.join(' and ')}`}`);
    return all;
  }
  given.forEach((scan, i) => {
    if (scan.includes('/') || scan === '.' || scan === '..') fail(`'${scan}' must be a bare scan folder name, not a path`);
    if (given.indexOf(scan) !== i) fail(`'${scan}' is given twice`);
  });
  return given;
}

// The file's header line and every row that is not one of `scans`', in order.
// A file whose header is not one of `headers` is refused, untouched.
export async function otherRows(out, headers, scans) {
  if (!existsSync(out)) return { head: null, kept: [] };
  const [first, ...rest] = (await readFile(out, 'utf8')).split('\n');
  const head = first.replace(/\r$/, '');
  if (!headers.includes(head)) fail(`${out} does not start with the header ${headers[0]}; left untouched`);
  return { head, kept: rest.filter((l) => l.trim() !== '' && !scans.includes(l.slice(0, l.indexOf(',')))) };
}

// Called once every scan succeeded: the file is replaced through a rename, so
// a failure leaves it as it was.
export async function replaceFile(out, lines) {
  const tmp = join(dirname(out), `.${basename(out, '.csv')}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, lines.join('\n') + '\n');
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    fail(`could not write ${out}: ${e.message}`);
  }
}
