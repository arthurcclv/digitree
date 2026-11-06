# Spec — `process-splat.sh`: align, then strip outlying, oversized and floating Gaussians

Status: **revision 16, approved 2026-11-06**: a scan's
`process_splat_config.json` may name steps to **skip** — any of the
density cut, the size cut and the floater pass — and those steps do not
run on that scan. The aerial exception of revision 14 is removed: a
`Drone` capture is cut like any other unless its config skips the cuts.
See *Skipped steps* and *Changes from revision 15*.
Revision 15, approved 2026-11-06: a scan
folder may hold a `process_splat_config.json`, whose values replace the
defaults of the cut settings for that scan; a flag on the command line
still wins over both. See *Per-scan config* and *Changes from revision 14*.
Revision 14, approved 2026-11-03: an
**aerial** capture — a `point_cloud.ply` whose `comment source` is `Drone` —
skips the density and size cuts; only the floater pass runs on it. See
*Changes from revision 13*. Revision 13, approved 2026-11-03: the size
cut's limit follows the capture's own typical Gaussian size, with
`--max-scale` as its floor, so a drone capture is no longer cut to the
ground scans' 0.25 m; see *Changes from revision 12*. Revision 12, approved
2026-11-03: the align step chooses the
scanner module by the PLY's `comment source` and decides its own skips (exit
5); the script no longer checks the align files itself
(`specs/scanners.md`, `specs/splat-align.md` revision 4). Revision 11,
approved 2026-11-02: the align step accepts the
Lixel L3's `metadata.oct` in place of `metadata.json`
(`specs/splat-align.md` revision 3); nothing else changes. Revision 10,
approved 2026-10-29: the output is a lossless
`clean/<scan>.ply` for the mosaic (`specs/splat-mosaic.md`), not a served
`source/<scan>.spz`; see *Changes from revision 9*. Revision 9 (approved
2026-10-29) moved to splat-transform 3.10.x from 3.4.x; see *Changes from
revision 8*. Revision 8 (approved 2026-10-24) runs
an align step before the cuts; see *Changes from revision 7* and its own spec,
`specs/splat-align.md`.
Revision 7 (approved 2026-10-24) renamed `clean-splat.sh` to
`process-splat.sh`. Revision 6 (approved
2026-10-23) moved the script to `infra/scripts/`. Revision 5 and revision 3
were both approved 2026-10-22. Revision 3 read a scan's `point_cloud.sog`;
revision 5 reads its `point_cloud.<ext>` in any single-file format
splat-transform reads. Revision 4
(SOG output) was approved and reverted the same day; see *Reverted: revision
4*.

## What it is

A script in `infra/scripts/` that prepares one Gaussian splat capture for
the mosaic: it corrects the capture's placement against the scanner's RTK
and lidar (`splat-align.mjs`, when the scan carries what that needs), drops
the Gaussians that lie outside the capture's own distribution, the ones that
are too large, and the floaters, and writes the result as a PLY. Every capture gets the same treatment from one command — except a
scan whose folder holds a `process_splat_config.json`, which is cut with
the values it records, or skips the steps it names (*Per-scan config* and
*Skipped steps*, below). No capture is treated differently for its
scanner source. The command
stays the same for every scan: the settings a scan needs live beside it,
not in whoever runs it. Its output is not served: it is one input of
the mosaic (`specs/splat-mosaic.md`), which merges every cleaned scan into
the tiles the app draws.

```bash
./scripts/process-splat.sh KZ0918-075047             # defaults: 2 m voxels, 1%, max(0.25 m, 4 × typical size)
./scripts/process-splat.sh KZ0918-075047 --min-density 0.02 --max-scale 0.5 --scale-ratio 6
```

## Where files live

```
data/3dgs/original/<scan>/   one folder per scan, as delivered — read-only
  point_cloud.<ext>          the splat, in one supported format (below)
  the scanner module's files read by the align step, when the splat is
                             point_cloud.ply: the files of the module for its
                             `comment source` (specs/scanners.md)
  process_splat_config.json  optional: this scan's cut settings (below) —
                             the one file an operator adds to a delivered
                             folder; the script only reads it
  …                          anything else is ignored
data/3dgs/clean/<scan>.ply   the scans as cleaned — written only by process-splat.sh
data/3dgs/clean/<scan>.align.json
                             what the align step did to that .ply
```

`splat-mosaic.mjs` reads every `clean/<scan>.ply`. The rule "never modify
`data/`" keeps one exception for this script: `process-splat.sh` owns
`data/3dgs/clean/`.
`original/` stays read-only, so a capture can always be cleaned again from what
was delivered. The one exception, for operators rather than tools, is a
scan's `process_splat_config.json`: it is added by hand, beside the
delivered files and changing none of them, so the settings a scan was cut
with travel with the scan. No tool writes it.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `<scan>` | — | a bare scan folder name in `original/`; the script reads its one `point_cloud.<ext>` |
| `--cell <m>` | `2` | edge of the cubic voxels the density is counted in |
| `--min-density <f>` | `0.01` | keep a Gaussian when its voxel holds at least `f` × the capture's typical density (below) |
| `--max-scale <m>` | `0.25` | the size cut's **floor**: its limit is never below this (below) |
| `--scale-ratio <k>` | `4` | the size cut's limit is at least `k` × the capture's **typical size** (below) |
| `--floaters <size,op,min>` | `0.05,0.1,0.004` (splat-transform's own) | passed to `-F`; three plain decimals, each ≥ 0, else refused |
| `SPLATS_ORIGINAL_DIR` | `data/3dgs/original` | env: where the scan folders are |
| `SPLATS_CLEAN_DIR` | `data/3dgs/clean` | env: where the output is written |

The two directories are variables for the same reason the loader's inputs are
psql variables: the test points the real script at a scratch directory.

Each of the five cut settings is taken from, in order: its flag on the
command line; else the scan's `process_splat_config.json`, when the file
has that key; else the default above. Each setting is resolved on its own,
so a config with `min_density` alone still takes the default `cell`.

### Per-scan config

`original/<scan>/process_splat_config.json`, optional. A JSON object:

```json
{
  "version": 1,
  "cell": 2,
  "min_density": 0.01,
  "max_scale": 0.25,
  "scale_ratio": 4,
  "floaters": { "size": 0.05, "opacity": 0.1, "min": 0.004 },
  "skip": ["size"],
  "note": "why this scan needs its own values"
}
```

| key | type | required | flag it stands for | rule |
| --- | --- | --- | --- | --- |
| `version` | integer | yes | — | `1`, the only version this revision reads |
| `cell` | number | no | `--cell` | > 0 |
| `min_density` | number | no | `--min-density` | > 0 |
| `max_scale` | number | no | `--max-scale` | > 0 |
| `scale_ratio` | number | no | `--scale-ratio` | > 0 |
| `floaters` | object | no | `--floaters size,op,min` | exactly the keys `size`, `opacity`, `min`, each a number ≥ 0; passed to `-F` as `size,opacity,min` |
| `skip` | array | no | — (no flag) | distinct step names, each `density`, `size` or `floaters`; `size` is required whenever `density` is named (*Skipped steps*) |
| `note` | string | no | — | read by nobody; says why the scan has a config |

- A value's rule is its flag's: the config is checked the way the flags
  are, so no value is accepted from the file that the command line would
  refuse. A value is checked as it is passed on — the plain decimal the
  script writes, to 20 decimal places — so a positive value too small to
  write (`1e-25`, which writes as `0`) is refused as `0` is.
- The file is **refused**, naming it and what is wrong, before any step
  runs — and so before anything in `clean/` is touched — when it is not
  valid JSON, is not an object, has no `version` or a `version` other than
  `1`, has a key not in the table (a misspelt `min_densty` would otherwise
  be silently ignored, and the scan cut with the default), or has a value
  of the wrong type (a number written as a string, `"0.02"`, included) or
  outside its rule. It is refused even when a flag overrides the bad key:
  the file is checked whole, so a bad file is found on the first run, not
  on the first run without the flag.
- The file is parsed with `node` (already required), not `jq`, so it adds
  no dependency.
- An empty object with only `version` is valid and changes nothing.
- The file is one input of the run, like the flags: re-running with the
  same file and flags is idempotent. Changing it changes the output only
  when the scan is processed again.

### Skipped steps

A config's `skip` names steps that do not run on the scan:

| name | step | settings it makes unused |
| --- | --- | --- |
| `density` | 1, the density cut | `cell`, `min_density` |
| `size` | 2, the size cut | `max_scale`, `scale_ratio` |
| `floaters` | 3, the floater pass | `floaters` |

- `skip` is **refused** when it is not an array, when an entry is not one
  of the three names (a misspelt `floater` would otherwise run the pass),
  when a name repeats, or when it names `density` without `size`: the size
  cut's limit follows the typical size, which the density step measures,
  so there is no limit to cut by without it. An empty array is valid and
  changes nothing.
- The align step (0) and the write (4) always run. With every step
  skipped, the output is the original — or the aligned file — written by
  splat-transform as the same lossless `.ply` it always writes, with no
  Gaussian removed.
- A skipped step's settings are still **checked**, from their flags and
  the config alike, so a bad value is refused whatever the skips, but have
  no effect.
- There is no `--skip` flag: a scan's skips are what it needs, and they
  live beside it. A flag for a skipped step is checked and unused.
- **The log.** The first line names a skipped step in place of its
  settings: `no density cut (skip)`, `no size cut (skip)`, `no floater pass
  (skip)`. The `settings:` line's groups leave out a skipped
  step's settings; those a config or flag set are named after the groups as
  `unused, skipped (min_density)`. The line ends with
  `; skip (density, size)` naming the config's skips, in table order. The
  count lines say `density and size cuts skipped: process_splat_config.json`
  in place of the density report when both are skipped, `size cut skipped:
  process_splat_config.json` in place of the limit's line and the size
  count when `size` alone is, and `<n> kept, floater pass skipped:
  process_splat_config.json; …` in place of `<n> kept after floaters; …`.
  With the density cut run and the size cut skipped, the typical size is
  still reported, without a limit.

Why. The cuts measure a capture against a ground scan's expectations, and
some captures are better kept whole than tuned: the operator's call, made
per scan. Setting a cut's threshold so it removes nothing (a `min_density`
of `1e-20`, a `max_scale` of `1e9`) would still run it — and the floater
pass cannot be set to keep everything at all: splat-transform refuses a
voxel size of 0, and an opacity cutoff of 0 still voxelises the whole
capture on the GPU, for a result nothing guarantees. A skip says what it
means and costs nothing.

Requires `splat-transform` 3.10.x, installed globally (`npm install -g
@playcanvas/splat-transform@3.10`), and `node` on `PATH`; fails with a clear
message if either is missing or the version is not 3.10.x. The output is always
`clean/<scan>.ply`, the name the mosaic reads it by. A `<scan>` that is a
path or is not a folder in `original/` is refused, naming what is missing.

**The input file.** The scan folder must hold exactly one `point_cloud.<ext>`
with `<ext>` one of:

| `<ext>` | format |
| --- | --- |
| `ply` | PLY, the usual training output (lossless) |
| `compressed.ply` | PlayCanvas compressed PLY |
| `sog` | SOG, bundled (`meta.json` + WebP in a zip) |
| `spz` | SPZ, any version splat-transform reads |
| `splat` | antimatter15 `.splat` |
| `ksplat` | `.ksplat` |

- **None** of them: refused, listing the names it looked for.
- **More than one** (say `point_cloud.ply` and `point_cloud.sog`): refused,
  naming each. They may be different exports of the same scan at different
  losses, and which one is cleaned is the operator's call, not a guess; remove
  or move the others.
- Not accepted, though splat-transform reads them: `.mjs` (a generator is code,
  and the scan folder is delivered data — it is never executed), and the
  multi-file or multi-LOD containers (`meta.json`, `lod-meta.json`, `.lcc`,
  `.lcc2`).
- A PLY's extra columns (the delivered scans' zero `nx`, `ny`, `nz`) pass
  through to the output; the mosaic drops them.
- Only a `point_cloud.ply` carries a georeference, and the mosaic places a
  scan by it alone, so any other format is cleaned here and then refused by
  the mosaic (`specs/splat-mosaic.md`, *Inputs*).

## What it does, in order

0. **Align** (`scripts/splat-align.mjs`, a node step; spec
   `specs/splat-align.md`). When the splat is `point_cloud.ply`, run the
   step: it reads the scan through its scanner's module, fits the trajectory
   to RTK, matches the lidar to the Gaussians, and moves every Gaussian by
   the rigid correction found, in the PLY's own frame, to a temporary `.ply`; the density step reads that.
   It is **skipped** when the splat is not `point_cloud.ply` (the script's
   own check), or when the step exits 5 — no module for the PLY's `comment
   source`, or a file the module reads missing — with the reason printed
   (`align skipped: no map_config.json`), and the density step reads the
   original. When the step's validation **fails** (ICP inliers ≤ 40%, or
   RTK p95 > 0.10 m), it prints `error: <scan>: align failed (<reason>);
   continuing unaligned` on stderr and goes on with the original: the scan
   still goes into the mosaic, and the script still exits 0. A file that is there but
   wrong (a PLY without `epsg`, a Potree encoding other than `DEFAULT`, …)
   fails the scan, naming the file. Either way the step's report is written
   to `clean/<scan>.align.json`, with `status` `pass`, `corrected`, `fail`
   or `skipped`.
1. **Density cut** (`scripts/splat-density-cut.mjs`, a node step). Read the capture,
   put every Gaussian in a cubic voxel of edge `--cell` by its centre, and count
   each voxel. The voxels sit on multiples of `--cell` from the capture's
   origin, so their boundaries do not move with the capture's extremes. The
   capture's **typical density** is the count of the voxel the median Gaussian
   sits in — half of all Gaussians are in voxels at least that
   full. Keep a Gaussian when its voxel holds at least `--min-density` × the
   typical density; write what is kept to a temporary `.ply` (lossless).
   The same step measures the capture's **typical size**: the median, over
   the Gaussians it keeps, of each one's largest axis (`exp` of the largest
   of `scale_0..2`), in metres.
2. **Size cut.** The **limit** is `max(--max-scale, --scale-ratio × typical
   size)`. Keep Gaussians with `scale_0`, `scale_1` and `scale_2` each
   `<= limit` (three `-V … lte`).
3. **Floaters.** `-F` with `--floaters`.
4. **Write** a binary `.ply`, lossless, splat-transform's own PLY output.
5. **Report** the align step's status (and how far it moved the capture),
   the typical density, the typical size and the size limit used, and
   Gaussians before, after each cut, after all, and the % removed. The log
   rounds the typical size to 3 significant figures and the limit to 4;
   the size cut uses the limit unrounded.

The log names where the settings came from, on a line after its first,
before the align step's: `settings: config process_splat_config.json
(min_density, floaters); flags (max_scale); defaults (cell, scale_ratio)`,
each group listed only when it has a setting, and `settings: defaults`
when no setting in use comes from a config or a flag — with no config,
with one that holds only `version` (and `note`, or `skip`), and with no
flag passed. When every step is skipped and nothing is set, no default is
in use either and the groups are empty: `settings: skip (density, size,
floaters)`. The first line still
gives every value used. A skipped step's settings are named as in
*Skipped steps*.

### No aerial exception

Revisions 14 and 15 treated a `point_cloud.ply` whose `comment source` was
`Drone` as **aerial** and skipped its density and size cuts. Revision 16
removes that rule: the script no longer reads the header's source, and a
drone capture runs every step unless its config skips some. The reason
for keeping a drone capture whole — seen from above, its sparse areas are
real surface and its large Gaussians are its sampling; with the cuts run,
revision 13's relative limit still removed 5.1% of
`air_force_headquarter_ariel` — still holds, and is now recorded beside
each drone scan as `"skip": ["density", "size"]`. A rule keyed on the
scanner source decided the skips for every capture of that source; a skip
in the scan's own folder decides them for that scan, and is the one
mechanism for every scan.

Step 2 is one splat-transform run on the temporary `.ply`, writing a second
temporary `.ply`, so the size cut's own count can be reported; steps 3–4 are
a second run on that.

Why this rule. The threshold is relative to the capture itself, so it needs no
centre, no extent and no orientation: a long street, an L-shaped one and a
plaza are cleaned alike, and a denser capture is not cut harder. Counting in
3D voxels, not ground columns, also removes sky floaters above a dense street,
which a 2D count keeps. Measured on the three captures as delivered (density
cut alone):

| capture | typical density (2 m voxel) | removed at 0.01 | kept extent z max | removed by rev. 1 (60 m sphere alone) |
| --- | --- | --- | --- | --- |
| KY0917A | 3,882 | 3.5% | 24.0 m | 3.2% |
| KY0917B | 4,046 | 2.6% | 25.9 m | 3.6% |
| KY0917C | 2,201 | 1.9% | 29.7 m | 17.7% |

The same rule on 2 m ground columns left Gaussians at z = 90–128 m in every
capture. Rules depending on the capture's axes (Tukey fences, percentile
boxes) were rejected: C's side arm reaches 84 m out in y while its middle
half is 10 m wide, so a y fence cuts it.

Why the size limit follows the capture. A fixed limit suits one capture
height only. A drone capture's Gaussians are an order of magnitude larger
than a ground scan's, because its ground sampling is: at a fixed 0.25 m the
drone scan lost 38.9% of its Gaussians to the size cut alone, the ground
scans 2–3%. Measured on the originals (a 1-in-11 sample, largest axis):

| capture | source | typical size | p95 | p99 | removed at 0.25 m | limit (rev. 13) | removed at it |
| --- | --- | --- | --- | --- | --- | --- | --- |
| KY0917A | L2Pro | 0.011 m | 0.126 m | 0.408 m | 2.1% | 0.25 m (floor) | 2.1% |
| KZ0918-075047 | K2 | 0.037 m | 0.170 m | 0.459 m | 2.7% | 0.25 m (floor) | 2.7% |
| air_force_headquarter_ariel | Drone | 0.198 m | 0.791 m | 1.481 m | 38.9% | 0.787 m | 4.9% |

The drone row's last two columns are measured by the cleaning run itself
(typical size 0.197 m after the density cut; 5.1% removed in all).

The ratio, like `--min-density`, is relative to the capture itself, so it
needs no per-scanner or per-capture setting: a drone flown higher, or a new
scanner, gets its own limit. The floor keeps every ground scan's cut exactly
as before (4 × their typical size is 0.04–0.15 m). A ratio alone, without
the floor, would cut the fine L2 Pro scans at 0.04 m, removing about a
quarter of them. A percentile limit (keep the smallest 99%) was rejected: it
always removes a share, however clean the capture is. The typical size is
taken after the density cut, so the floaters it removes do not shift it.

## The splat-transform facts the script must encode

These silently produce a wrong result if forgotten, so they live in the
script, each with a comment, and each has a test.

- **`-V` on `scale_*` compares in metres**, though the file stores log scale.
  `scale_0,lte,0` keeps nothing.
- **Every `node -e` / `node <script>` argument goes after `--`**: node reads a
  negative number such as `-26.86` as one of its own options.
- The density step reads and writes through splat-transform's library
  (`readFile`, `materializeToDataTable`, `dataTableToChunkSource` with the kept
  rows' indices, `writeSource`) with its in-memory file systems, because the
  library exports no Node file system. 3.10 has no `writeFile`: a table is
  written by turning it back into a chunk source. A whole capture is held in
  memory; as measured on 3.4.x, the density step peaks
  at 2.6 GB and the splat-transform run at 3.5 GB for KZ0918-075047 (19.3M
  Gaussians, a 222 MB `.sog`), which takes ~2.5 min and serves 269 MB. A
  937 MB `.ply` (KZ0918-090946, 13.8M) peaks at 2.2 GB in the density step.
  The intermediate `.ply` in `clean/` needs ~1 GB of disk per 13M Gaussians
  while the script runs, and the output is about that size too: lossless, 14
  floats a Gaussian plus the normals.

## Output contract

- The output is a binary little-endian `.ply` with every property the mosaic
  reads, as floats: `x y z`, `f_dc_0..2`, `opacity`, `scale_0..2`,
  `rot_0..3`, in splat-transform's order. It carries no header comments, so
  no georeference: the mosaic reads the frame from the original's header.
- Gaussians are moved only by the align step's one rigid correction, within
  the PLY's own frame (UTM less the header's offset), and otherwise only
  removed. Their coordinates are written as stored: splat-transform's `.ply`
  output keeps x and y as the original has them (checked on a round trip of a
  known scene: x 12.30–12.39 and y −45.60 to −45.51 in, the same out). So the
  original's offset is the cleaned file's frame.
- The script writes to temporary files in `clean/`, the output's with a
  leading `.` so the mosaic never reads it, and renames the `.align.json`
  and then the `.ply` into place only on success; a failed run
  leaves the previous outputs untouched and no temporary file behind (the
  intermediate `.ply` files included).
- A run that would remove **every** Gaussian fails, naming the scan.
- Re-running is idempotent: it always reads `original/`, so the cuts never
  compound.

## Tests

`test/process-splat.sh`, run at the end of `test/run.sh` and runnable on its own.
It builds its scans with splat-transform's `.mjs` generator input, written out
as `<scan>/point_cloud.<ext>` originals in a scratch directory, so no binary
fixture is checked in. Every clump is a dense grid of small Gaussians, so the
floater pass keeps it and each cut is seen alone. The scene, with 2 m voxels:

- a main block of 1,000 in one voxel — the typical density, so the threshold
  at `--min-density 0.01` is 10;
- a clump of 27 in a voxel of its own: kept (27 ≥ 10), and removed at
  `--min-density 0.03` (27 < 30);
- a clump of 8 beside the scene, and one 50 m above the main block: both
  removed (8 < 10) — the second is a sky floater a ground-column count keeps;
- a block of 216, 150 m from the main one: kept — distance alone removes
  nothing;
- 64 Gaussians with one axis at 0.5 m are removed; 64 at 0.12 m are kept
  (`--max-scale 0.25`). SOG stores scales in a 256-entry codebook that pools
  rare values — a single 0.3 m and a single 0.24 m Gaussian both decode as
  0.2683 — so each size has 64 Gaussians and sits well clear of the limit;
- a **drone** scene: `coarse` again, with `comment source Drone` in its
  header and a clump of 8 (below the density threshold) beside it. It is
  cut as `coarse` is — the clump of 8 removed — and its log names no aerial
  capture: the source decides nothing. The same file with `comment source
  L2Pro`, which has no module's files here so its align is skipped (its
  log says so), gives the same count;
- a **spread** scene (`point_cloud.ply`): a main block of 1,000, 600 with a
  0.1 m largest axis and 400 with 0.3 m, and 50 clumps of 8 at 2 m, each in
  a voxel of its own, which the density cut removes. Its typical size is
  0.1 m and the limit 0.4 m; a median over all 1,400 would be 0.3 m;
- every Gaussian of the scene is 0.02 m but the 128 above, so its typical
  size is 0.02 m, 4 × that is 0.08 m, and the limit is the floor, 0.25 m —
  the log names both;
- a **coarse** scene (`point_cloud.ply`, so no codebook): a main block of
  1,000 whose largest axis is 0.3 m, so its typical size is 0.3 m and the
  limit is 1.2 m; 64 Gaussians at 0.5 m are kept (the fixed 0.25 m of
  revision 12 removed them) and 64 at 2 m are removed. At `--scale-ratio 1`
  the limit is 0.3 m and both go;
- a non-positive `--scale-ratio`, zero or negative, is refused;
- the same scene mirrored through the origin, so its coordinates are negative,
  gives the same count;
- the output is a binary little-endian PLY carrying every property the mosaic
  reads, as floats;
- the original's checksum is unchanged, and a re-run gives the same count;
- a `--min-density` that keeps nothing fails, leaves the previous output
  untouched and no temporary file;
- the output is `clean/<scan>.ply`;
- the same scene as `point_cloud.ply`, `point_cloud.compressed.ply`,
  `point_cloud.sog` and `point_cloud.spz` gives the same counts — the four
  formats splat-transform can write; `.splat` and `.ksplat` are accepted but
  have no test, as splat-transform cannot produce them;
- a folder with both a `point_cloud.ply` and a `point_cloud.sog` is refused,
  naming both, and so is one with only a `point_cloud.mjs`;
- a missing scan, a folder with no `point_cloud.<ext>`, a path in `<scan>`,
  and a non-positive `--cell`, `--min-density` or `--max-scale` are refused;
- a `splat-transform` that reports a version other than 3.10.x (a shim
  printing `splat-transform v3.4.0`) is refused, naming the version found;
- the `.sog` scene is skipped by the align step as not a `point_cloud.ply`,
  and its `.align.json` says so;
- with scans from `test/splat-align-scene.mjs`: a misplaced one is written
  put back (its end wall no longer past 20.2 m) with `corrected` recorded; one
  whose validation fails prints the error, exits 0, records `fail`, and
  writes a `.ply` byte-identical to that of the same `point_cloud.ply`
  skipped for missing files, whose log names them.

Per-scan config (revision 15), on the main scene:

- `{"version": 1, "min_density": 0.03}` removes the clump of 27, as
  `--min-density 0.03` does, and the settings line names `min_density` as
  from the config and the other four as defaults;
- the same file with `--min-density 0.01` on the command line keeps the
  clump: the flag wins, and the settings line names it as a flag;
- the same file with `--max-scale 0.6` names config, flags and defaults on
  one line;
- `{"version": 1, "max_scale": 0.6}` keeps the 64 at 0.5 m;
- a `cell` of `0.0000001` reaches the first line as `0.0000001`, not
  `1e-7`;
- `{"version": 1, "floaters": {"size": 0.05, "opacity": 0.1, "min":
  0.004}}` gives the same count as no config;
- `{"version": 1}` gives the same count and output as no config, and the
  settings line says `defaults`;
- each of these is refused, naming the file and leaving the previous
  output untouched and no temporary file: not JSON; a JSON array; no
  `version`; `"version": 2`; an unknown key (`min_densty`); `"min_density":
  "0.02"`; `"cell": 0`; `"scale_ratio": -1`; `floaters` missing `min`, with
  an extra key, or as the string `"0.05,0.1,0.004"`; a `note` that is not
  a string; a bad `cell`
  overridden by `--cell 2`; a `cell` of `1e-25`, which writes as `0`; and
  a negative `floaters.opacity`;
- a `floaters` with a `0` part is accepted and reaches `-F` as `0`;
- `--floaters` is refused when it is not three non-negative plain decimals
  (`0.05,0.1`, `0.05,-0.1,0.004`, `a,b,c`);
- the config file's checksum is unchanged by a run.

Skipped steps (revision 16):

- on the main scene, `{"version": 1, "skip": ["density", "size",
  "floaters"]}` keeps every Gaussian — the clumps of 8 and the 64 at 0.5 m
  included — writes the same lossless `.ply` format, and the log names all
  three as skipped, on the first line, the count lines and the `settings:`
  line;
- `"skip": ["density", "size"]` keeps the clumps of 8 and the 64 at 0.5 m,
  and the floater pass still runs (its `-F` value on the first line);
- `"skip": ["size"]` removes the clumps of 8 and keeps the 64 at 0.5 m,
  names the size cut as skipped on the first line, between the two steps
  that run, reports the typical size, and reports no limit;
- `"skip": ["floaters"]` gives the same counts as no config on the main
  scene (whose clumps the floater pass keeps) and the log says the pass was
  skipped;
- `"skip": []` gives the same count as no config;
- `{"version": 1, "min_density": 0.5, "skip": ["density", "size"]}`, run
  with `--max-scale 0.6`, names both `min_density` and `max_scale` as
  `unused, skipped`, and keeps the clumps;
- on the drone scene, `"skip": ["density", "size"]` keeps the clump of 8
  and the 2 m Gaussians, as revision 15's aerial rule did;
- each of these is refused, naming the file and leaving the previous
  output untouched: `"skip": "size"`; `"skip": ["floater"]`; `"skip":
  ["size", "size"]`; `"skip": ["density"]` (without `size`); `"skip": [1]`.

The align step's own cases are in `test/splat-align.sh`
(`specs/splat-align.md`).

## Docs

`infra/README.md` (*Cleaning*) and `infra/CLAUDE.md` (the layout block and
the `data/` exceptions) name `clean/<scan>.ply`; *Cleaning* states the size
cut's limit as `max(--max-scale, --scale-ratio × typical size)`, and a
2026-11-03 entry in `app/ai/DECISIONS.md` records why it follows the
capture. The second 2026-11-03 entry, which made an aerial capture skip
both cuts, is marked superseded by revision 16's entry, and *Cleaning* no
longer describes an aerial capture. `infra/CLAUDE.md`'s layout block says
what `ply-header.mjs` serves. The mosaic's entry in
`app/ai/DECISIONS.md` records why the output is no longer SPZ.
`infra/README.md` (*Cleaning*) describes `process_splat_config.json` and
the order flag → config → default; `infra/CLAUDE.md` names it as the one
file an operator adds to `original/<scan>/` (the `data/` rule and the
layout block); and a 2026-11-06 entry in `app/ai/DECISIONS.md` records why
per-scan settings live in the scan folder. *Cleaning* also describes
`skip`, and a second 2026-11-06 entry records why a skip and not a
threshold that removes nothing, and why it replaces the aerial rule.

## Changes from revision 15

- A config may hold `skip`, naming any of `density`, `size` and `floaters`
  (*Skipped steps*); those steps do not run on the scan. `density` needs
  `size` with it. There is no flag for it.
- The log names skipped steps on its first line, its count lines and its
  `settings:` line.
- The aerial exception (revision 14) is **removed**: the script no longer
  reads the PLY's `comment source`, `aerial_sources` is gone, and the log
  never names an aerial capture. A `Drone` capture without a config is now
  cut by both cuts. `ply-header.mjs`'s `plySource`, which only that check
  used, is removed; `commentSource`, which `splat-align.mjs` reads, stays.
- After approval, configs are added: every `KY*` and `KZ*` scan skips
  `density`, `size` and `floaters`; every other scan (the five `*_ariel`
  drone captures) skips `density` and `size` and keeps the floater pass —
  so each drone capture is cleaned as before.
- Downstream: `specs/splat-mosaic.md`'s note on how far a splat reaches
  past its voxel, and `specs/voxel-quality.md`'s sub-cell note, say a scan
  whose config skips the size cut is unbounded — with these configs, every
  delivered scan — and no longer point at *Aerial captures*. Neither one's
  behaviour changes.
- Docs: `infra/README.md` (*Cleaning*), `infra/CLAUDE.md` (the layout
  block's `process-splat.sh` and `ply-header.mjs` lines), and a 2026-11-06
  entry in `app/ai/DECISIONS.md` superseding the 2026-11-03 aerial entry.

## Changes from revision 14

- A scan folder may hold `process_splat_config.json` (*Per-scan config*):
  `version` 1 and any of `cell`, `min_density`, `max_scale`, `scale_ratio`,
  `floaters`, plus a free `note`. Each setting comes from its flag, else the
  config, else the default.
- The file is checked whole and strictly, before any step runs; a bad file
  fails the scan and leaves the previous output.
- The log gains a `settings:` line naming where each setting came from;
  on an aerial capture, the density and size settings a config or flag set
  are named as unused.
- `--floaters` is checked, as the other flags are: three plain decimals,
  each ≥ 0. Revision 14 passed it to `-F` unchecked. The config's
  `floaters` follows the same rule, and every config value is checked as
  the decimal it is written as, so one that rounds to `0` is refused.
- "No per-capture setting to pick" is dropped from *What it is*: revision 13
  and 14 kept the rule for every capture alike, and they still do — the
  defaults, the relative limits and the aerial exception are unchanged — but
  a scan that needs other values now records them beside itself instead of
  in an operator's command line, where they were lost after the run.
- `original/` stays read-only for every tool; the config is the one file
  an operator adds there.
- No scan's output changes until a config is added for it; with no config,
  every run is as in revision 14.
- Docs: `infra/README.md` (*Cleaning*), `infra/CLAUDE.md`, and a 2026-11-06
  entry in `app/ai/DECISIONS.md`.

## Changes from revision 13

- An aerial capture (`comment source` `Drone`) skips the density and size
  cuts; the floater pass alone runs on it. Every other capture is cleaned
  as in revision 13, whose relative size limit stays.
- `process-splat.sh` reads the header's `comment source` itself, for a
  `point_cloud.ply`, through `scripts/ply-header.mjs`, whose
  `commentSource` `splat-align.mjs` now reads it through too: one reading
  of the source for both.
- After approval, `air_force_headquarter_ariel` is cleaned again with the
  defaults, and the mosaic rebuilt.
- Downstream: `specs/splat-mosaic.md`'s note on how far a splat reaches
  past its voxel names the drone capture as uncut (its p99 largest axis is
  1.48 m, its largest unbounded); `specs/voxel-quality.md`'s sub-cell note
  says the drone capture is not size-cut. Neither one's behaviour changes.
- Docs: `infra/README.md` (*Cleaning*) and a 2026-11-03 entry in
  `app/ai/DECISIONS.md`, which partly supersedes revision 13's entry
  ("rules out a limit per scanner source").

## Changes from revision 12

- The size cut's limit is `max(--max-scale, --scale-ratio × typical size)`
  instead of `--max-scale` alone. `--max-scale` keeps its name and its
  default, 0.25 m, as the floor; `--scale-ratio` (default 4) is new.
- `splat-density-cut.mjs` also measures the typical size, over the Gaussians
  it keeps, and prints it as `typical_scale` in its JSON line.
- The log's header line and report name the typical size and the limit.
- Every ground scan delivered so far is cut exactly as before (the floor
  applies). The drone scan's limit rises to about 0.79 m. After approval,
  `air_force_headquarter_ariel` is cleaned again and the mosaic rebuilt.
- Downstream: `specs/splat-mosaic.md` (how far a splat reaches past its
  voxel) and `specs/voxel-quality.md` (why the sub-cell is 0.25 m) no longer
  read "no axis is over 0.25 m"; neither one's behaviour changes.

## Changes from revision 9

- The output is `clean/<scan>.ply`, lossless, instead of
  `source/<scan>.spz` (SPZ v3), and `SPLATS_SOURCE_DIR` is
  `SPLATS_CLEAN_DIR`. The final run keeps `-F` and drops
  `--spz-version 3`. SPZ was needed only while the app fetched the file; it
  now draws the LoD trees of the mosaic's tiles, which `build-lod.sh` builds
  from `.ply`.
- The steps, their order, their defaults and their failure modes do not
  change.
- Tests: the SPZ checks become PLY ones (the format line, and every property
  the mosaic reads, as floats); every path names `clean/` and `.ply`.

## Changes from revision 8

- The required splat-transform is 3.10.x, not 3.4.x; the version check holds
  it there. 3.10's library dropped `writeFile`, so the density step writes
  through `writeSource`, gathering the kept rows with `dataTableToChunkSource`
  instead of `DataTable.clone({ rows })`. What it keeps and what it writes do
  not change: every existing case passes on 3.10.3 unchanged.
- New test: a version other than 3.10.x is refused.
- Docs: `infra/README.md` and `infra/CLAUDE.md` name 3.10.x; a decision entry
  in `app/ai/DECISIONS.md` records the move, as the 2026-10-21 entry asked to
  revisit when splat-transform's library changed.
- The memory and time figures were measured on 3.4.x and are not re-measured.

## Changes from revision 7

- New step 0, align (`splat-align.mjs`, `specs/splat-align.md`). The script
  now reads a scan's `gnss.csv`, `poses.csv`, `octree.bin`, `metadata.json`
  and `map_config.json` when all are there, and writes
  `source/<scan>.align.json` beside every `.spz`.
- Gaussians may now be moved, by one rigid correction in the capture's own
  frame; before, they were only removed.
- A failed validation is an error line, not a failed run.
- No new input.

## Changes from revision 6

- `clean-splat.sh` is renamed `process-splat.sh`, its test
  `test/clean-splat.sh` is renamed `test/process-splat.sh`, and this spec
  `specs/clean-splat.md` is renamed `specs/process-splat.md`: the script will
  do more than clean. Its temporary directory in `source/` is `.process-*`
  rather than `.clean-*`. What it does does not change.

## Changes from revision 5

- `clean-splat.sh` and `splat-density-cut.mjs` move from `infra/` to
  `infra/scripts/`, beside the other splat tools; run the script from `infra/`
  as `./scripts/clean-splat.sh <scan>`. Paths it reads and writes are still
  relative to `infra/`, and nothing else changes.

## Changes from revision 3

- The input is the scan's one `point_cloud.<ext>`, in any of six formats, not
  only `point_cloud.sog`. Two or more is refused, where revision 3 read the
  `.sog` and ignored a `.ply` beside it.

## Reverted: revision 4

Revision 4 wrote `source/<scan>.sog` (SOG, `meta.json` version 2) instead of
SPZ v3: 143 MB against 183 MB for KZ0918-090946, same count, same time, and a
second lossy quantisation of scans delivered as SOG. It was reverted to SPZ v3
on 2026-10-22, the day it was approved.

## Changes from revision 2

- The argument is a scan folder in `original/`, not a file; the script reads
  `<scan>/point_cloud.sog` and writes `source/<scan>.spz`. The density step
  already read any format splat-transform reads, `.sog` included.
- The KZ0918 scans are 3× the KY0917 ones, so the memory and time figures
  above are re-measured.

## Changes from revision 1

- The median + `--radius` sphere (`-S`) is replaced by the density cut.
  `--radius` is removed; `--cell` and `--min-density` are added.
- No step reads `--stats` any more, so the x/y negation it reports no longer
  matters, and its test (the scene at (−30, −40)) is replaced by the mirrored
  scene above.
- New file `infra/splat-density-cut.mjs`, run by `clean-splat.sh`; the version
  check for splat-transform 3.4.x is new, because the node step uses its
  library API.
- After approval, A, B and C are cleaned again with the defaults.

## Out of scope

- Running the clean from `load.sh`. It stays a separate, explicit step: it
  takes up to ~2.5 min and 3.5 GB per scan and needs a GPU-capable
  `splat-transform`.
- Pinning splat-transform in an `infra/package.json`. The script checks the
  global version instead. (3.5–3.10 did change the library; it was ported,
  and the global check kept.)
- Connectivity (`-C`), box (`-B`) or opacity cuts, SH or decimation.
- Converting the capture's frame. (The SOG first delivered was y-up; the
  PLYs now delivered are z-up and georeferenced, and the mosaic moves them
  into one frame by that.) Its cuts are the same on every axis, and the align
  step moves Gaussians only within the PLY's frame, so the output keeps it —
  checked by reading its positions back.
