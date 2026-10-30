# Spec — `splat-align.mjs`: correct a capture's placement against RTK and lidar

Status: **revision 2 — approved 2026-10-29**, with `specs/splat-mosaic.md`:
the step is unchanged, but its scan is written to `clean/<scan>.ply` and its
report to `clean/<scan>.align.json`, and what reads its frame downstream is
the mosaic, not the control-point fit; see *Changes in revision 2*. Revision 1
was approved 2026-10-24 and implemented the same day; what the implementation
settled that the approved text left open is listed under *Settled in
implementation*.

## What it is

A node step in `infra/scripts/`, run by `process-splat.sh` before the density
cut, that checks where a scan's `point_cloud.ply` sits against the scanner's
own RTK trajectory and lidar, and moves its Gaussians by the rigid correction
it finds. It is a port of `align()` steps 1–2 in the XGRIDS handoff
(`xgrids_pipeline/align.py`), with one deliberate difference: **the output
stays in the PLY's own frame** (UTM grid less the header's `offsetx/y/z`),
not converted to ENU. See *Why the frame does not change*.

```
original/<scan>/point_cloud.ply ─▶ splat-align.mjs ─▶ (aligned .ply) ─▶ density ─▶ size ─▶ floaters ─▶ clean/<scan>.ply
                                                   └▶ clean/<scan>.align.json
```

It is never run by hand in normal use; `process-splat.sh` calls it as

```bash
node scripts/splat-align.mjs -- <scan dir> <out.ply> <out.json>
```

## Inputs

All read from `original/<scan>/`, which stays read-only.

| file | used for |
| --- | --- |
| `point_cloud.ply` | the Gaussians; header `epsg`, `offsetx/y/z` |
| `gnss.csv` | RTK fixes; only `status == 4` |
| `poses.csv` | the IMU trajectory (SLAM frame), `timestamp,x,y,z,qx,qy,qz,qw`, no header |
| `octree.bin` + `metadata.json` | the lidar preview cloud, Potree 2.0, in the poses' frame |
| `map_config.json` | `rtk_external_param` only: the antenna's lever arm in the IMU frame |

**When the step is skipped.** `process-splat.sh` skips alignment, prints the
reason (`align skipped: point_cloud.sog is not a point_cloud.ply`, `align
skipped: no gnss.csv, map_config.json`), and runs the cuts on the original as
before, when the capture is not `point_cloud.ply` or any of the five other
files is absent. Seven of the 22
scans now delivered have no `map_config.json` (KY0917A, KZ0918-135904,
-140755, -143613, -153127, KZ0918161007, KZ0918162445); they are served
unaligned, in the same frame as the aligned ones, just uncorrected.

A file that is **present but wrong** fails the scan instead, naming the file:
a PLY that is not `binary_little_endian 1.0`, or lacks `epsg`, `offsetx/y/z`,
`x y z`, `rot_0..3`, `scale_0..2` or `opacity`; an `epsg` outside WGS 84 /
UTM (as `ply-header.mjs` refuses it); a Potree `encoding` other than
`DEFAULT`; a `map_config.json` without a 3-number `rtk_external_param`; a
`gnss.csv` without the expected header.

## What it does

All arithmetic in float64; positions are carried relative to the header's
offset, so nothing is ever near 3 × 10⁶ m in float32.

1. **Poses → PLY frame, from RTK.** Match each pose to the nearest GNSS fix
   by timestamp, within 0.05 s (half the GNSS interval); keep pairs whose fix
   is status 4. Project each fix's latitude/longitude to UTM in the header's
   zone (the Krüger series in the shared `scripts/utm.mjs`), less the offset; the fix's `altitude` (ellipsoidal) less
   `offsetz` is its z. The antenna is the pose position plus the lever arm
   rotated by the pose quaternion. Fit a rigid transform (Kabsch, no scale)
   antenna → fix, drop pairs with a residual over median + 6 · MAD (false
   fixes), and fit again. Report the pairs used, fixes dropped, and residual
   p50 and p95.
2. **Lidar vs Gaussians.** Sample 3,000,000 Gaussians (or all, if fewer) and
   keep the solid ones — opacity sigmoid > 0.5 and largest scale < 0.3 m — as
   the target. Sample 300,000 lidar points, carry them into the PLY frame with
   step 1's transform, and run trimmed point-to-point ICP for 30 iterations:
   nearest neighbours within max(0.3 m, 3 × median) for the first 5, within
   0.2 m after. Nearest-neighbour distances are searched to at most 20 m
   (a farther point reads 20 m), and from round 5 on to at most 0.2 m, the
   limit then; the second changes no pair, and the first only when the
   median is over 6.7 m, which no capture that passes comes near. The PLY's correction is the inverse of the ICP transform.
   It is **reliable** when over 40% of lidar points end within 0.1 m of a
   Gaussian. Fewer than 3 RTK pairs, fewer than 3 solid Gaussians in the
   sample, or an ICP round with fewer than 3 pairs inside its limit are a
   validation `fail` too, never a crash.
3. **Apply.** If reliable, every Gaussian is moved by the correction: its
   centre `p' = R p + t`; its rotation `rot_0..3` (w first) becomes
   `q(R) · q`, keeping the stored quaternion's magnitude (a zero quaternion is
   read as the identity, so it becomes the unit `q(R)`, as in `align.py`); `nx/ny/nz`, when present, are rotated by `R`. Scales,
   opacity, colour and SH are copied byte for byte — a rigid move changes none
   of them. The header is copied as is, except `minx…maxz` comments, which are
   recomputed when present. `epsg` and `offsetx/y/z` are unchanged.
4. **Validate.**

   | `status` | when |
   | --- | --- |
   | `fail` | ICP not reliable, or RTK fit p95 > 0.10 m |
   | `pass` | otherwise, and the correction moves no corner of the capture's bounding box more than 0.10 m (applied anyway) |
   | `corrected` | otherwise: moved more than 0.10 m |

   On `fail` the step writes no `.ply` and exits 4. `process-splat.sh` prints
   an error naming the scan and which check failed (ICP inliers, or the RTK
   p95), **skips alignment, and runs the cuts on the original**, as for a
   scan with a missing file. The scan is still served — uncorrected, in the
   same frame — and the script exits 0. Unlike `align.py`, a reliable
   correction is not applied when only the RTK fit failed: a `fail` never
   moves anything.

Sampling uses a seeded PRNG (seed 0, per scan), so a re-run is
byte-identical. It does not reproduce numpy's draws, so results match
`align.py`'s to within the sampling's noise, not exactly (see *Tests*).

### On the scans delivered

The 15 of 22 that have every file, as of 2026-10-24 (the other 7 lack
`map_config.json` and are skipped):

| status | scans |
| --- | --- |
| `pass` | KY0917-03 (0.065 m) |
| `corrected` | KY0917B (0.121 m), KY0917C (0.112 m), KZ0918-093638 (0.106 m), KZ0918-095308 (0.181 m), **KZ0917E (1.696 m, 0.44°)** |
| `fail`, RTK p95 just over 0.10 m | KZ0918-090946 (0.107), KZ0918-132221 (0.1004), KZ0918153456 (0.112), KZ0917-06 (0.172) |
| `fail`, ICP | KZ0918-101007-1 (0.20) and -2 (0.39): one lidar for a split scan; KZ0918-075047 (0.31), KZ0918090721 (0.33), KZ0918160415 (0.40) — all three K2, whose RTK fit is also poor (p95 0.37–1.1 m) |

So the step corrects 6 scans and leaves 16 as they were. The four RTK
failures by a few millimetres to centimetres are the strict 0.10 m p95 doing
its job; whether that threshold is right for this scanner is a question for
the handoff, not a port.

## Why the frame does not change

`align.py` goes on to convert every Gaussian to a local ENU frame. Here it
does not, and nothing downstream has to change:

- The mosaic (`specs/splat-mosaic.md`) moves each cleaned scan into the
  common frame by its original's header offset alone. That holds only because
  the correction keeps the header's frame: after it, the Gaussians agree with
  RTK to the fit's residual, in that frame.
- Skipped scans and aligned scans share one frame, so `clean/` is uniform.
- The loader places each tile through UTM itself, the grid's −0.62°
  convergence and 0.99987 point scale included, which is all ENU would have
  removed.

## Output

- `<out.ply>`: a binary little-endian PLY with the input's properties in the
  input's order, read next by the density step. It lives in `process-splat.sh`'s
  temporary directory in `clean/`, like `dense.ply`: about as large as the
  original (0.9–1.3 GB). It is deleted as soon as the density step has read
  it, so the two are never on disk together for long.
- `<out.json>`, renamed by `process-splat.sh` to `clean/<scan>.align.json`
  alongside the `.ply`, and only when the whole run succeeds:

  ```json
  {
    "scan": "KZ0918-075047",
    "status": "pass",
    "tolerance_m": 0.1,
    "source_ply": { "epsg": 32651, "offset": [352796.83, 2770099.75, 26.90], "gaussians": 19312427 },
    "rtk_fit": { "rtk_fixed_pairs": 0, "false_fixes_dropped": 0, "residual_p50_m": 0, "residual_p95_m": 0 },
    "lidar_vs_ply": {
      "nn_p50_m_before": 0, "nn_p50_m_after": 0, "inliers_lt_0.1m_after": 0,
      "correction_max_m": 0, "correction_rot_deg": 0, "correction_applied": true
    },
    "correction": { "rotation": [[1,0,0],[0,1,0],[0,0,1]], "translation_m": [0,0,0] }
  }
  ```

  A `fail` is written the same way, with `correction_applied: false` and a
  `reason` (`"ICP inliers 0.22 <= 0.4"`, `"RTK p95 0.14 m > 0.10 m"`). A
  scan skipped for a missing file gets `{"scan": …, "status": "skipped",
  "reason": "no map_config.json"}`. So `clean/` always says what was done to
  each `.ply`. No `created`
  timestamp: re-running must give the same file.
- On stdout, one JSON line for `process-splat.sh` (`status`, the two RTK
  residuals, `correction_max_m`, `correction_rot_deg`, `correction_applied`),
  as `splat-density-cut.mjs` reports.
- Exit codes: `0` aligned, `.ply` written; `4` validation `fail`, no `.ply`
  (the `.json` is still written); anything else is an error and fails the
  scan.

Nothing reads the `.align.json` but people. It is not served: the `files`
service serves `tiles/`, not `clean/`.

## Memory and time

The PLY is read into one buffer, in 256 MB chunks (`readFile` stops at 2 GB),
and edited in place. The nearest-neighbour search is a k-d tree over the
target, built once, pruned by the query's distance to each cell (Arya &
Mount's incremental distance), not just to each splitting plane: 300,000
queries × 32 rounds. Measured: KZ0918-090946 (13.8M Gaussians, 937 MB) takes
14 s and peaks at 1.3 GB; KZ0918-075047 and KY0917B (19.3M, 18.6M) take
~20 s. The worst is KZ0918-101007-1, 76 s: its lidar covers both halves of a
split scan and the PLY only one, so most queries are metres from every
Gaussian and cost ~2,200 nodes each. Without the 0.2 m bound on the later
rounds it took 5.5 min, and with plane pruning alone 8. That is under the density step's 2.6 GB, so
the script's peak does not rise. End to end, `process-splat.sh` on KY0917B
took 2 min 13 s.

## Changes to `process-splat.md` (its revision 8)

Revision 1's changes, kept as history. `control_points.csv`,
`control-points.mjs` and `specs/control-points.md` were removed in revision 2
(*Changes in revision 2*), so the lines naming them no longer apply.

- **Step 0, align**, before the density cut, as above. The density step reads
  the aligned `.ply` when alignment ran, the original when it was skipped.
- *Where files live*: the script now reads the scan's `gnss.csv`, `poses.csv`,
  `octree.bin`, `metadata.json` and `map_config.json` when all are there, and
  writes `source/<scan>.align.json` beside the `.spz`.
- No new input. A validation `fail` is printed as an error line
  (`error: <scan>: align failed (<reason>); continuing unaligned`) on stderr,
  and the run carries on with the original.
- *Output contract*: "Gaussians are only removed, never moved" becomes "moved
  only by one rigid correction in the PLY's own frame, then only removed". A
  scan's `control_points.csv` rows from `control-points.mjs` stay valid; rows
  **measured by hand** on file coordinates of an aligned scan do not, by up to
  `correction_max_m`, and must be re-measured or regenerated. (None are, as of
  this revision: every row in `control_points.csv` is from GNSS.)
- The atomic-write rule covers the `.align.json` too: both are renamed into
  place only on success.
- *Report* gains the align line.
- *Out of scope* loses "the scan's `gnss.csv`".

## Changes in revision 2

- Paths only: `process-splat.sh` writes the scan to `clean/<scan>.ply` and
  this step's report to `clean/<scan>.align.json`, instead of
  `source/<scan>.spz` and `source/<scan>.align.json`.
- *Why the frame does not change*: its downstream reader is the mosaic, which
  places each scan by its header offset, and no longer `control-points.mjs`
  and the fit, which are removed (`specs/splat-mosaic.md`).
- The step, its rules and its tests do not change.

## Tests

`test/splat-align.sh`, run by `test/run.sh` and runnable on its own; it needs
only `node`. Its scans are written in a scratch directory by
`test/splat-align-scene.mjs`: a street canyon (40 × 20 m ground, 8 m walls,
six pillars) of solid Gaussians plus a translucent haze the ICP target must
leave out, written as `point_cloud.ply`; a trajectory out and back with a
U-turn, written as `poses.csv` in a frame turned 30° from the PLY's, and as
`gnss.csv` (fixes projected back through `scripts/utm.mjs`'s inverse, with a
status-1 `nan` fix between each); and the surfaces as a Potree `octree.bin`.
The cases that need `process-splat.sh` itself (and so splat-transform) are in
`test/process-splat.sh`, marked below.

- **Known displacement:** the Gaussians are shifted 0.5 m and turned 0.3°
  away from the lidar: status `corrected`, and the recovered correction undoes
  it within 1 cm at the bounding-box corners.
- **No displacement:** status `pass`, correction under 1 cm.
- **Rotations:** every Gaussian's centre, normal and quaternion come out
  moved by exactly `R`, `t`; Gaussian 0's non-unit quaternion keeps its
  magnitude; Gaussian 1's zero quaternion becomes `q(R)`. Scales, opacity and
  colour are byte-identical, the header is unchanged but for `minx…maxz`, and
  `minx` is the moved capture's.
- **Lever arm:** a trajectory that turns 180° with a 1 m lever arm fits with
  residual under 1 cm only when the arm is rotated by the pose.
- **False fixes:** one status-4 fix 5 m off is dropped and counted.
- **Not reliable:** lidar unrelated to the Gaussians gives `fail`, exit 4, no
  `.ply`. *In `process-splat.sh`:* it prints the error naming the scan and the
  reason, exits 0, its `.ply` is byte-identical to a skipped scan's of the
  same `point_cloud.ply` (no Gaussian moved), and the `.align.json` says
  `fail`.
- **RTK fit fails:** GNSS fixes scattered 0.3 m around the trajectory give
  `fail` on the p95, and nothing is moved even though ICP was reliable.
- **Skipped** *(in `process-splat.sh`)*: without `gnss.csv` and
  `map_config.json` the log names both and the `.align.json` says `skipped`;
  a `.sog` is skipped as not a `point_cloud.ply`, and the existing format
  cases give the counts they gave before.
- **Applied** *(in `process-splat.sh`)*: a misplaced scan is written put
  back — ~10,000 Gaussians past an end wall before, under 200 after.
- **Present but wrong:** a non-`DEFAULT` Potree encoding, a PLY with no
  `epsg`, a `map_config.json` without `rtk_external_param`: each refused,
  naming the file.
- A re-run gives a byte-identical `.align.json` and `.ply`.

**Against `align.py`, once, by hand** (Python 3.13, numpy/pandas/pyproj/scipy
in a scratch venv; not a test, as it needs pyproj):

| scan | `align.py` | this step | RTK p50 / p95, false fixes |
| --- | --- | --- | --- |
| KZ0918-090946 | fail, 0.051 m / 0.0048° | fail, 0.051 m / 0.0047° | 0.052 / 0.107 m, 31 — identical |
| KZ0918-075047 | fail (ICP), 2.115 m / 0.309° | fail (ICP 0.31), 2.124 m / 0.311° | 0.618 / 1.115 m, 0 — identical |
| KY0917B | corrected, 0.103 m / 0.0124° | corrected, 0.121 m / 0.0155° | 0.035 / 0.079 m, 192 — identical |

| KZ0917E | corrected, 1.696 m / 0.4423° | corrected, 1.696 m / 0.4415° | 0.040 / 0.099 m — identical |
| KZ0918-101007-1 | fail (ICP), 1.602 m / 0.111°, nn p50 4.25 m before | fail (ICP 0.20), 1.568 m / 0.103°, 4.26 m | 0.059 / 0.120 m, 135 — identical |

The RTK fit has no sampling and agrees to the millimetre. The approved
criterion, corrections within 1 cm and 0.01°, does not hold on KY0917B — and
cannot: this step's own seeds 1–3 give 0.092–0.121 m and 0.012–0.016° there,
and `align.py`'s 0.103 m / 0.0124° is inside that spread. A 0.003° wobble is
1.5 cm at a corner 300 m out. So the two agree to the sampling's noise, which
is what *What it does* promised; a scan whose correction sits near 0.10 m can
flip between `pass` and `corrected` with the seed, in `align.py` as here, and
either way the correction is applied.

## Docs

Revision 1's doc changes, kept as history: the `source/` paths and
`specs/control-points.md` are revision 2's `clean/` and gone, respectively.

- `infra/CLAUDE.md`: layout table gains `splat-align.mjs` and `utm.mjs`;
  `process-splat.sh`'s line reads `original/<scan>/ -> align -> density, size
  and floater cuts -> source/<scan>.spz + .align.json`; the "never modify
  `data/`" exception for `source/` names the `.align.json`; the splats
  paragraph's "`source/<scan>.spz` keeps these coordinates" adds "corrected
  by `splat-align.mjs`".
- `infra/specs/control-points.md`: "`process-splat.sh` converts nothing"
  becomes "moves the Gaussians only within this frame"; `utm()` lives in
  `scripts/utm.mjs`.
- `infra/README.md`: the cleaning section gains the align step.
- `app/ai/DECISIONS.md`: a new entry — align in the PLY's frame, not ENU; a
  node port, not the handoff's Python; scans missing a file, or failing
  validation, are served unaligned rather than refused.

## Out of scope

- The ENU conversion and `ecef_from_enu`; the SuperSplat viewer.
- Aligning formats other than `point_cloud.ply`.
- A lever arm for scans without `map_config.json` (they are skipped, not
  aligned with a zero arm).
- Running the step from `load.sh`.
- A `--no-align` switch. Nobody needs one yet, and deleting a file from
  `original/` to force a skip is not a substitute: `original/` is read-only.
