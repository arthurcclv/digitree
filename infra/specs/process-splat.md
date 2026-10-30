# Spec — `process-splat.sh`: align, then strip outlying, oversized and floating Gaussians

Status: **revision 10, approved 2026-10-29**: the output is a lossless
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
are too large, and the floaters, and writes the result as a PLY. Every capture gets the same treatment from one command, with
no per-capture setting to pick. Its output is not served: it is one input of
the mosaic (`specs/splat-mosaic.md`), which merges every cleaned scan into
the tiles the app draws.

```bash
./scripts/process-splat.sh KZ0918-075047             # defaults: 2 m voxels, 1%, 0.25 m
./scripts/process-splat.sh KZ0918-075047 --min-density 0.02 --max-scale 0.5
```

## Where files live

```
data/3dgs/original/<scan>/   one folder per scan, as delivered — read-only
  point_cloud.<ext>          the splat, in one supported format (below)
  gnss.csv, poses.csv,       read by the align step, when every one of them is
  octree.bin, metadata.json, there and the splat is point_cloud.ply
  map_config.json
  …                          anything else is ignored
data/3dgs/clean/<scan>.ply   the scans as cleaned — written only by process-splat.sh
data/3dgs/clean/<scan>.align.json
                             what the align step did to that .ply
```

`splat-mosaic.mjs` reads every `clean/<scan>.ply`. The rule "never modify
`data/`" keeps one exception for this script: `process-splat.sh` owns
`data/3dgs/clean/`.
`original/` stays read-only, so a capture can always be cleaned again from what
was delivered.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `<scan>` | — | a bare scan folder name in `original/`; the script reads its one `point_cloud.<ext>` |
| `--cell <m>` | `2` | edge of the cubic voxels the density is counted in |
| `--min-density <f>` | `0.01` | keep a Gaussian when its voxel holds at least `f` × the capture's typical density (below) |
| `--max-scale <m>` | `0.25` | keep Gaussians whose **every** axis is at most this long |
| `--floaters <size,op,min>` | `0.05,0.1,0.004` (splat-transform's own) | passed to `-F` |
| `SPLATS_ORIGINAL_DIR` | `data/3dgs/original` | env: where the scan folders are |
| `SPLATS_CLEAN_DIR` | `data/3dgs/clean` | env: where the output is written |

The two directories are variables for the same reason the loader's inputs are
psql variables: the test points the real script at a scratch directory.

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
   `specs/splat-align.md`). When the splat is `point_cloud.ply` and the scan
   has all five files above, fit the trajectory to RTK, match the lidar to
   the Gaussians, and move every Gaussian by the rigid correction found, in
   the PLY's own frame, to a temporary `.ply`; the density step reads that.
   Otherwise it is **skipped**, with the reason printed
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
2. **Size cut.** Keep Gaussians with `scale_0`, `scale_1` and `scale_2` each
   `<= --max-scale` (three `-V … lte`).
3. **Floaters.** `-F` with `--floaters`.
4. **Write** a binary `.ply`, lossless, splat-transform's own PLY output.
5. **Report** the align step's status (and how far it moved the capture),
   the typical density, and Gaussians before, after each cut, after all, and
   the % removed.

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

The align step's own cases are in `test/splat-align.sh`
(`specs/splat-align.md`).

## Docs

`infra/README.md` (*Cleaning*) and `infra/CLAUDE.md` (the layout block and
the `data/` exceptions) name `clean/<scan>.ply`; the mosaic's entry in
`app/ai/DECISIONS.md` records why the output is no longer SPZ.

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
