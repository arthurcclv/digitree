# infra — local data stack

Postgres + PostGIS behind a [Martin](https://github.com/maplibre/martin) tile
server, serving Taipei's tree inventory to `app/` as vector tiles — plus the
Gaussian splat captures: where each one sits as vector tiles from Martin, and
the capture files themselves from a static `files` service.

```bash
cd infra
./load.sh                    # bring up, create schema, load, start Martin and files
```

Then:

```bash
curl -s localhost:3000/catalog | jq        # the published sources
curl -s localhost:3000/trees | jq          # TileJSON
curl -sI localhost:3080/3dgs/KY0917A.spz   # a splat capture file
```

Martin is published on `127.0.0.1:3000`. If that port is taken on the host,
set `MARTIN_PORT` for both `./load.sh` and any later `docker compose` command,
and point the app's proxy at it:

```bash
MARTIN_PORT=3001 ./load.sh
# in app/: TILES_PROXY_TARGET=http://localhost:3001 npm run preview
```

The `files` service is published on `127.0.0.1:3080` the same way, and
`FILES_PORT` moves it: `FILES_PORT=3081 ./load.sh`, then
`FILES_PROXY_TARGET=http://localhost:3081` for the app.

Check what answers on the port first. Another web server on `:3000` makes the
app fail with `Unimplemented type: 4`, because it gets back an HTML page where
a tile should be.

`docker compose down` stops it. `docker compose down -v` also drops the database
volume — the right way to start over.

## Tests

```bash
./test/run.sh
```

Runs `sql/01_schema.sql`, `sql/02_load.sql`, `sql/03_checks.sql` and
`sql/04_splats.sql` — the real
files — against the fixture CSVs in `test/fixtures/`, in a scratch database. It
covers the transform, the cleaning rules, the drop-in contract and the three
ways a drop-in is rejected, in a second or two and without touching `data/` or
the development database.

It then runs `./test/process-splat.sh`, the splat processor's own suite, which runs
the real `process-splat.sh` on captures it generates in a scratch directory. It
needs `splat-transform` and `node`, not the database, and runs on its own too.
Then `./test/control-points.sh` and `./test/georef.sh` test the control-point
and georef generators the same way, with only `node`; `run.sh` also loads
both scripts' output through the real `04_splats.sql`, in each placement. Last, `./test/build-lod.sh` runs the real `build-lod.sh`
on a capture it generates; it needs Docker, `node` and `splat-transform`.

`sql/03_checks.sql` also runs as the last step of `./load.sh`, so a load that
produces a structurally wrong table fails there rather than on the map.

## The data

Two extracts from Taipei City's open-data platform, placed in `data/`:

| file | rows | what it is |
| --- | --- | --- |
| `TaipeiTree.csv` | 90,919 | street trees, with road name and which side of it |
| `TaipeiParkTree.csv` | 72,011 | park trees, with park name |

They are **gitignored** — large, re-downloadable, and not ours to redistribute.
`load.sh` fails with a clear message if they are absent.

Both carry `TreeID`, `Dist`, `TreeType` (species), `Diameter` (cm),
`TreeHeight` (m), `TWD97X`/`TWD97Y`, `SurveyDate` and `UpdDate`. `TreeID` is
unique across *both* files, which is why they load into one table with a `kind`
column rather than two tables.

Coordinates are **TWD97 / TM2 zone 121 (EPSG:3826)** and are transformed to
WGS84 at load. Every row parses — there are no malformed coordinates.

### Custom drop-in datasets

`data/custom/` is an **optional** directory for your own tree data. Every
`*.csv` in it is loaded alongside the two extracts, as `kind = 'custom'`. No
directory, or an empty one, loads nothing and is not an error — only the two
extracts above are required.

The header must be exactly one of these two, in this order:

```
TreeID,TreeType,Diameter,TreeHeight,LAT,LON
TreeID,TreeType,Diameter,TreeHeight,CanopyWidth,LAT,LON
```

`CanopyWidth` is optional and, when present, follows `TreeHeight`. A file
without it loads with every width `NULL`. Write the names bare, exactly as above
— same case, no surrounding spaces, no quotes: the loader recognises the
seven-column header by the bare name `CanopyWidth`, and anything else is held to
the six-column header and rejected.

| column | maps to | notes |
| --- | --- | --- |
| `TreeID` | `tree_id` | must be unique across *every* file, including the two extracts |
| `TreeType` | `species` | may be empty |
| `Diameter` | `diameter_cm` | cm; cleaned like the extracts |
| `TreeHeight` | `height_m` | m; cleaned like the extracts |
| `CanopyWidth` | `canopy_width_m` | m, the crown's diameter seen from above; optional; kept when positive, else `NULL`. The extracts have no such column, so city rows are always `NULL` |
| `LAT`, `LON` | `geom` | **WGS84 degrees** — stored as-is, no transform |

`district`, `place`, `place_note` and `survey_date` are `NULL` for these rows:
the schema carries no columns for them.

Three failure modes, all deliberate:

- **A wrong header fails the load**, loudly, naming the file. `COPY … HEADER
  MATCH` compares the header against the expected columns, so a file with
  `LON,LAT` reversed — or with the extracts' own column set — is rejected
  instead of loading longitude into `lat`. The same holds for `CanopyWidth`
  anywhere but after `TreeHeight`, and for a misspelt, miscased or quoted
  width column: it is rejected rather than silently dropped. A header that is
  not UTF-8 fails the same way, with the file named.
- **A duplicate `TreeID` aborts the load**, naming the offending ids. Silently
  shadowing a city tree with a custom row is worse than refusing to start.
- **A row whose `LAT`/`LON` is empty, unparseable or outside (-90, 90) /
  (-180, 180) is skipped**, and the load prints how many were skipped per file.
  `geom` is `NOT NULL`, so there is no "null it and keep the row" option here
  the way there is for height.

One coupling to know about: the app declares the tile source's `bounds` as a
constant (`TREES_BOUNDS` in `app/src/layers/tree/constants.ts`). MapLibre never
requests a tile outside it, so **custom trees outside that box render nothing**
until the constant is widened. The load prints the extent per kind for exactly
this check.

### What gets cleaned, and why

Heights and diameters are usable but carry obvious data-entry damage. The full
rules, with the values that motivated them, are in the comment above the insert
in `sql/02_load.sql`. In short: height, diameter and canopy width are all kept
whenever they are **positive**, and none has a ceiling. A value that fails becomes `NULL`
rather than being clamped or zeroed, so an unmeasured trunk is never rendered as
a thin one. The same rules apply to custom rows: they are properties of what the
app can render, not of who supplied the file.

Diameter's floor is the half doing the work: **9,319** rows — 9,266 in the park
file and 53 in the street file — record a diameter of exactly `0`, which is a
surveyor leaving the field blank rather than a measurement. The `(0, 400]`
ceiling that used to sit above it was discarding two rows (468.8 and 2637.0) and
buying nothing that recognising a 26 m-wide trunk on sight does not.

Height has no upper bound on purpose. The column carries visible keying damage
— the street file's maximum is **2023.0**, a survey year typed into the height
field, and the park file's is **797.0** — and those rows now load and render at
that height rather than being discarded along with every genuinely tall tree
above the old 40 m cut. It is 22 rows out of 162,930 (p99 is 18.9 / 20.8 m), and
a visible spike a reader can recognise as bad data beats a silently missing
height. Note that the app's mesh half keeps the **tallest** trees when it
exceeds its instance budget, so those rows are never the ones culled.

### Gaussian splat captures

`data/3dgs/original/` holds the scans as delivered, one folder per scan with
the splat in one `point_cloud.<ext>` (beside `gnss.csv` and `poses.csv`), and
is never
written. `data/3dgs/source/` holds them cleaned, one `<scan>.spz` each —
by `./scripts/process-splat.sh` (below) — `data/3dgs/lod/` holds the paged LoD tree the
app draws for each, a header `<scan>-lod.rad` and its chunks
`<scan>-lod-<n>.radc`, built by `./scripts/build-lod.sh` (below), and
`data/3dgs/georef.csv` (or, the other way, `data/3dgs/control_points.csv`)
says where each one sits. All of them are **gitignored**. None is required:
with no CSV the `splats` table is empty and the map shows no splats.

The splat tools live in `scripts/` and, like everything here, run from
`infra/`. To add a capture:

1. copy its scan folder into `data/3dgs/original/`;
2. clean it into `source/` with `./scripts/process-splat.sh <scan>`;
3. build its LoD tree with `./scripts/build-lod.sh <scan>`;
4. write its georeference — `node scripts/georef.mjs <scan>` copies its
   `point_cloud.ply` header into `georef.csv` — and, for the control-point
   way, its control points (below);
5. run `./load.sh`.

A capture without its `lod/<scan>-lod.rad` fails the splat load.

**Placement.** The loader places the captures one of two ways, chosen by
`SPLATS_PLACEMENT`:

```bash
./load.sh                                   # header (the default): from georef.csv
SPLATS_PLACEMENT=control_points ./load.sh   # fitted to control_points.csv
```

Each reads only its own CSV. **By the header**, each capture sits where its
PLY's georeference puts it: origin `(offsetx, offsety)` in the header's UTM
zone, facing grid north (≈ 359.38° for KZ0918), at UTM's point scale
(≈ 1.0001). Its height is `offsetz`, the origin's RTK (ellipsoidal) height,
less a **datum** shared by its group. The map has no terrain, so the
captures are grouped by `offsetz` — a new group wherever sorted neighbours
differ by more than 5 m (`-v splats_datum_gap_m=…` in `psql`) — and each
group is lowered by its median `offsetz`. Within a group the heights stay
exactly RTK's relative to each other; the 22 delivered scans are one group,
datum 26.60 m. The origin is the antenna at the scan's first fix, so a
capture's own ground lands 1.4–1.7 m below the map's. The load prints each
capture's group, datum and height. A scan without a georeferenced PLY has
no row and is not loaded. Spec: `specs/georef.md`.

```
SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ
KZ0918-075047,KZ0918-075047.spz,32651,352796.8287235790048726,2770099.7470906949602067,26.9006000000000007
```

The georef load fails, naming the line or the capture, on a header other
than that one, an empty `SplatID` or `File`, a `File` that is a path, not
`.spz`, or not in `source/`, an `EPSG` outside WGS 84 / UTM, an offset that
is not a number, a `SplatID` or `File` on two rows, or a capture without its
LoD. **By the control points**, the load prints each capture's fit (`rms_m`,
`scale`, `heading_deg`) and every point's residual, and sets each capture's
ground on the map's.

**Aligning and cleaning.** A capture straight from training sits a few
centimetres — sometimes more — from where the scanner's own RTK and lidar put
it, and carries Gaussians that only get in the way on the map: sparse strays
around and above the scene, oversized blobs, and floaters.
`process-splat.sh` corrects the first, drops the rest, and writes the result
as SPZ v3 (Spark 2.3.1 does not load splat-transform's default v4):

```bash
./scripts/process-splat.sh KZ0918-075047                          # 2 m voxels, 1%, every axis <= 0.25 m
./scripts/process-splat.sh KZ0918-075047 --min-density 0.02 --max-scale 0.5
```

It reads the scan's one `point_cloud.<ext>` — `.ply`, `.compressed.ply`,
`.sog`, `.spz`, `.splat` or `.ksplat` — and writes `source/<scan>.spz`, with
`source/<scan>.align.json` beside it. A folder with none, or with more than one (say a
`.ply` and a `.sog` of the same scan), is refused: keep the one to serve. A
`point_cloud.mjs` is never run — a generator is code, and the folder is data.
Cleaning needs ~1 GB of free disk per 13M Gaussians for its intermediate file.

First it aligns (`scripts/splat-align.mjs`, a port of the XGRIDS handoff's
`align.py`), when the splat is a `point_cloud.ply` and the folder also has
`gnss.csv`, `poses.csv`, `octree.bin`, `metadata.json` and `map_config.json`:
it fits the trajectory to the RTK-fixed GNSS fixes (antenna lever arm from
`map_config.json`), carries the lidar into the PLY's frame with that fit,
matches it to the Gaussians by ICP, and moves every Gaussian by the rigid
correction found — within the PLY's own frame, so the control points below
still apply. The `.align.json` records the outcome: `pass` (moved under
10 cm), `corrected` (more), `fail` or `skipped`. A scan missing one of those
files is skipped, and one that fails validation (ICP matching under 40% of
the lidar, or the RTK fit's p95 over 10 cm) prints an error and is served
unaligned — the run still succeeds. Of the 22 scans delivered, 7 have no
`map_config.json`. The step takes ~20 s and 1.3–1.8 GB, under what the
density step needs.

The outlier rule follows the capture's own distribution, not a distance. It
counts the Gaussians in 2 m cubes (`--cell`), takes the count of the cube the
median Gaussian sits in as the capture's typical density, and drops every
cube holding less than 1% of that (`--min-density`). Then it drops the
Gaussians with any axis over `--max-scale` and runs splat-transform's floater
filter (`--floaters`, its defaults). So a long or L-shaped street is kept
whole, and a sky floater above a dense street goes. It always reads
`original/`, so re-running with other settings never compounds the cuts, and
apart from the alignment it only removes Gaussians — the control points
stay valid.

With the defaults the KY0917 captures lost 3.7–5.3%. It needs
`splat-transform` 3.10.x installed globally with npm (the density step uses its
library) and `node`. It holds a scan in memory: KZ0918-075047 (19.3M
Gaussians, a 222 MB `.sog`) peaks at 3.5 GB, takes ~2.5 min and serves
269 MB. Its specs are `specs/process-splat.md` and `specs/splat-align.md`,
and `./test/run.sh` tests both.

**The LoD tree.** The app draws a capture through Spark's paged LoD: a tree
built offline, in one file per 64K-splat chunk, streamed chunk by chunk into a
fixed-size page pool, so it holds only what the view needs. `build-lod.sh` builds it from the cleaned file
with Spark's own `build-lod`, at the version the app pins (v2.3.1), in a Rust
container, so it needs only Docker, plus the `node` that `process-splat.sh`
already needs (to read the header it wrote):

```bash
./scripts/build-lod.sh KZ0918-075047                            # source/KZ0918-075047.spz → lod/KZ0918-075047-lod.rad + -lod-<n>.radc
```

The first run compiles the tool (about a minute, cached in a Docker volume).
A tree takes 2.5–4 minutes and up to 5 GB of Docker's memory for 13–19M
Gaussians, and is about 1.5× the `.spz` in all, in a few hundred chunk files.
Re-run it after re-cleaning a capture: it replaces the header and its chunks,
and removes chunks the new tree no longer has. Spec: `specs/build-lod.md`.

**Control points** (`SPLATS_PLACEMENT=control_points`). A capture placed
this way needs no georeference of its own. It is placed from **control points**: at least three features you can find both in
the capture and on a map — a building corner, a kerb corner, a post base —
each given in the capture's own coordinates (as stored, below) and in
latitude/longitude. The loader fits a rotation, a scale and a shift from
them. One row per point:

```
SplatID,File,Point,X,Y,Z,LAT,LON,ALT,H,Note
KY0917A,KY0917A.spz,1,12.40,-3.85,0.02,25.034512,121.560841,,,NE corner of the low wall
```

| column | what to enter |
| --- | --- |
| `SplatID` | the capture's id; every row of one capture shares it |
| `File` | the file name in `data/3dgs/source/`, the same on every row of the capture |
| `Point` | a label for the point, unique within the capture (`1`, `2`, `3`, …) |
| `X`, `Y`, `Z` | the point in the capture's own coordinates **as stored** (metres): z-up, the ground is X/Y — the frame of its scan's `poses.csv` |
| `LAT`, `LON` | the same point in WGS84 decimal degrees |
| `ALT` | the altitude of the capture file's origin, the same on every row (a scan's PLY `offsetz`, written by `control-points.mjs`); blank when unknown. Recorded, not used to place the capture |
| `H` | the point's height above the ground in metres; blank for a point on the ground |
| `Note` | what the point is, for whoever checks it later; quote it if it has a comma |

**From the scan's georeference.** A scan folder that carries the scanner's
`gnss.csv` and a georeferenced `point_cloud.ply` needs no measuring:

```bash
node scripts/control-points.mjs                  # every scan in original/
node scripts/control-points.mjs KZ0918-075047
```

The PLY's header names a UTM zone and an offset (`comment epsg 32651`,
`comment offsetx/y/z`): the file stores a point at UTM (E, N, h) as
(E − offsetx, N − offsety, h − offsetz). For each scan the script takes the
RTK-fixed fixes (status 4), puts each into the file's coordinates through
that, picks the farthest-apart pair and the fix farthest from their line, and
writes those three with their latitude/longitude. Their `H` is the antenna's
height above the capture's ground (1.36–1.73 m on the delivered scans),
measured on the Gaussians under 50 fixes, so the loader sets the capture's
ground on the map's instead of the antenna. The loader then
solves where the scan sits and which way it faces (for KZ0918: heading
≈ 359.38°, the grid's turn from true north, scale ≈ 1.0001, UTM's point
scale; RMS a few millimetres, since the loader fits on the same ellipsoid). It replaces only those scans' rows and keeps
the rest of the file as it is. `poses.csv` is not read: it is in a frame of
its own. The vertices are read only for that height, never to check the header, so a
header that does not describe its file fits just as well and lands wrong; check a new capture by
eye. A capture without a georeference (`.sog`, `.spz`) is refused. Spec:
`specs/control-points.md`.

**Measuring by hand.** Choose points **spread across the capture and not in a
line**, on features that are sharp in both. A fourth or fifth point makes the
fit sturdier.

Read each point in the capture's own coordinates as stored —
z-up, the same frame as its scan's `poses.csv` — and the loader fits on them
as they are. A viewer that turns or tilts the file on open (the PlayCanvas /
SuperSplat family turns it 180° about up and shows it y-up) has to have that
undone first.

Points read mirrored, or tilted (y-up, ground on X/Z), cannot be fitted, and
the load rejects them. A reading **turned 180° about
up** cannot be caught: it fits just as well, and the capture lands turned
around its control points. If a capture renders backwards, that is the cause.
Check it by eye after every new capture or viewer.

**When the load fails.** The splat load fails — the trees still load — and
names the capture and the rule when:

- the header is not exactly the one above (so swapped `LAT`/`LON` columns are
  rejected rather than loaded);
- a row has a missing or non-numeric value, a `File` with a `/`, a `File`
  that is not a `.spz` (the only format `build-lod.sh` reads), or a file that
  is not in `data/3dgs/source/`;
- a capture's rows name different files, two captures share a file, or a
  `Point` label repeats;
- a capture has fewer than 3 points, two points closer than 2 m, or points
  spread less than 2 m across the line through them;
- the fit's RMS residual is over 1 m (a typo, two points swapped, or points
  read in the wrong frame), or its scale is outside 0.8–1.25 (the captures are metric, so that
  means wrong points).

## Attribution

The tree inventory is Taipei City open data and carries its own attribution
requirement, separate from OpenStreetMap's. The app disables MapLibre's own
attribution control, so the string must be rendered by the status bar — see
`app/src/layers/tree/specs/spec.md`.
