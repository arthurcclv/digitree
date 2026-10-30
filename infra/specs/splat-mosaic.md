# Spec — `splat-mosaic.mjs`: every cleaned scan, in one frame, cut into 100 m tiles, the best scan per voxel

Status: **revision 1, approved 2026-10-29; its heights revised (no datum:
a tile stores ellipsoidal heights and records its own ground) and approved
2026-10-30.** Approved with the
revisions to the other specs listed in *Downstream changes this spec
requires*, which were written in the same change as the code:
`process-splat.md` revision 10, `build-lod.md` revision 4,
`splat-align.md` revision 2, `voxel-quality.md` revision 1, and the splat
layer spec's revision 12.

## What it is

Today every scan is its own capture: cleaned on its own
(`process-splat.sh` → `source/<scan>.spz`), built into its own LoD tree, and
placed on the map on its own. Where scans overlap, all of them are drawn, one
through the other.

This spec replaces that with a **mosaic**. Every cleaned scan is moved into
one common frame, the same frame the app draws a header-placed capture in.
The area they cover is cut into **100 m × 100 m tiles** (no height limit),
and each tile is made of **1 m × 1 m × 1 m voxels**. For every voxel, the
mosaic looks at each scan that has splats in it and keeps the splats of
**the one scan of best quality** there. The other scans' splats in that voxel
are dropped. "Quality" is decided from the splats alone, by a separate,
replaceable module (`specs/voxel-quality.md`).

The served captures are then the tiles, not the scans. Each tile is a `.ply`
that `build-lod.sh` turns into a `.rad` directly, with no SPZ step, and the
loader places each one from its own georeference, as it places a scan from
its PLY header today.

```bash
./scripts/process-splat.sh KZ0918-075047      # per scan, as today: align, cuts → clean/KZ0918-075047.ply
node scripts/splat-mosaic.mjs                 # every clean scan → tiles/<tile>.ply + georef.csv + mosaic.json
./scripts/build-lod.sh --all                  # every tile → lod/<tile>-lod.rad + chunks
./load.sh
```

## The pipeline, before and after

```
before:  original/<scan>/point_cloud.ply
           → process-splat.sh  (align, density, size, floaters, SPZ v3)  → source/<scan>.spz
           → build-lod.sh <scan>                                           → lod/<scan>-lod.rad
           georef.mjs / control-points.mjs  → georef.csv / control_points.csv → loader, one row per scan

after:   original/<scan>/point_cloud.ply
           → process-splat.sh  (align, density, size, floaters, PLY)     → clean/<scan>.ply
           → splat-mosaic.mjs  (common frame, voxels, best scan, tiles)    → tiles/<tile>.ply, georef.csv
           → build-lod.sh      (PLY in, no SPZ)                            → lod/<tile>-lod.rad
           loader: header placement only, one row per tile
```

The per-scan steps keep their meaning and their settings. Only their output
changes: lossless `.ply` instead of SPZ v3. SPZ was needed only while the app
fetched the file itself, and it no longer does (the splat spec, *Level of
detail*).

## Where files live

```
data/3dgs/original/<scan>/       as delivered — read-only, unchanged
data/3dgs/clean/<scan>.ply       one cleaned scan, in its own PLY frame — written only by process-splat.sh
data/3dgs/clean/<scan>.align.json  what the align step did to it — process-splat.sh
data/3dgs/tiles/<tile>.ply       one tile of the mosaic, in its own frame — written only by splat-mosaic.mjs
data/3dgs/tiles/mosaic.json      the run's report — splat-mosaic.mjs
data/3dgs/georef.csv             one row per tile — written only by splat-mosaic.mjs
data/3dgs/lod/<tile>-lod.rad     + <tile>-lod-<n>.radc — written only by build-lod.sh
```

`data/3dgs/source/` and `data/3dgs/control_points.csv` are no longer read or
written. The implementation does not delete them from a working copy. They
are gitignored data, and removing them is the operator's call.

The "never modify `data/`" rule keeps its exceptions, renamed: `process-splat.sh`
owns `clean/`, `splat-mosaic.mjs` owns `tiles/` and `georef.csv`, and
`build-lod.sh` owns `lod/`. Each is derived from the one before it and can
always be rebuilt from `original/`.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `SPLATS_ORIGINAL_DIR` | `data/3dgs/original` | env: the scans as delivered, read for their PLY headers |
| `SPLATS_CLEAN_DIR` | `data/3dgs/clean` | env: the cleaned scans |
| `SPLATS_TILES_DIR` | `data/3dgs/tiles` | env: where the tiles are written |
| `SPLATS_GEOREF` | `data/3dgs/georef.csv` | env: the tiles' georeference |
| `SPLATS_QUALITY_MODULE` | `scripts/voxel-quality.mjs` | env: another module behind the quality seam, for tests and experiments only (`specs/voxel-quality.md`) |
| `SPLATS_MIN_TILE_SPLATS` | `10000` | env: the fewest splats a tile keeps (*Tiles and voxels*), for tests only: their scenes are a few splats each. Set, it must be a positive integer, or the mosaic fails naming it; set empty, it is the default |

These are variables for the same reason as the other tools' directories: the
test suite points the real script at a scratch directory.

There are no options. The tile size (100 m), the voxel size (1 m), the
smallest tile (10,000 splats) and the quality method are fixed. Changing one is a spec change, so every run of a
given revision gives the same mosaic.

**The scans in the mosaic** are every `clean/<scan>.ply`. Each one must have
`original/<scan>/point_cloud.ply` with a georeferenced header (`comment epsg`,
`offsetx`, `offsety`, `offsetz`, read by `ply-header.mjs`). The cleaned file
does not carry the header: splat-transform drops comments. The align step
moves Gaussians within the PLY's own frame and never changes its offset
(`specs/splat-align.md`), so the original's header is the cleaned file's
frame. A header is read from the file's first 64 KB, which holds the
delivered headers many times over; one that does not end within them is
not found. The mosaic fails, naming the scan, on:

- a clean scan with no original folder, no `point_cloud.ply`, an original
  in another of `process-splat.sh`'s formats (`point_cloud.spz`, …, which
  carry no georeference), or a header without the georeference;
- scans that do not all name the same EPSG. Within one UTM zone the move into
  the common frame is a pure translation (below). Across zones it is not, and
  that is out of scope;
- no clean scans at all.

## The common frame

Every delivered scan is stored as (E − offsetx, N − offsety, h − offsetz):
x east and y north of its zone's grid, z up, in grid metres (the splat spec,
*The captures*). So all scans in one zone already share their axes, and their
only difference is the offset. The **common frame** is the zone itself:

```
E = offsetx + x      N = offsety + y      H = offsetz + z
```

computed in double precision. H is the WGS 84 ellipsoidal height, `gnss.csv`'s
datum, as RTK measured it: no datum is subtracted. Where the map's ground
falls is decided per tile, after the selection (*The ground*), and applied by
the loader, never baked into the coordinates.

Nothing rotates and nothing scales. A Gaussian's rotation, scales, opacity
and colour are copied unchanged, and only its centre moves. This is exactly
how the app draws header-placed scans today, each at its own offset, with
grid north as +y and 1/k as its scale (the splat spec, *Georeference CSV →
`splats` table*). So the mosaic, drawn tile by tile, lands where the scans
land now, to float32 rounding (under 0.1 mm).

The height of each scan relative to the others is RTK's, and inside a tile it
stays exactly that.

## Tiles and voxels

The grid is fixed in the zone, not to the data:

- **A tile** covers `[100·i, 100·i + 100) × [100·j, 100·j + 100)` in (E, N) for
  integers i, j, at every height. Its id is `<EPSG>-<E0>-<N0>`, with (E0, N0)
  = (100·i, 100·j) its south-west corner in whole metres, e.g.
  `32651-352600-2770000`. A tile exists only if it holds at least
  **`MIN_TILE_SPLATS` = 10,000 splats** after the selection. A tile with
  fewer is **dropped**: it is written nowhere, and its splats are not kept.
  Such a tile is a scan's stray fringe, floaters and sky, with no ground to
  stand on: on the delivered scans, 11 tiles of 3 to 517 splats, 1,332 in
  all of 212 million, whose grounds came out between 26.4 and 96.9 m. The
  next smallest held 25,588.
- **A voxel** covers `[e, e + 1) × [n, n + 1) × [h, h + 1)` in (E, N, H) for
  integers e, n, h. 10,000 voxel columns make a tile.
- **A splat belongs to the voxel holding its centre.** Its extent is not
  considered. After the size cut no axis is over 0.25 m, so a splat reaches at
  most about 0.75 m (3σ) into a neighbouring voxel or tile.

Because the grid is fixed, adding a scan or re-cleaning one can change only
the voxels it reaches. Every other voxel keeps its winner.

## The selection

For every voxel that holds splats of at least one scan:

1. Each scan with splats in it gets a **score** for that voxel. The score is
   computed from that scan's splats in that voxel alone: their positions
   within the voxel, opacity, scales, rotation and colour. No other input
   is used: not the scan's poses, RTK, distance to the camera path, or the
   neighbouring voxels.
2. **One scan is chosen** from those scores. Both steps are the quality
   module's (`specs/voxel-quality.md`). The mosaic knows nothing about how
   they work. When the module returns several candidates as equally good, the
   one whose scan name sorts first (byte order) wins, so the result never
   depends on read order.
3. Every splat of the chosen scan in that voxel goes into the voxel's tile.
   No splat of any other scan in that voxel is kept.

A voxel with one scan in it keeps that scan's splats, with no scoring
needed, and the module is still called so that its report counts every voxel.

**Known effect, not corrected:** neighbouring voxels can be won by different
scans, so a surface can be stitched from two scans at a 1 m pitch. Where the
two scans disagree in position (several scans did not pass the align step;
their RTK p95 is 0.10–0.17 m), the seam shows as a step of that size. No
smoothing of the winners across voxels is done in this revision (*Open
items*).

## The ground

The map has no terrain: every other layer stands on height 0. So each tile
records the height of **its own ground**, and the loader draws the tile
that much lower, which puts that ground on the map's (the splat spec,
*Georeference CSV → `splats` table*). Each tile is put on the ground on its
own, with no regard to its neighbours.

**The estimate**, over the splats the tile keeps (every scan, after the
selection), from their z as the tile stores it (float32, which keeps H to
a few µm):

1. **A height histogram**: bin b holds the splats with
   `floor(H / GROUND_BIN_M) = b`, `GROUND_BIN_M` = 0.1 m. Every splat counts
   once, whatever its opacity or size.
2. **The peak** is the largest bin count. Of two bins with that count, the
   lower is the peak, so `peak_m` does not depend on the order of the bins.
3. **The ground bin** is the lowest bin whose count is at least
   `GROUND_PEAK_FRACTION` = 0.2 of the peak. The comparison allows 10⁻⁹
   for floating-point error (0.2 × 15 is 3.0000000000000004), so a count of
   exactly a fifth of the peak counts.
4. **The ground**, `ground_m`, is the median z of the splats in the ground
   bin (the mean of the middle two for an even count), rounded to the
   millimetre, so it is written as a short decimal.

Why the lowest dense layer, and not the lowest splats: below the ground,
3DGS grows sparse layers of its own (reflections in puddles, glass and
polished paving), which the floater cut does not always remove. A low
percentile lands in them. The ground is usually the largest horizontal
surface in a tile, so it is the peak, or a layer near it, and those
reflections stay well under a fifth of it. The estimate sees the splats
alone, like the selection: not RTK, the antenna height, or a DEM.

**Known effects, not corrected:**

- **Steps between tiles.** Two neighbouring tiles whose grounds differ are
  drawn with that difference removed, so a surface that crosses their edge
  shows a step there: about 1 m for a 1% slope between tile centres, plus
  the two estimates' error on flat ground. The report gives the largest one
  (*Output contract*).
- **A tile whose ground is hidden** (a roof, a canopy, or a scan that saw
  little road) puts its lowest dense layer on the ground instead, and sinks
  by the difference. The report gives each tile's bins, so such a tile can
  be found.
- **Slopes inside a tile** keep their true shape: part of the tile is above
  the map's ground and part below.

**To measure before the change is called done**, on the delivered scans,
recorded in `app/ai/WORKFLOWS.md`: every tile's `ground_m` against its
scans' antenna heights (each scan's `offsetz` less 1.4–1.7 m, where a scan's
first fix is in the tile), and the largest step between neighbours. A step
over 1 m on the flat delivered area means the constants are revised before
landing. The antenna comparison is recorded only, and does not hold the
change back: scans in one tile differ in `offsetz` by up to 1.3 m, so their
antennas are not all 1.4–1.7 m up, and the first run had 12 of 22 scans
more than 0.5 m off while those in one tile shared one ground. A step up to 1 m is
accepted as the ground's own slope: 1% over the 100 m between tile
centres. The first run measured steps of 0.50–0.90 m between six pairs of
neighbours.

## Output contract

**`tiles/<tile>.ply`**, one per tile, binary little-endian PLY:

```
ply
format binary_little_endian 1.0
element vertex <n>
comment epsg <EPSG>
comment offsetx <E0 + 50>
comment offsety <N0 + 50>
comment offsetz 0
comment mosaic splat-mosaic revision 1, quality <name> v<version>
property float x          … y, z
property float f_dc_0     … f_dc_1, f_dc_2
property float opacity
property float scale_0    … scale_1, scale_2
property float rot_0      … rot_1, rot_2, rot_3
end_header
```

- **The tile's own frame**: a splat at (E, N, H) is stored as
  (E − (E0 + 50), N − (N0 + 50), H), so the tile's centre is its origin, x and
  y lie in [−50, 50), and z is the ellipsoidal height itself. This is the
  delivered PLY convention, with the tile's centre as the offset and 0 as
  `offsetz`, so a tile is placed by exactly the rule a scan is placed by.
  The ground is not in the header: it is `georef.csv`'s `GROUNDZ`.
- **The origin is on the ellipsoid**: local (0, 0, 0) is the tile's centre
  at ellipsoidal height 0. Three things follow, none of which needs
  correcting:
  - The frame is flat (UTM's grid and ellipsoidal height, the scans' own
    frame), and the ellipsoid curves away from it by d²/2R, about 0.2 mm
    at the tile's edge.
  - Ellipsoidal height 0 is not sea level: in Taiwan the geoid is some 20 m
    above the ellipsoid, so the ground is about 25 m above the origin while
    its orthometric height is a few metres. Nothing here uses orthometric
    heights; a DEM would need the geoid to be compared (*Why each
    tile has its own ground*).
  - The origin is drawn about 25 m below the map (the loader's `ground_z`
    is `GROUNDZ`, and the app draws local z = `ground_z` at the map's
    ground), and is only the pivot of the placement: heading turns
    about the vertical, which leaves heights alone. The scale 1/k
    (1.00013 here) reaches z too, so the app puts the origin
    `ground_z × scale` metres below the map, not `ground_z`, and the
    ground lands on it exactly rather than about 3 mm above.
  The origin is the centre, not the corner, because the app measures a
  capture's distance from its origin when deciding what to load.
- **Properties**: the 14 above, in this order. Normals (`nx`, `ny`, `nz`,
  which the delivered scans carry as zeros) are dropped. A cleaned scan whose
  layout lacks any of the 14, or carries spherical harmonics beyond degree 0,
  fails the mosaic, naming it. The delivered scans all have SH degree 0, and
  higher degrees are out of scope.
- **Order**: by scan name, then in each scan's file order. A re-run over the
  same inputs is byte for byte identical.
- **Coordinates are exact in double precision until the final float32 write.**
  Within ±50 m float32 keeps about 4 µm. z, the ellipsoidal height, is
  about 25 m here (2 µm), and still keeps 0.25 mm at 4,000 m.

**`georef.csv`**: rewritten whole, one row per tile, sorted by id, in the
header the loader already reads:

```
SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ,GROUNDZ
32651-352600-2770000,32651-352600-2770000.ply,32651,352650,2770050,0,24.98731
```

Numbers are written in their shortest exact form (JavaScript's
`String(number)`), here and in the tile headers. `OFFSETZ` is the header's,
0 for every tile. `GROUNDZ` is the tile's `ground_m` (*The ground*). The loader publishes
`ground_z` = `GROUNDZ − OFFSETZ`, the ground's local z, which for a tile is
`GROUNDZ` itself, and the app draws that z at the map's ground.

**`tiles/mosaic.json`**: the run's report, rewritten whole:

```json
{
  "revision": 1,
  "quality": { "name": "coverage-sharpness", "version": 1 },
  "ground": { "bin_m": 0.1, "peak_fraction": 0.2 },
  "epsg": 32651,
  "scans": [{ "scan": "KY0917A", "offset": [352619.57, 2770018.47, 26.36], "splats": 7123456, "kept": 3011223, "voxels_won": 812345 }],
  "tiles": [{ "id": "32651-352600-2770000", "splats": 1834221, "voxels": 61234, "contested_voxels": 20412, "won_by": { "KY0917A": 40211, "KY0917C": 21023 },
              "ground": { "ground_m": 24.98731, "bin_splats": 98213, "peak_m": 25.0, "peak_splats": 101554, "lowest_m": 22.43 } }],
  "dropped_tiles": [{ "id": "32651-352500-2769800", "splats": 52 }],
  "ground_steps": [{ "tiles": ["32651-352600-2770000", "32651-352700-2770000"], "step_m": 0.12 }],
  "totals": { "splats_in": 0, "splats_kept": 0, "splats_dropped": 0, "voxels": 0, "contested_voxels": 0, "largest_ground_step_m": 0.12 }
}
```

`contested_voxels` are the ones with more than one scan in them, which is
where the selection made a choice. A tile's `ground` gives the estimate
(`ground_m`) and how it was reached: the splats in the ground bin, the
peak bin's floor (`peak_m`, `b · GROUND_BIN_M`) and count, and the lowest
splat's H. `ground_steps` lists every pair of tiles that share an edge
(not a corner), sorted by id, with `step_m` = |their `ground_m` difference|,
to the millimetre. `peak_m` and `lowest_m` are to the millimetre too, and
`largest_ground_step_m` is `null` when no two tiles share an edge.
`dropped_tiles` lists, by id, each tile under `MIN_TILE_SPLATS` and the
splats it would have kept; they are not in `tiles`, `ground_steps` or
`georef.csv`, and their splats, voxels and wins are in no count but
`splats_dropped`. So `splats_in` = `splats_kept` + `splats_dropped` + the
splats the selection dropped.

**The swap.** Everything is written into a temporary directory inside
`tiles/`, and `georef.csv` is then staged as a temporary file beside
`SPLATS_GEOREF`, so every rename that follows stays on one filesystem. Only
when all of it is written does the swap start: the old tiles and
`mosaic.json` are moved aside into the temporary directory, the new ones
renamed in, and the staged `georef.csv` renamed over the old one last. If
any step of the swap fails, the new files are removed and the old ones moved
back. A failed run, at any point, leaves the previous mosaic, and no partial
or temporary file, in place. If `tiles/` did not exist before the run, a
failed run leaves no `tiles/` either. A tile that no longer exists is removed from
`tiles/`. `lod/` is `build-lod.sh`'s, and the mosaic does
not touch it.

**Reported on stdout**: the scans, and for each scan its splats in and kept;
the number of tiles, voxels and contested voxels; each tile's ground; the
tiles dropped and their splats; the largest step between neighbouring
tiles and which two; the totals.

## How it runs

Bucket first, then one tile at a time, so memory is bounded by one tile and
never by the whole area. A table of every voxel at once cannot be held: the
area can have tens of millions of occupied voxels, and a JavaScript `Map`
stops at 2²⁴ (about 16.7 M) entries.

1. **Bucket.** Each scan is read once, streamed, in name order. Every splat is
   moved into the common frame and given its tile and its voxel, in double
   precision. It is then appended, already in its tile's frame, to a bucket
   file for (tile, scan) in the run's temporary directory. Disk use while the
   run lasts is about the size of the cleaned scans again, and the buckets
   are deleted with the directory.
2. **Per tile**, in id order: read the tile's buckets, one per scan that
   reaches it. Group each scan's splats by voxel, score each (voxel, scan)
   with the quality module, and let it choose per voxel. Estimate the
   tile's ground from the kept splats (*The ground*). Then write the tile:
   each scan in name order, each of its splats in file order, keeping those
   whose voxel that scan won. The count is known before the header is
   written, because the winners are chosen first.

Splats in a cleaned scan are not assumed to be sorted by position.

It is a Node script, `scripts/splat-mosaic.mjs`, run from `infra/` like the
other `.mjs` tools. It reads PLY itself, through a layout reader added to
`ply-header.mjs` (the one `control-points.mjs` had, which goes with it), and
does not use splat-transform. That
library reads x and y negated (`infra/CLAUDE.md`), and nothing here needs
it.

## Downstream changes this spec requires

### `process-splat.sh` (its spec, revision 10)

- Writes `clean/<scan>.ply` (lossless, splat-transform's `.ply` output) and
  `clean/<scan>.align.json`, instead of `source/<scan>.spz` and its
  `.align.json`. The final transform keeps `-F` and drops `--spz-version 3`.
- The steps, their order, their defaults and their failure modes are
  unchanged: align, density, size, floaters.
- `SPLATS_SOURCE_DIR` becomes `SPLATS_CLEAN_DIR`.

### `build-lod.sh` (its spec, revision 4)

- Reads `tiles/<tile>.ply` instead of `source/<scan>.spz`. Spark's `build-lod`
  at v2.3.1 reads PLY itself (`MultiDecoder`, which detects the format by
  content), so nothing converts the file first. The method stays the same:
  `--quality --rad-chunked`.
- Takes one or more tile ids, or **`--all`**, which builds every tile in
  `tiles/` and then removes from `lod/` the trees of tiles that no longer
  exist. Building one tile at a time keeps the existing swap rules, applied
  per tile.
- `SPLATS_SOURCE_DIR` becomes `SPLATS_TILES_DIR`.

### The loader

- **Header placement only.** `splats_placement` and the `control_points`
  way are removed: `04_splats.sql`'s fit, `control_points.csv`, the psql
  variables `splats_placement`, `splats_csv` and `splats_max_rms_m`, and
  `SPLATS_PLACEMENT` in `load.sh`. `rms_m` and `points` leave the `splats`
  table, which only the fit filled. With one way left, `04_splats_header.sql`
  is folded into `04_splats.sql`.
- `File` must end in **`.ply`** (lower case), instead of `.spz`, and must
  exist in `tiles/`. The `splats_dir` variable points at `tiles/`. Its LoD
  rule is unchanged: `File` less its extension, plus `-lod.rad`.
- **`georef.csv` gains `GROUNDZ`** (*Output contract*). The published
  `altitude_m` is replaced by `ground_z` = `GROUNDZ − OFFSETZ`
  (`double precision`), the ground's local z, which the app draws at the
  map's ground. The datum groups and `splats_datum_gap_m` are removed: the
  loader computes nothing across captures.
- `bytes` is the tile `.ply`'s size, as it was the `.spz`'s.

### Removed tools

- `control-points.mjs`, `specs/control-points.md`, `test/control-points.sh`
  and `test/control-points-scene.mjs`: the fit they feed is gone.
- `georef.mjs`, `specs/georef.md` and `test/georef.sh`: `georef.csv` is now
  written by the mosaic, one row per tile.
- `scan-csv.mjs`, which only those two used.
- `ply-header.mjs` and `utm.mjs` stay. The mosaic reads headers, and now
  the body layout, through the first, and `splat-align.mjs` uses the second.

### The `files` service

`/3dgs/` serves `tiles/` instead of `source/`. The app never fetches it
(`SplatSource.files` stays in the descriptor, unused, as now), and
`/3dgs-lod/` is unchanged. `load.sh` restarts the service after every
load, as it restarts Martin. On Docker Desktop for Mac, a running container
can serve a bind-mounted `tiles/` or `lod/` from before the mosaic or
`build-lod.sh` renamed new files in (`app/ai/DECISIONS.md`, 2026-10-30).

### The app (splat spec, revision 12)

- **`SPLAT_MAX_CAPTURES` is 256** instead of 16. A capture is now a 100 m tile.
  The delivered scans' header extents span about 740 m × 700 m, so at most
  64 tiles (8 × 8, once the fixed grid's alignment is counted), and fewer
  once empty tiles are dropped. With 16 only the nearest 16 would draw,
  leaving holes in the mosaic. 256 leaves room for more scans.
- Nothing else changes. A tile is a header-placed capture like any other:
  `lng`/`lat` at its centre, `heading_deg` the grid convergence there, `scale`
  1/k there, and `ground_z` its ground. `placeCapture`, the stretch, the
  residency rules and `lodUrlOf` read it as they read a scan today.
- **`ground_z` replaces `altitude_m`** (`Splat.groundZ` for `altitudeM`):
  `schema.ts` reads it, and `placeCapture` puts the origin
  `groundZ × scale` metres below the map's ground.
- **Risk, to measure before the app change is called done:** Spark's spec'd
  floor is one root page per loaded capture. With at most 64 tiles loaded,
  at most 64 of the desktop pool's 256 pages are roots, leaving at least 192
  for detail. On iOS, at most 64 of its 96 pages are roots, which leaves 32
  or more for detail, so distant tiles will be coarse there. The splat spec's measurements
  (first draw, fps orbiting, memory, how coarse a still view is) are repeated
  with the mosaic and recorded. If the pool starves, the next step is an
  open item, not part of this revision (*Open items*).

## Tests

`test/splat-mosaic.sh`, run from `test/run.sh` like the other script suites.
It works on synthetic scans written by `test/splat-mosaic-scene.mjs`: small
PLYs with real georeferenced headers in `original/` and cleaned copies in
`clean/`, so no binary fixture is checked in. It asserts:

- **frame**: a splat at known (x, y, z) in a scan with a known offset lands at
  the expected (E, N, H) in the expected tile, at the expected tile-local
  coordinates, to float32. Rotation, scales, opacity and colour are
  byte-identical;
- **heights**: a splat's tile z is its scan's `offsetz` plus its z, with no
  datum; every tile header and `georef.csv` row has `OFFSETZ` 0;
- **ground**: a tile with a dense layer and a sparse one 1 m below it
  (under a fifth of the peak) takes the dense layer, the median of its
  bin; a layer at exactly a fifth of the peak counts as ground, one splat
  fewer does not; an even count in the ground bin takes the mean of the
  middle two; two tiles of one run get their own grounds, and `GROUNDZ`,
  `mosaic.json`'s `ground` and `ground_steps` (edge neighbours only, not
  corners) carry those values;
- **grid**: splats at E = 100·i − ε and 100·i land in different tiles, and at
  e − ε and e in different voxels; negative tile-local coordinates are
  correct;
- **selection**: in a voxel shared by two scans, the scan the quality module
  prefers keeps all its splats and the other keeps none. In the same run, a
  neighbouring voxel won by the other scan keeps that scan's splats. A voxel
  with one scan keeps it. A tie goes to the scan that sorts first. The test
  uses a stub quality module through the module seam
  (`specs/voxel-quality.md`, *The seam*), so it does not depend on the real
  metric's numbers;
- **output**: the PLY header and property order, `georef.csv` (header, sort,
  values), and `mosaic.json`'s counts add up (`splats_kept` = sum of tile
  splats = sum of scans' `kept`);
- **dropped tiles**: with `SPLATS_MIN_TILE_SPLATS` set to 3, a tile of 2
  splats is dropped (no `.ply`, no `georef.csv` row, no step, in
  `dropped_tiles` with its count and in `splats_dropped`, in no scan's
  `kept` or `voxels_won`) and a tile of exactly 3 is kept; unset, the
  default is 10,000; `0`, `2.5` and `abc` are refused;
- **determinism**: a re-run is byte-identical, and so is a run with the scans
  listed in another order on disk;
- **swap**: a tile that disappears is removed. A failed run leaves the
  previous mosaic byte for byte, and no temporary directory or staged
  `georef.csv`, in three cases: an unreadable scan (before the temporary
  directory exists), a `georef.csv` that cannot be staged (after the tiles are
  written), and a `georef.csv` that cannot be renamed in (forced by
  `SPLATS_GEOREF` naming a directory: after the tiles are swapped, so they
  are moved back). A run that fails after making `tiles/`, by a quality
  module whose `choose` returns no index, leaves no `tiles/`;
- **refusals**: mixed EPSG, a clean scan without its original folder,
  without its `point_cloud.ply`, with a `point_cloud.spz` in its place, or
  without a georeferenced header, a layout missing a property or with SH > 0, and no
  clean scans.

`test/voxel-quality.sh` covers the real metric (its own spec). The suites of
`process-splat.sh`, `build-lod.sh` and the loader change with their specs:
`.ply` out of `process-splat.sh`, `.ply` into `build-lod.sh` with `--all` and
its pruning, and `.ply` only in the loader. The control-point fixtures and
the `control_points` cases in `test/run.sh` are removed, and a case loads a
`georef.csv` the real mosaic wrote, checking each tile lands at its centre,
with `ground_z` its `GROUNDZ`; the datum cases give way to `GROUNDZ` ones,
and every `georef*.csv` fixture gains the column. In `app/`,
`residency.test.ts` checks the new cap, and `schema.test.ts` and
`frame.test.ts` read and place `groundZ`.

## Docs, in the same change

- `infra/CLAUDE.md`: the layout block, the commands, the `data/` exceptions,
  the splat contract (placement: header only, `.ply`, `ground_z`), and the
  removed tools.
- `infra/README.md`, `app/ai/STACK.md` and `app/ai/WORKFLOWS.md`: the
  pipeline, in its new order; `WORKFLOWS.md` also the ground's measurement
  (*The ground*).
- `app/ai/DECISIONS.md`: one entry for the mosaic, which records the 100 m and
  1 m grid, the per-voxel winner, ellipsoidal heights with each tile's own
  ground, PLY in place of SPZ, and the end of the control-point fit. Every entry it reverses is marked
  superseded by it, in whole or in part: 2026-10-29 (placed by the header by
  default), 2026-10-25 (the control-point `H`), 2026-10-23 ("`.spz` only"),
  2026-10-23 (fitted on WGS 84: the fit half), 2026-10-22 (control points from
  the PLY's georeference), 2026-10-21 (`source/`) and 2026-10-20 (placed from
  control points), and the datum groups' entry (`altitude_m` = `OFFSETZ −
  datum`).

## Why each tile has its own ground

- One datum for the whole mosaic puts only the ground near its median
  height on the map's ground. A city's ground spans tens to hundreds of
  metres, and even the delivered scans' ground lay 1.4–1.7 m below the
  map's, because the datum, the median `offsetz`, was the antennas' height.
  Putting each tile's own ground at 0 fits the trees and buildings, which
  stand on 0, at the cost of steps at tile edges where the ground changes.
- **Not done:** one ground per group of touching tiles (no steps between
  them, but at city scale one group and one height again); a smooth ground
  field subtracted per splat (no steps and grounded everywhere, but it
  bends the splats, and needs a ground under every tile); a DEM.

## Open items

- **LoD and absolute z.** The tiles' z is about 25 m, not about 0. Check
  that `build-lod.sh`'s tree draws a tile at the same place and
  detail as before (the measurement above), and, before any scan at a much
  greater height, how Spark's `.rad` encodes positions.
- **Steps between tiles.** If `ground_steps` shows steps that matter, the
  options are the *Not done* items in *Why each tile has its own ground*.
- **Seams between winners.** Neighbouring voxels won by different scans can
  show the scans' misalignment as a step. A later revision might smooth the
  winners across voxels (e.g. a majority filter over each 3×3×3
  neighbourhood) or prefer the winner of the neighbouring voxels when scores
  are close. That needs `mosaic.json`'s contested counts and a look at the
  seams first.
- **Page pool.** If the tiles starve Spark's pool (on iOS first) (*The app*), the
  options are to pass a larger `maxPagedSplats`, or to make tiles larger.
  Both are spec changes.
- **Partial rebuilds.** Every run rebuilds every tile. Rebuilding only the
  tiles a changed scan reaches would save time, at the cost of a stored
  per-voxel candidate table.

## Out of scope

- Scans in different UTM zones, or in a format without a PLY georeference.
- Spherical harmonics beyond degree 0.
- Blending scans within a voxel. A voxel takes all of one scan's splats or
  none of them.
- Any use of the camera path, poses or RTK quality in the choice. The choice
  sees splats only, by design.
- Running the mosaic from `load.sh`. Like the other splat tools, it is an
  explicit step.
