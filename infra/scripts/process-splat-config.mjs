// A scan's process_splat_config.json, read for process-splat.sh: the file's
// shape and types are checked here, whole; each value's own rule (positive,
// non-negative) is the script's, shared with its flag, and applied to the
// decimal this returns. Every refusal throws, naming the file; the caller
// prints it and exits. The rules are in specs/process-splat.md, *Per-scan
// config*.
import { readFileSync } from 'node:fs';

export const VERSION = 1;
const SCALARS = ['cell', 'min_density', 'max_scale', 'scale_ratio'];
const FLOATERS = ['size', 'opacity', 'min'];
// The steps a config may skip, in the order they run.
export const STEPS = ['density', 'size', 'floaters'];
const KNOWN = ['version', 'note', 'floaters', 'skip', ...SCALARS];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// A plain decimal, never 1e-7, which splat-transform and the script's rules
// would not read as one. Rounded to 20 places, so a positive value below that
// writes as 0 — and the script refuses it as 0, since it checks this string.
const plainDecimal = (v) => (v === 0 ? '0' : v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }));

// The settings the file has, as [key, value, raw]: value the decimal the
// script uses (floaters as -F's size,opacity,min), raw the JSON it was written
// as, for the script's refusal message. A `skip` comes last, as
// ['skip', 'density,size', raw], its names in STEPS order (empty when the
// array is); it is checked whole here, since no flag shares its rule.
export function readConfig(path) {
  const refuse = (why) => { throw new Error(`${path}: ${why}`); };
  let text, config;
  try { text = readFileSync(path, 'utf8'); } catch (e) { refuse(`cannot be read (${e.code ?? e.message})`); }
  try { config = JSON.parse(text); } catch (e) { refuse(`not valid JSON (${e.message})`); }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) refuse('must be a JSON object');
  if (!('version' in config)) refuse(`has no "version"; this script reads version ${VERSION}`);
  if (config.version !== VERSION) refuse(`has version ${JSON.stringify(config.version)}; this script reads version ${VERSION}`);
  for (const k of Object.keys(config)) if (!KNOWN.includes(k)) refuse(`unknown key "${k}" (known: ${KNOWN.join(', ')})`);
  if ('note' in config && typeof config.note !== 'string') refuse('"note" must be a string');
  const settings = [];
  for (const k of SCALARS) {
    if (!(k in config)) continue;
    if (!isNum(config[k])) refuse(`"${k}" must be a number, got ${JSON.stringify(config[k])}`);
    settings.push([k, plainDecimal(config[k]), JSON.stringify(config[k])]);
  }
  if ('floaters' in config) {
    const f = config.floaters;
    if (f === null || typeof f !== 'object' || Array.isArray(f)) refuse(`"floaters" must be an object {size, opacity, min}, got ${JSON.stringify(f)}`);
    const keys = Object.keys(f);
    if (keys.length !== FLOATERS.length || !FLOATERS.every((k) => keys.includes(k))) refuse(`"floaters" must have exactly the keys ${FLOATERS.join(', ')}, got ${keys.join(', ') || 'none'}`);
    for (const k of FLOATERS) if (!isNum(f[k])) refuse(`"floaters.${k}" must be a number, got ${JSON.stringify(f[k])}`);
    settings.push(['floaters', FLOATERS.map((k) => plainDecimal(f[k])).join(','), JSON.stringify(f)]);
  }
  if ('skip' in config) {
    const s = config.skip;
    const raw = JSON.stringify(s);
    if (!Array.isArray(s)) refuse(`"skip" must be an array of step names (${STEPS.join(', ')}), got ${raw}`);
    // A misspelt name would otherwise run the step it meant to skip.
    for (const n of s) if (!STEPS.includes(n)) refuse(`"skip" names an unknown step ${JSON.stringify(n)} (known: ${STEPS.join(', ')})`);
    if (new Set(s).size !== s.length) refuse(`"skip" names a step more than once: ${raw}`);
    // The size cut's limit follows the typical size, which the density step
    // measures: without it there is no limit to cut by.
    if (s.includes('density') && !s.includes('size')) refuse(`"skip" names "density" without "size": the size cut's limit is measured by the density step`);
    settings.push(['skip', STEPS.filter((n) => s.includes(n)).join(','), raw]);
  }
  return settings;
}
