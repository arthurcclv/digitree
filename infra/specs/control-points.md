# Spec — `control-points.mjs`: control points from a scan's georeference

Status: **revision 7 — approved 2026-10-23.** See *Changes from
revision 6*.

## What it is

A script in `infra/scripts/`, run from `infra/`, that writes a scan's rows of
`data/3dgs/control_points.csv` from what the scanner recorded, instead of
points measured by hand in a viewer. For each scan it picks three RTK-fixed
GNSS fixes, spread wide and not in a line, and writes each fix twice: as
latitude/longitude, and in the splat file's own coordinates, through the
georeference the scanner wrote into the file's header.

```bash
node scripts/control-points.mjs             # every scan in original/
node scripts/control-points.mjs KZ0918-075047   # just these scans
```

## Where files live

```
data/3dgs/original/<scan>/   read-only, as delivered
  point_cloud.ply            the capture; only its header is read (below)
  gnss.csv                   the GNSS receiver's fixes (below)
data/3dgs/control_points.csv the scan's rows are replaced; every other row is kept
```

`poses.csv` is not read. It is in its own frame (SLAM, origin at the first
pose, turned 21.9° and 91.3° from north on the two KZ0918 scans), and the
splat file is not in it — see *Changes from revision 3*.

| input | default | meaning |
| --- | --- | --- |
| `<scan>…` | every folder in `original/` with both `gnss.csv` and `point_cloud.ply` | bare scan folder names; a path, or a folder missing either file, is refused, naming it |
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

z-up, metric, x east and y north of the projection's grid. The script reads
the header only, never the vertices (the file is 0.9–1.3 GB).

This was checked on both KZ0918 scans, not taken from a format document:
`offsetx/y/z` is the scan's first `gnss.csv` fix in UTM 51N to under 1 mm, and
every status-4 fix, put through the formula, lies on the capture's splats
(median distance to the nearest splat 0 m at a 0.5 m grid, none over 5 m).
`source/<scan>.spz` keeps these coordinates: `process-splat.sh` converts nothing
(checked by decoding the SPZ positions).

**`gnss.csv`**: `#timestamp,status,latitude,longitude,altitude,…`. A fix
without a solution writes `nan` (1,966 of KZ0918-075047's, none of them
status 4); only status-4 fixes need numbers.

## What it does, per scan

1. **Georeference.** Read the PLY header. Refuse the scan, naming it and the
   problem, when: the capture is not a `.ply`, or there is more than one
   `point_cloud.*` (as `process-splat.sh` refuses it); `epsg` or any of
   `offsetx/y/z` is missing or not a number; `epsg` is not WGS 84 / UTM
   (32601–32660 north, 32701–32760 south); a `shift*` is present and not 0, or
   a `scale*` is present and not 1 (their meaning is unverified, so they are
   refused rather than guessed).
2. **Candidates.** Every `gnss.csv` fix with `status` 4. Each must have a
   numeric latitude, longitude and altitude, or the scan is refused, naming
   the line. Non-RTK fixes are never used: KZ0918-075047 has 30% of its fixes
   at status 0, 1, 2 or 5.
3. **Project.** Each candidate to UTM in the header's zone and hemisphere
   (Krüger's series to n³ on WGS 84: under 1 mm within a zone), then into the
   file's frame by the formula above.
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
6. **Write** one row per point:

   | column | value |
   | --- | --- |
   | `SplatID` | `<scan>` |
   | `File` | `<scan>.spz`, the format served (not checked here; the loader checks it) |
   | `Point` | `1`, `2`, `3` |
   | `X`, `Y`, `Z` | the fix's file x, y, z, 3 decimals |
   | `LAT`, `LON` | the fix's `latitude`, `longitude` as written in `gnss.csv` |
   | `H` | blank (the loader reads it as 0: the GNSS antenna is put on the map's ground) |
   | `Note` | `gnss <timestamp>; EPSG:<epsg>` — no commas, so it needs no quoting |

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

## Output contract

- `control_points.csv` keeps its header `SplatID,File,Point,X,Y,Z,LAT,LON,H,Note`;
  a file with any other header is refused, untouched. A missing file is
  created with that header.
- Rows whose `SplatID` is a scan being processed are removed; every other row
  (e.g. the hand-measured KY0917 captures) is kept byte for byte, in order.
  The new rows are appended, scans in the order given.
- Written to a temporary file beside it and renamed into place only when every
  scan succeeded: one failing scan leaves the file untouched.
- `original/` is only read. Re-running gives the same file.
- Prints each scan's EPSG and offset, and its three points with their pairwise
  distances, the distance of point 3 from the line, and the spread across it
  (the singular value), so a poor spread is visible.

## What it does not check

- **That the header's georeference is true of the vertices.** The script never
  reads them. It was verified on the two KZ0918 scans as above; a capture
  whose header lies fits just as well and lands wrong. Check each new capture
  by eye after its first load.
- The GNSS antenna's offset from the scanner (lever arm) and any latency, as
  before: centimetres. The splat was built from the same trajectory, so its
  georeference already carries both.
- **Height.** With `H` blank the antenna's height is put on the map's ground,
  and the capture's ground sits that far below it: about 1.6–1.9 m on the
  KZ0918 scans (their ground is at file z ≈ −1.7). Unchanged from revision 3,
  where the pose origin did the same.

## Tests

`test/control-points.sh`, run at the end of `test/run.sh` and runnable on its
own; it needs only `node`. Its scans are written in a scratch directory. The
committed fixture `T1` becomes a `gnss.csv` and a header-only `point_cloud.ply`
(0 vertices); `poses.csv` is removed from it.

- **The projection against the vendor's own numbers:** a header whose offset is
  KZ0918-075047's, and that scan's first fix (25.039362564, 121.540875478,
  26.9006) as a fix: its X, Y, Z are 0.000, 0.000, 0.000. The offset was
  written by the scanner's software, so this checks the UTM step against an
  independent implementation, to the millimetre.
- a fix set with known extremes: the three picked points are the expected
  fixes, and X/Y/Z are their projected values;
- the farthest fix is status 2: it is not picked; a status-0 `nan` fix is
  skipped, not an error; a status-4 fix with `nan` is refused, naming the line;
- LAT/LON are written as in `gnss.csv`;
- a southern-hemisphere EPSG (327xx) is projected with the false northing;
- an existing file with a KY row, and an older row of the same scan: the KY
  row is kept byte for byte, the old row is replaced, and a re-run is
  identical;
- refused, leaving the file untouched: a wrong header; collinear fixes; a thin
  triangle (100 m base, apex 2.2 m off it, which is 1.80 m across by the
  loader's measure); fewer
  than 3 candidates; a path as `<scan>`; a folder without `gnss.csv`; a
  folder without `point_cloud.ply`; a `point_cloud.sog` instead; a header
  without `epsg`, or without `offsetz`; `epsg 3826`; `shiftx 1`; `scalez 2`.
- through the real `04_splats.sql` (`test/run.sh`'s scratch database): `T1`'s
  output (fixes spread ~50 m) loads with the origin within 5 mm of the fix at
  the offset, the heading within 0.01° of 360° minus the grid convergence at
  that point (γ = atan(tan(λ − λ₀)·sin φ)), scale within 1e-4 of 1/k (k the
  UTM point scale there, 0.999868), and RMS under 5 mm.
  Replaces revision 3's "heading 30°" case, which tested the poses' frame.

## Docs

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
  capture takes.
- Captures without a georeference (`.sog`, `.spz`, a PLY without the
  comments): they are refused, and placed by hand-measured points as before.
- Setting `H` from the antenna's height above the ground.

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
