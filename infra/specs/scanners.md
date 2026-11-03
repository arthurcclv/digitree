# Spec — `scripts/scanners/`: one module per scanner, behind the align step

Status: **revision 2 — approved and implemented 2026-11-03**: `read(dir)`
reads one file at a time, in a fixed order; a file is missing when it is
not a regular file (with `specs/splat-align.md` revision 5). Revision 1 —
approved and implemented 2026-11-03 — changes `specs/splat-align.md` (to
revision 4) and `specs/process-splat.md` (to revision 12); see *Changes to
the other specs*.

## What it is

The align step (`splat-align.mjs`) does two kinds of work. One is the same
for every scan: the RTK fit, the ICP, applying and validating the correction.
The other depends on the scanner that made the scan: which files it
delivers, how its poses are written, what frame its lidar is in. Today both
kinds are in one file, and supporting the Lixel L3 (revision 3) added L3
branches to the generic code.

This spec moves the scanner-specific part into **one module per scanner** in
`infra/scripts/scanners/`, behind a fixed interface, so that supporting a
new scanner, or changing how one is read, means adding or editing one file and
never touching the fit.

```
scripts/scanners/
  index.mjs       the registry: every module, and the lookup by source
  xgrids.mjs      readers shared by the XGRIDS deliveries (not a scanner)
  l2pro.mjs       XGRIDS Lixel L2 Pro
  k2.mjs          XGRIDS Lixel K2
  lixel-l3.mjs    XGRIDS Lixel L3
```

## Which scanner a scan is from

Its `point_cloud.ply` says so, in the header's `comment source` line. As
delivered (2026-11-03):

| `comment source` | module | scans |
| --- | --- | --- |
| `L2Pro` | `l2pro.mjs` | 18: KY0917-03, A, B, C; KZ0917-06, E; KZ0918-090946, -093638, -095308, -101007-1, -101007-2, -132221, -135904, -140755, -143613, -153127; KZ0918161007, KZ0918162445 |
| `K2` | `k2.mjs` | 4: KZ0918-075047; KZ0918090721, KZ0918153456, KZ0918160415 |
| `LixelL3` | `lixel-l3.mjs` | 1: KZ1012-142213 |
| `Drone` | none | 1: air_force_headquarter_ariel (only a `point_cloud.ply`) |

The source is read from the header, not inferred from which files the folder
holds: two scanners can deliver the same file names in different meanings
(the L2 Pro's `metadata.json` is in the poses' frame, the L3's `metadata.oct`
is absolute; a future scanner may write a `metadata.json` that is absolute
too).

- A source **no module claims**, or a PLY **without** `comment source`: the
  align step is **skipped** (`align skipped: no scanner module for source
  'Drone'`, `align skipped: point_cloud.ply has no 'comment source'`), as for
  a missing file. The scan is still cleaned and still goes into the mosaic,
  unaligned.
- Two modules claiming the **same source** is a programming error: the
  registry throws on load, naming both.

## The interface

Every scanner module exports:

| export | type | meaning |
| --- | --- | --- |
| `name` | string | the module's name, recorded in `.align.json` as `scanner` |
| `sources` | string[] | the `comment source` values it reads |
| `files` | string[] | every file it reads besides `point_cloud.ply`. If one is missing — not a regular file — the align step is skipped, naming each missing file in this order |
| `read(dir)` | async function | reads those files and returns what the fit needs (below). It reads **one file at a time, in a fixed order**, so a scan with two bad files always names the same one |

`read(dir)` returns:

| field | type | meaning |
| --- | --- | --- |
| `gnss` | `{ t, fixed, lat, lon, h }[]`, sorted by `t` | every fix; `fixed` is true for an RTK-fixed solution, and only then are `lat`, `lon` (degrees, WGS 84) and `h` (ellipsoidal metres) read |
| `poses` | `[t, x, y, z, qx, qy, qz, qw][]`, sorted by `t` | the IMU trajectory, in a frame of the module's choice: the fit finds it from RTK |
| `leverArm` | `[x, y, z]` | the antenna, in the IMU frame, metres |
| `lidar(pick)` | function | `pick(n)` takes the number of lidar points available and returns the indices to read (the align step's seeded sample). `lidar` returns those points as a `Float64Array` of x, y, z **in the poses' frame**, in `pick`'s order |

The module owns every scanner fact: the GNSS status that means RTK-fixed, a
`#OFFSET` line, a Potree version, an absolute frame. The align step owns
everything else and knows no scanner by name.

**A file that is there but wrong** is reported by throwing
`ScanFileError(file, message)` (from `xgrids.mjs`; any module may use it):
the align step prints `error: <scan>: <file>: <message>` and exits 1, as
today. The messages of revision 3 do not change.

**Sampling.** `lidar(pick)` must call `pick` exactly once. The align step
draws the Gaussians' sample first, then the lidar's, from one seeded stream,
so the draws, and every L2 Pro and K2 scan's correction, stay what they
were.

### The modules

- **`xgrids.mjs`** (shared, claims no source): `readGnss(dir)` (`gnss.csv`,
  header `#timestamp,status,latitude,longitude,altitude,…`, fixed when
  `status == 4`), `readLeverArm(dir)` (`map_config.json`'s
  `rtk_external_param`, nothing else in it), `readPoses(dir)` (skips `#`
  lines, returns the `#OFFSET [x,y,z]` when there is one), `potreeLidar(dir,
  metadataFile, shift)` (the Potree DEFAULT records of `octree.bin`, read by
  offset, as revision 3), `ScanFileError`, `refuse(file, message)` (throws
  it), `num`.
- **`l2pro.mjs`**: `sources: ['L2Pro']`; files `gnss.csv`, `poses.csv`,
  `octree.bin`, `metadata.json`, `map_config.json`; the lidar as
  `metadata.json` gives it, no shift.
- **`k2.mjs`**: `sources: ['K2']`; today the same reading as the L2 Pro, so
  it re-exports `l2pro.mjs`'s `files` and `read` under its own `name` and
  `sources`. Its own file so that the K2 can diverge (its RTK fits are the
  poorest, `splat-align.md`) without touching the L2 Pro.
- **`lixel-l3.mjs`**: `sources: ['LixelL3']`; files `gnss.csv`,
  `poses.csv`, `octree.bin`, `metadata.oct`, `map_config.json`; requires
  `poses.csv`'s `#OFFSET` and subtracts it from the lidar.
- **`index.mjs`**: imports each module, checks no source is claimed twice,
  and exports `scannerFor(source)` → the module, or `null`.

### What each scanner delivers

| | L2 Pro / K2 (KY0917*, KZ0917*, KZ0918*) | Lixel L3 (KZ1012-142213) |
| --- | --- | --- |
| `poses.csv` | no header; a SLAM frame of its own | `#VERSION …`, `#OFFSET [x,y,z]`, `#timestamp,…`, then poses relative to that offset — which is the PLY's own |
| lidar metadata | `metadata.json`, Potree 2.0 | `metadata.oct`, Potree 2.1; one more attribute, `gps-time` (20-byte records) |
| a lidar point | `int32 × scale + offset`, already in the poses' frame | `int32 × scale + offset` is **absolute** UTM; less the poses' `#OFFSET`, it is in their frame |
| `octree.bin` | 0.1–1.5 GB | 9.0 GB (450.7M records) |

So with `metadata.oct` the lidar point is `int32 × scale + offset −
#OFFSET`, carried in float64. `metadata.oct`'s own `shift` equals the
`#OFFSET` on KZ1012-142213, but the poses' line is the one read: it is the
frame the points must end in. Every `#` line other than `#OFFSET` is ignored.

**Adding a scanner** is: write `scripts/scanners/<name>.mjs` with the four
exports, add it to `index.mjs`, give `test/splat-align-scene.mjs` a way to
write its delivery, and add its cases to `test/splat-align.sh`. Nothing in
`splat-align.mjs` changes.

## Changes to the other specs

### `specs/splat-align.md`, revision 4

- *Inputs* becomes: `point_cloud.ply`, plus whatever the scan's scanner
  module reads (`specs/scanners.md`). The "two scanner generations" table
  moves to this spec, per module.
- **The step decides the skip itself**, not `process-splat.sh`: it reads the
  PLY's `comment source`, looks the module up, checks the module's `files`,
  and on any of those failing writes `{ "scan", "scanner", "status":
  "skipped", "reason" }` to `<out.json>`, prints its one JSON line, and exits
  **5** (new). Exit 0, 4 and 1 keep their meaning.
- `.align.json` gains `"scanner"` (the module's `name`, or `null` when none
  was found), after `"scan"`. Every other field, and the correction, are
  byte-for-byte what revision 3 writes, so the L2 Pro and K2 scans' files
  differ only by that line.
- Revision 3's rule "both `metadata.json` and `metadata.oct` is refused" is
  dropped: the scanner is named by the header, so the L3 module reads
  `metadata.oct` and the L2 Pro module `metadata.json`, and a stray other file
  is ignored like any other. "`metadata.oct` with no `#OFFSET`" and "an
  `#OFFSET` that is not three numbers" stay, in `lixel-l3.mjs`.
- The docs' "K1/K2" was wrong throughout: the scanners are the **L2 Pro and
  the K2** (from `comment source`). Revision 4 corrects it in this spec, in
  `infra/CLAUDE.md`, `infra/README.md` and the 2026-11-02 entry of
  `app/ai/DECISIONS.md` (in place: it is a misnaming, not a decision
  reversed).

### `specs/process-splat.md`, revision 12

- Step 0's file check is removed from `process-splat.sh`: it still skips a
  splat that is not `point_cloud.ply` itself (the step reads only PLY), and
  otherwise runs `splat-align.mjs` and acts on its exit — 5 prints `align
  skipped: <reason>` and runs the cuts on the original, as a missing file
  did. The messages for a missing file are the same as today, e.g. `align
  skipped: no gnss.csv, map_config.json`.
- *Where files live* lists `point_cloud.ply` and "the files of the scan's
  scanner module (`specs/scanners.md`)".

## Tests

- `test/splat-align-scene.mjs`: the scene's PLY says `comment source L2Pro`
  today; a new option `source` sets it (`K2`, `LixelL3`, `Drone`, or `null`
  for none), and `l3` sets `LixelL3`. The rest is as revision 3.
- `test/splat-align.sh`:
  - every existing case passes unchanged in what it asserts; the K1/K2
    (L2 Pro) checksums are re-recorded once, the only change being the
    `scanner` line, and a check that the files minus that line equal
    revision 3's.
  - the same L2 Pro scene written with `source: "K2"` gives the same
    correction, `scanner: "k2"`.
  - `source: "Drone"`: exit 5, `skipped`, reason `no scanner module for
    source 'Drone'`; `source: null`: exit 5, `point_cloud.ply has no 'comment
    source'`.
  - an L2 Pro scene without `metadata.json`: exit 5, `no metadata.json`;
    an L3 scene that also holds a `metadata.json`: aligned, as without it.
  - the registry: a module list with a source claimed twice throws, naming
    both modules (a unit check on `index.mjs`'s check function).
- `test/process-splat.sh`: the skip cases move to exit 5 and keep their
  messages; new: a `Drone` scan is cleaned, skipped by align, exit 0.

## Out of scope

- Choosing a scanner module by anything but `comment source` (file sniffing,
  a per-scan override file in `original/`, which is read-only).
- A module for the drone capture: it has no trajectory, RTK or lidar to align
  to. It is skipped, as above.
- Moving the RTK tolerance or ICP thresholds into the modules. They stay one
  rule for every scanner; whether the L3 or K2 need others is a question for
  a later revision, with a decision entry.
- An environment variable to swap the registry (as `SPLATS_QUALITY_MODULE`
  swaps the quality seam). The tests use the real modules; add one when a
  test or an experiment needs it.
