# Spec — `process-splat.sh`: align, then strip outlying, oversized and floating Gaussians

Status: **revision 8, approved 2026-10-24**: an align step runs before the
cuts; see *Changes from revision 7* and its own spec, `specs/splat-align.md`.
Revision 7 (approved 2026-10-24) renamed `clean-splat.sh` to
`process-splat.sh`. Revision 6 (approved
2026-10-23) moved the script to `infra/scripts/`. Revision 5 and revision 3
were both approved 2026-10-22. Revision 3 read a scan's `point_cloud.sog`;
revision 5 reads its `point_cloud.<ext>` in any single-file format
splat-transform reads. Revision 4
(SOG output) was approved and reverted the same day; see *Reverted: revision
4*.

## What it is

A script in `infra/scripts/` that prepares one Gaussian splat capture before
it is served: it corrects the capture's placement against the scanner's RTK
and lidar (`splat-align.mjs`, when the scan carries what that needs), drops
the Gaussians that lie outside the capture's own distribution, the ones that
are too large, and the floaters, and writes the result as a file Spark can
load. Every capture gets the same treatment from one command, with
no per-capture setting to pick.

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
data/3dgs/source/<scan>.spz  the scans as served — written only by process-splat.sh
data/3dgs/source/<scan>.align.json
                             what the align step did to that .spz
```

The `files` service serves `source/` at `/3dgs/`, and `04_splats.sql`
(`splats_dir`) checks control-point files against it. The rule "never modify
`data/`" keeps one exception: `process-splat.sh` owns `data/3dgs/source/`.
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
| `SPLATS_SOURCE_DIR` | `data/3dgs/source` | env: where the output is written |

The two directories are variables for the same reason the loader's inputs are
psql variables: the test points the real script at a scratch directory.

Requires `splat-transform` 3.4.x, installed globally (`npm install -g
@playcanvas/splat-transform`), and `node` on `PATH`; fails with a clear message
if either is missing or the version is not 3.4.x. The output is always
`source/<scan>.spz`, so a scan's `control_points.csv` rows name `<scan>.spz`
and its `SplatID` is naturally `<scan>`. A `<scan>` that is a path or is not a
folder in `original/` is refused, naming what is missing.

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
  losses, and which one is served is the operator's call, not a guess; remove
  or move the others.
- Not accepted, though splat-transform reads them: `.mjs` (a generator is code,
  and the scan folder is delivered data — it is never executed), and the
  multi-file or multi-LOD containers (`meta.json`, `lod-meta.json`, `.lcc`,
  `.lcc2`).
- A PLY's extra columns (KZ0918-090946's `nx`, `ny`, `nz`) pass through the
  density step and are dropped by the SPZ writer.

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
   is still served, and the script still exits 0. A file that is there but
   wrong (a PLY without `epsg`, a Potree encoding other than `DEFAULT`, …)
   fails the scan, naming the file. Either way the step's report is written
   to `source/<scan>.align.json`, with `status` `pass`, `corrected`, `fail`
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
4. **Write** SPZ **version 3** (`--spz-version 3`).
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
  (`readFile`, `materializeToDataTable`, `DataTable.clone({ rows })`,
  `writeFile`) with its in-memory file systems, because the library exports no
  Node file system. A whole capture is held in memory: the density step peaks
  at 2.6 GB and the splat-transform run at 3.5 GB for KZ0918-075047 (19.3M
  Gaussians, a 222 MB `.sog`), which takes ~2.5 min and serves 269 MB. A
  937 MB `.ply` (KZ0918-090946, 13.8M) peaks at 2.2 GB in the density step.
  The intermediate `.ply` in `source/` needs ~1 GB of disk per 13M Gaussians
  while the script runs.

## Output contract

- The output is a gzip-wrapped SPZ v3. Spark 2.3.1 identifies an SPZ only by
  the gzip magic (`getSplatFileType`), so the default v4 output — not gzipped —
  does not load at all.
- Gaussians are moved only by the align step's one rigid correction, within
  the PLY's own frame (UTM less the header's offset), and otherwise only
  removed. The frame is unchanged, so rows `control-points.mjs` wrote stay
  valid — they come from GNSS, which the corrected capture now agrees with.
  A row **measured by hand** on an aligned capture's file coordinates is off
  by up to its `correction_max_m` and must be re-measured or regenerated.
  (As of this revision every row is from GNSS.)
- The script writes to temporary files in `source/` and renames the
  `.align.json` and then the `.spz` into place only on success; a failed run
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
- the output starts with the gzip magic and decodes as SPZ v3;
- the original's checksum is unchanged, and a re-run gives the same count;
- a `--min-density` that keeps nothing fails, leaves the previous output
  untouched and no temporary file;
- the output is `source/<scan>.spz`;
- the same scene as `point_cloud.ply`, `point_cloud.compressed.ply`,
  `point_cloud.sog` and `point_cloud.spz` gives the same counts — the four
  formats splat-transform can write; `.splat` and `.ksplat` are accepted but
  have no test, as splat-transform cannot produce them;
- a folder with both a `point_cloud.ply` and a `point_cloud.sog` is refused,
  naming both, and so is one with only a `point_cloud.mjs`;
- a missing scan, a folder with no `point_cloud.<ext>`, a path in `<scan>`,
  and a non-positive `--cell`, `--min-density` or `--max-scale` are refused;
- the `.sog` scene is skipped by the align step as not a `point_cloud.ply`,
  and its `.align.json` says so;
- with scans from `test/splat-align-scene.mjs`: a misplaced one is served
  put back (its end wall no longer past 20.2 m) with `corrected` recorded; one
  whose validation fails prints the error, exits 0, records `fail`, and
  serves a `.spz` byte-identical to that of the same `point_cloud.ply`
  skipped for missing files, whose log names them.

The align step's own cases are in `test/splat-align.sh`
(`specs/splat-align.md`).

## Docs

`infra/README.md` (*Cleaning*), `infra/CLAUDE.md` (layout table gains
`splat-density-cut.mjs`; the traps rule loses the `--stats` frame, which no
step reads any more), the splat layer spec's served counts, and the 2026-10-21
decision entry in `app/ai/DECISIONS.md`, which has not landed yet and is
rewritten for the density rule rather than superseded.

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
  global version instead; a pinned copy is the next step if 3.5 breaks it.
- Connectivity (`-C`), box (`-B`) or opacity cuts, SH or decimation.
- Converting the capture's frame. (The SOG first delivered was y-up; the
  PLYs now delivered are z-up and georeferenced, and `control-points.mjs`
  places them from that.) Its cuts are the same on every axis, and the align
  step moves Gaussians only within the PLY's frame, so the SPZ keeps it —
  checked by decoding its positions.
