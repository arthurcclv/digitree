# Spec — `control-points.mjs`: control points from a scan's georeference

Status: **revision 10 — approved 2026-10-29.** See *Changes from
revision 9*. Revision 9 — approved 2026-10-25. Revision 8 — approved 2026-10-25. Revision 7 — approved
2026-10-23.

## What it is

A script in `infra/scripts/`, run from `infra/`, that writes a scan's rows of
`data/3dgs/control_points.csv` from what the scanner recorded, instead of
points measured by hand in a viewer. For each scan it picks three RTK-fixed
GNSS fixes, spread wide and not in a line, and writes each fix twice: as
latitude/longitude, and in the splat file's own coordinates, through the
georeference the scanner wrote into the file's header. It also measures how
high the GNSS antenna was carried above the ground, from the capture's own
Gaussians, and writes that as each point's `H`, so the loader sets the
capture's ground on the map's ground.

```bash
node scripts/control-points.mjs             # every scan in original/
node scripts/control-points.mjs KZ0918-075047   # just these scans
```

## Where files live

```
data/3dgs/original/<scan>/   read-only, as delivered
  point_cloud.ply            the capture: its header (below) and, for the
                             antenna height, its x, y, z and opacity
  gnss.csv                   the GNSS receiver's fixes (below)
data/3dgs/control_points.csv the scan's rows are replaced; every other row is kept
```

`poses.csv` is not read. It is in its own frame (SLAM, origin at the first
pose, turned 21.9° and 91.3° from north on the two KZ0918 scans), and the
splat file is not in it — see *Changes from revision 3*.

| input | default | meaning |
| --- | --- | --- |
| `<scan>…` | every folder in `original/` with both `gnss.csv` and `point_cloud.ply` | bare scan folder names; a path, a scan given twice, or a folder missing either file, is refused, naming it |
| `SPLATS_ORIGINAL_DIR` | `data/3dgs/original` | env: where the scan folders are |
| `SPLATS_CONTROL_POINTS` | `data/3dgs/control_points.csv` | env: the file written |

The two paths are variables so the test runs the real script in a scratch
directory, as `process-splat.sh`'s are.

**`point_cloud.ply`'s header** carries the georeference as `comment` lines:

```
comment offsetx 352796.8287235790048726
comment offsety 2770099.7470906949602067
comment offsetz 26.9006000000000007
comment shiftx 0.0000000000000000      (and shifty, shiftz)
comment scalex 1.0000000000000000      (and scaley, scalez)
comment epsg 32651
```

and it means: a point at UTM easting `E`, northing `N` (in the CRS `epsg`
names) and height `h` is stored at

```
file x = E − offsetx,   file y = N − offsety,   file z = h − offsetz
```

z-up, metric, x east and y north of the projection's grid. The georeference
comes from the header alone. The vertices (the file is 0.9–1.3 GB) are read
only to measure the antenna height (step 6), in chunks, never whole; that
needs float properties `x`, `y`, `z` and `opacity` in a binary little-endian
body, the same requirement `splat-align.mjs` has.

This was checked on both KZ0918 scans, not taken from a format document:
`offsetx/y/z` is the scan's first `gnss.csv` fix in UTM 51N to under 1 mm, and
every status-4 fix, put through the formula, lies on the capture's splats
(median distance to the nearest splat 0 m at a 0.5 m grid, none over 5 m).
`source/<scan>.spz` keeps these coordinates: `process-splat.sh` converts
nothing (checked by decoding the SPZ positions). Its align step
(`specs/splat-align.md`) moves the Gaussians only within this frame, toward
where RTK and the lidar put them, so these control points fit the aligned
capture at least as well as the original.

**`gnss.csv`**: `#timestamp,status,latitude,longitude,altitude,…`. A fix
without a solution writes `nan` (1,966 of KZ0918-075047's, none of them
status 4); only status-4 fixes need numbers.

## What it does, per scan

1. **Georeference.** Read the PLY header (`scripts/ply-header.mjs`, shared
   with `georef.mjs` since 2026-10-29). Refuse the scan, naming it and the
   problem, when: the capture is not a `.ply`, or there is more than one
   `point_cloud.*` (as `process-splat.sh` refuses it); `epsg` or any of
   `offsetx/y/z` is missing or not a number; `epsg` is not a whole number
   (digits only, as the loader reads `georef.csv`'s) in WGS 84 / UTM
   (32601–32660 north, 32701–32760 south); a `shift*` is present and not 0, or
   a `scale*` is present and not 1 (their meaning is unverified, so they are
   refused rather than guessed).
2. **Candidates.** Every `gnss.csv` fix with `status` 4. Each must have a
   numeric latitude, longitude and altitude, or the scan is refused, naming
   the line. Non-RTK fixes are never used: KZ0918-075047 has 30% of its fixes
   at status 0, 1, 2 or 5.
3. **Project.** Each candidate to UTM in the header's zone and hemisphere
   (Krüger's series to n³ on WGS 84: under 1 mm within a zone; in
   `scripts/utm.mjs`, shared with `splat-align.mjs`), then into the file's
   frame by the formula above.
4. **Pick three.** On the candidates' file x, y: points 1 and 2 are the
   farthest-apart pair, and point 3 is the candidate farthest from the line
   through them. Ties go to the earlier fix, so a re-run picks the same three.
5. **Check.** Fails, naming the scan, when there are fewer than 3 candidates,
   when two picked points are under 2 m apart, or when the three are too close
   to a line: the smallest singular value of their centred file x, y is under
   2 m. These are the loader's own rules, measured the loader's way
   (`04_splats.sql`), so a file this writes cannot fail them at load. Distance
   off the line 1–2 is not the same measure: (0,0), (100,0), (50,2) is 2 m off
   it, but its singular value is 1.63 m.
6. **Antenna height.** How high the antenna was carried above the ground,
   measured on the capture's own Gaussians in the file's frame, so the
   loader puts this file's ground (not the true ground) on the map's:
   1. **Samples.** 50 candidates spread evenly through the scan in time:
      candidate `floor((i + 0.5)·n / 50)`, i = 0…49, in time order (all of
      them when n ≤ 50).
   2. **Under each sample:** the solid Gaussians (opacity logit > 0, that is
      opacity over 0.5) within 1 m of it horizontally and 0.5–3 m below it.
      Each gives a depth `d` = the sample's z − the Gaussian's z. A sample
      with fewer than 30 is skipped: nothing was captured under it.
   3. **The ground under a sample** is the densest 15 cm layer. Put `d` into
      5 cm bins, `floor(d / 0.05)`, and take the bin `b` whose count plus
      both neighbours' is largest, the nearer bin on a tie. The sample's
      antenna height is the mean `d` in `[(b − 1)·0.05, (b + 2)·0.05)`. The
      densest layer, not the lowest points, because floaters lie below the
      road and a sample over a car roof or a step finds that instead.
   4. **The scan's antenna height** is the median over the samples kept
      (the mean of the middle two for an even count). One height for the
      scan: a carried scanner stays at about one height, and the median
      outvotes the samples over a roof or a hole.
   5. **Refused**, naming the scan and the number: fewer than 10 samples
      kept, or a height outside 1.0–2.5 m.
7. **Write** one row per point:

   | column | value |
   | --- | --- |
   | `SplatID` | `<scan>` |
   | `File` | `<scan>.spz`, the format served (not checked here; the loader checks it) |
   | `Point` | `1`, `2`, `3` |
   | `X`, `Y`, `Z` | the fix's file x, y, z, 3 decimals |
   | `LAT`, `LON` | the fix's `latitude`, `longitude` as written in `gnss.csv` |
   | `ALT` | the header's `offsetz` as written (e.g. `26.9006000000000007`): the altitude of the file's origin, the same on all three points |
   | `H` | the scan's antenna height (step 6), 3 decimals, the same on all three points |
   | `Note` | `gnss <timestamp>; EPSG:<epsg>; antenna over <k> of <m> samples` — no commas, so it needs no quoting |

`04_splats.sql` fits the points with its 2D similarity on the WGS 84
ellipsoid, the same ellipsoid as UTM's (`app/src/layers/splat/specs/spec.md`,
*The solve*). So the fit carries the grid's turn from true north and the
projection's point scale, and nothing else: a file unit is a grid metre, 1/k
true metres, k ≈ 0.99987 here. On the real KZ0918 scans, as loaded:

| scan | heading | scale | RMS | origin from the first fix |
| --- | --- | --- | --- | --- |
| KZ0918-075047 | 359.38° | 1.0001 | 0.000 m | under 5 mm |
| KZ0918-090946 | 359.38° | 1.0001 | 0.000 m | under 5 mm |

(UTM 51N's grid convergence at 121.54° E, 25.04° N is −0.62°.) A fit
outside the loader's RMS and scale limits still fails the load.

The loader's vertical offset is `mean(H − scale·Z)`, so `H` lifts each
capture by its antenna height. As `control-points.mjs` measured it on the
22 delivered scans (2026-10-25), in metres, with the per-sample p10–p90 it
prints:

| scan | height | p10–p90 | samples kept |
| --- | --- | --- | --- |
| KY0917-03 | 1.730 | 1.69–1.75 | 50 |
| KY0917A | 1.501 | 1.44–1.54 | 50 |
| KY0917B | 1.525 | 1.41–1.57 | 50 |
| KY0917C | 1.721 | 1.64–1.76 | 50 |
| KZ0917-06 | 1.706 | 1.60–1.83 | 50 |
| KZ0917E | 1.685 | 1.43–1.79 | 50 |
| KZ0918-075047 | 1.569 | 1.48–1.68 | 50 |
| KZ0918-090946 | 1.723 | 1.70–1.76 | 50 |
| KZ0918-093638 | 1.719 | 1.69–1.75 | 50 |
| KZ0918-095308 | 1.707 | 1.68–1.75 | 50 |
| KZ0918-101007-1 | 1.469 | 1.37–1.57 | 36 |
| KZ0918-101007-2 | 1.506 | 1.47–1.60 | 14 |
| KZ0918-132221 | 1.505 | 1.43–1.56 | 50 |
| KZ0918-135904 | 1.551 | 1.51–1.60 | 50 |
| KZ0918-140755 | 1.535 | 1.47–1.60 | 50 |
| KZ0918-143613 | 1.556 | 0.53–1.69 | 50 |
| KZ0918-153127 | 1.714 | 1.52–2.02 | 48 |
| KZ0918090721 | 1.415 | 1.33–1.55 | 49 |
| KZ0918153456 | 1.358 | 1.16–1.42 | 49 |
| KZ0918160415 | 1.440 | 1.28–1.58 | 49 |
| KZ0918161007 | 1.710 | 1.67–1.75 | 50 |
| KZ0918162445 | 1.692 | 0.72–1.77 | 50 |

Heights come in two groups, about 1.7 m and 1.36–1.57 m, so they are
measured per scan and not set once. KZ0918-143613 and -162445 have a tenth of
their samples at 0.5–0.7 m (over a car or a wall), and their medians are
unmoved. KZ0918-101007-2's PLY is half a split scan, so most of its fixes
have nothing under them, and 14 samples remain.

**Against the lidar.** For the 15 scans with a lever arm (`map_config.json`),
the same measurement on `octree.bin`, all in the poses' frame (antenna = pose
+ rotated `rtk_external_param`), agrees with the above to a median of 0.03 m.
The PLY is the higher one on every scan (by 0.00–0.09 m), and the lidar's
per-sample spread is 3–10 times tighter (0.01–0.02 m on a clean scan). The PLY is
used anyway: what `H` must do is put this file's ground on the map, which the
PLY measures directly, and the PLY exists for every scan where the lever arm
does not.

## Output contract

- `H` is never blank in a row this writes.
- `control_points.csv` has the header `SplatID,File,Point,X,Y,Z,LAT,LON,ALT,H,Note`.
  A missing file is created with that header.
- **A file with the revision-8 header** (`SplatID,File,Point,X,Y,Z,LAT,LON,H,Note`,
  no `ALT`) is upgraded as it is written. The new header replaces the old
  one, and each kept row gains an empty `ALT` after its eighth field. The
  first eight fields of a row hold no quoted commas, since `Note` is the only
  free text, so that is the only change to the row. A file with any other
  header is refused, untouched.
- Rows whose `SplatID` is a scan being processed are removed; every other row
  (e.g. the hand-measured KY0917 captures) is kept byte for byte, in order,
  apart from that upgrade.
  The new rows are appended, scans in the order given.
- Written to a temporary file beside it and renamed into place only when every
  scan succeeded: one failing scan leaves the file untouched.
- `original/` is only read. Re-running gives the same file.
- Prints each scan's EPSG and offset, and its three points with their pairwise
  distances, the distance of point 3 from the line, and the spread across it
  (the singular value), so a poor spread is visible. It also prints the
  antenna height, the samples kept, and the per-sample p10–p90.
- Reading the vertices takes about 1–2 s per scan when the file is in the OS
  cache, and longer when it is not.

## What it does not check

- **That the header's georeference is true of the vertices.** It reads them
  only for the height, not to check the georeference. It was verified on the two KZ0918 scans as above; a capture
  whose header lies fits just as well and lands wrong. Check each new capture
  by eye after its first load.
- The GNSS antenna's offset from the scanner (lever arm) and any latency, as
  before: centimetres. The splat was built from the same trajectory, so its
  georeference already carries both.
- **The ground's own height.** The map has no terrain: its ground is 0 m
  everywhere. `H` puts the capture's ground on it on average over the three
  points, and keeps whatever slope the street has. Taipei's basin is flat
  enough that this is centimetres within a capture.
- **A scanner carried at changing heights.** One height per scan is assumed.
  A scan that changes, say from hand to pole, gets the median, and its
  p10–p90 in the printout shows it.

## Tests

`test/control-points.sh`, run at the end of `test/run.sh` and runnable on its
own; it needs only `node`. Its scans are written in a scratch directory. The
committed fixture `T1` is a `gnss.csv` and a header-only `point_cloud.ply`
(`poses.csv` is removed from it). It gains eight RTK fixes inside its
triangle, so it has twelve samples, and none of them is ever picked.
`test/control-points-scene.mjs` writes each test scan's vertices at run
time, keeping the header's comments: only `x, y, z, opacity`, a solid ground
of Gaussians at a known depth under its fixes, plus the layers a case asks
for. No binary is committed. `test/run.sh` loads a scratch copy of T1 with
that ground.

- **The projection against the vendor's own numbers:** a header whose offset is
  KZ0918-075047's, and that scan's first fix (25.039362564, 121.540875478,
  26.9006) as a fix: its X, Y, Z are 0.000, 0.000, 0.000. The offset was
  written by the scanner's software, so this checks the UTM step against an
  independent implementation, to the millimetre.
- a fix set with known extremes: the three picked points are the expected
  fixes, and X/Y/Z are their projected values;
- the farthest fix is status 2: it is not picked; a status-0 `nan` fix is
  skipped, not an error; a status-4 fix with `nan` is refused, naming the line;
- LAT/LON are written as in `gnss.csv`, and ALT as the header's `offsetz`
  is written (T1: `26.9006000000000007` on all three rows);
- an existing file with the revision-8 header, holding a KY row with a
  quoted, comma-bearing Note, is upgraded: the new header, and the KY row
  with an empty ALT after LON and its Note unchanged. A re-run is
  identical;
- a southern-hemisphere EPSG (327xx) is projected with the false northing;
- an existing file with a KY row, and an older row of the same scan: the KY
  row is kept byte for byte, the old row is replaced, and a re-run is
  identical;
- **The antenna height:**
  - A flat ground 1.600 m below every fix gives `H` 1.600 (within 5 mm) on
    all three points. The Note reads `antenna over 50 of 50 samples`.
  - It still does when that scene also has:
    - floaters scattered 2.0–2.9 m below;
    - a car roof 0.8 m below a fifth of the samples;
    - transparent Gaussians (opacity logit −2) forming a denser layer 1.2 m
      below.
  - A ground under only 9 of the 50 samples is refused, naming the scan and
    "9 samples".
  - A ground 0.7 m below every fix is refused as outside 1.0–2.5 m.
  - A PLY without `opacity`, or with a `double` `z`, is refused, naming the
    property.
  - Re-running gives the same `H`.
- refused, leaving the file untouched: a wrong header; collinear fixes; a thin
  triangle (100 m base, apex 2.2 m off it, which is 1.80 m across by the
  loader's measure); fewer
  than 3 candidates; a path as `<scan>`; a scan given twice; a folder
  without `gnss.csv`; a folder without `point_cloud.ply`; a
  `point_cloud.sog` instead; a header without `epsg`, or without `offsetz`;
  `epsg 3826`; `epsg 32651.0`; `shiftx 1`; `scalez 2`.
- through the real `04_splats.sql` (`test/run.sh`'s scratch database): `T1`'s
  output (fixes spread ~50 m) loads with the origin within 5 mm of the fix at
  the offset, the heading within 0.01° of 360° minus the grid convergence at
  that point (γ = atan(tan(λ − λ₀)·sin φ)), scale within 1e-4 of 1/k (k the
  UTM point scale there, 0.999868), and RMS under 5 mm.
  Replaces revision 3's "heading 30°" case, which tested the poses' frame.
  Its `altitude_m` is `H − scale·mean(Z)` within 1 mm, so the ground under
  the fixes lands at 0 m.

## Docs

Revision 9: the header in `infra/README.md` and `infra/CLAUDE.md` gains
`ALT`, with one line on what it is.

Revision 8:

- `infra/README.md`: the control-points paragraph says `H` is the measured
  antenna height, not blank, and that the vertices are read for it.
- `infra/CLAUDE.md`: where it says the header is trusted and the vertices are
  not read, it adds that they are read for the antenna height, and still not
  to check the georeference.
- `app/src/layers/splat/specs/spec.md`, *Control points CSV*: "Points on the
  ground (`H` blank) are best" applies to hand-measured points. A scan's
  points are its antenna, with `H` measured.
- `app/ai/DECISIONS.md`: a new top entry. A scan's `H` is its antenna height
  measured on its own Gaussians, not the lidar's, and why.

Earlier revisions:

- `infra/CLAUDE.md`: the layout line becomes `original/<scan>/gnss.csv +
  point_cloud.ply's header -> the scan's rows of control_points.csv`; the
  splats paragraph's "a capture's file, its scan's `poses.csv` and its
  control points share one frame" becomes "a capture's file and its control
  points share one frame", and the sentence calling the KZ0918 files y-down
  and not in their poses' frame is removed.
- `infra/README.md`: *From the scan's trajectory* becomes *From the scan's
  georeference*, describing the above.
- `infra/specs/clean-splat.md`: its out-of-scope line calling the KZ0918
  scans y-up is corrected (the PLYs as now delivered are z-up, georeferenced).
- `app/src/layers/splat/specs/spec.md`: the data paragraphs (*The frame*, the
  KZ0918 description, and *Changes in revision 3*'s "render wrong until
  redelivered") are corrected: the capture is drawn as stored, in its file's
  frame; for a scan, that frame is its PLY's georeference. The layer's
  behaviour does not change.
- `app/ai/DECISIONS.md`: a new entry at the top — control points come from the
  file's georeference and the RTK fixes; `poses.csv` is not used. It
  supersedes the poses half of *One frame for a capture, its poses and its
  control points* and the *A scan's control points can come from its
  trajectory* entry, both 2026-10-22, which are marked so.

## Out of scope

- Running it from `load.sh`; it stays an explicit step, like `process-splat.sh`.
- More than three points.
- Reading the georeference in `04_splats.sql` or the app instead of going
  through control points: the loader's fit and checks stay the one path every
  capture takes. *(Superseded 2026-10-29: the loader places by the header by
  default, through `georef.csv` (`specs/georef.md`); this script and the fit
  are the `splats_placement=control_points` way.)*
- Captures without a georeference (`.sog`, `.spz`, a PLY without the
  comments): they are refused, and placed by hand-measured points as before.
- Terrain: a map ground other than 0 m.
- Measuring the height on the lidar (`octree.bin`): it is tighter, but
  needs the lever arm, which 7 of the 22 scans lack, and measures the true
  ground, not this file's (*Against the lidar*).
- A per-point `H` (each point's own ground). One height per scan is steadier
  than any one spot, which may be a car roof.
- The 3dgs-viewer (another repository) uses `U = s·Z` and ignores `H`. It
  stays an antenna height low until it adds the loader's
  `mean(H − s·Z)`.

## Changes from revision 9

- A scan given twice is refused, naming it: its rows would be written twice.
- `epsg` must be digits only (`32651.0` is refused), the header rule
  `georef.mjs` shares through `scripts/ply-header.mjs`.
- The scan list, the kept rows and the rename move to `scripts/scan-csv.mjs`,
  shared with `georef.mjs`. The output is unchanged.

## Changes from revision 8

- **`ALT`, after `LON`: the header's `offsetz`, as written**, on every row.
  The CSV already carried the horizontal georeference, through `LAT`/`LON`
  against `X`/`Y`, but not the vertical one. With `ALT`, a point's GNSS
  altitude is `ALT + Z`. The loader validates it and does not use it
  (`app/src/layers/splat/specs/spec.md`, revision 9).
- A file with the revision-8 header is upgraded rather than refused (*Output
  contract*).

## Changes from revision 7

- **`H` is the scan's antenna height, measured, not blank** (step 6). With
  `H` blank the loader put the antenna on the map's ground, and every capture
  sat 1.36–1.73 m below it, sunk to about the operator's chest. The script
  now reads the vertices (`x, y, z, opacity`) for this. The georeference
  still comes from the header alone.
- The Note gains `antenna over <k> of <m> samples`.
- New refusals: fewer than 10 samples with ground under them; a height
  outside 1.0–2.5 m; a PLY lacking float `x, y, z, opacity`.
- "Setting `H` from the antenna's height above the ground" leaves *Out of
  scope*.

## Changes from revision 6

- The line check measures what the loader measures: the smallest singular
  value of the three points' centred x, y, under 2 m, instead of point 3's
  distance from the line 1–2. Before, a thin triangle could pass here and
  fail at load. Picking is unchanged. The refusal now reads "the RTK fixes are
  too close to a line (spread across it is … m)", and the summary line adds
  the spread.

## Changes from revision 5

- `control-points.mjs` moves from `infra/` to `infra/scripts/`, beside the
  other splat tools: `node scripts/control-points.mjs [<scan>…]` from
  `infra/`. Its default paths stay relative to the working directory, so it
  is still run from `infra/`. Nothing else changes.

## Changes from revision 4

- The loader fits on the WGS 84 ellipsoid, not the map's sphere (the splat
  spec's revision 6). The expected fit becomes heading ≈ 359.38°, scale
  ≈ 1.0001 and an RMS of millimetres, where it was 359.32–359.47°,
  1.0013–1.0030 and 0.13–0.22 m. The script itself does not change.
- The T1 case through the loader tightens from 10 cm, 0.2°, 0.5% and 10 cm
  to 5 mm, 0.01°, 1e-4 of 1/k and 5 mm.

## Changes from revision 3

- X, Y, Z come from the PLY header's georeference and the GNSS fix, not from
  `poses.csv`, which is no longer read. Revision 3 required the splat to be in
  its poses' frame; the KZ0918 PLYs are not — they are in UTM 51N less the
  first fix, x east, y north, z up — so the loader solved the poses' heading
  (21.89°, 91.28°) and applied it to captures already facing north: they drew
  18 m (median, 43 m at worst) and 166 m (292 m) off. Their fits looked good
  (RMS 0.06 m, 0.24 m) because the three points agreed with each other.
- Candidates are status-4 fixes, not poses matched to fixes within 0.1 s:
  without the poses there is nothing to match.
- A scan needs `point_cloud.ply` with a georeference; one without is refused.

## Changes from revision 2

- No conversion: X, Y, Z are the pose's x, y, z. Revision 2's fixed
  (y, −z, −x) conversion is removed; it held for KZ0918-090946 and not for
  KZ0918-075047. The splat is now required to be in its poses' frame instead.

## Changes from revision 1

- Revision 1 wrote the poses as if they were the file's frame (X = −x,
  Y = z, Z = y). The file is the poses converted by (y, −z, −x) and stored
  y-down, so the points are now X = −y, Y = z, Z = −x.
- The upright frame, and `UPRIGHT` in the splat layer, are new in that spec's
  revision 2; without them a capture lies on its side whatever its points.
