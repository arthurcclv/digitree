# infra — local data stack

Postgres + PostGIS behind a [Martin](https://github.com/maplibre/martin) tile
server, serving Taipei's tree inventory to `app/` as vector tiles — plus the
Gaussian splat captures, tiles of a mosaic of every scan: where each tile sits
as vector tiles from Martin, and the tiles and their LoD trees from a static
`files` service.

```bash
cd infra
./load.sh                    # bring up, create schema, load, (re)start Martin and files
```

Then:

```bash
curl -s localhost:3000/catalog | jq        # the published sources
curl -s localhost:3000/trees | jq          # TileJSON
curl -sI localhost:3080/3dgs-lod/32651-352600-2770000-lod.rad   # a tile's LoD tree
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

It then runs each splat tool's own suite, each of which runs the real script on
scans or tiles it generates in a scratch directory, and runs on its own too:
`./test/process-splat.sh` (needs `splat-transform` and `node`),
`./test/splat-align.sh`, `./test/voxel-quality.sh` and
`./test/splat-mosaic.sh` (`node` only), and `./test/build-lod.sh` (Docker,
`node` and `splat-transform`). `run.sh` also loads a `georef.csv` the real
mosaic wrote through the real `04_splats.sql`.

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
is never written. From it, three explicit steps build what the app draws, each
owning its own folder:

| step | writes | spec |
| --- | --- | --- |
| `./scripts/process-splat.sh <scan>` | `data/3dgs/clean/<scan>.ply` (+ `.align.json`): one scan, aligned and cleaned | `specs/process-splat.md`, `specs/splat-align.md` |
| `node scripts/splat-mosaic.mjs` | `data/3dgs/tiles/<tile>.ply` (+ `mosaic.json`) and `data/3dgs/georef.csv`: every clean scan in one frame, in 100 m tiles, the best scan per 1 m voxel | `specs/splat-mosaic.md`, `specs/voxel-quality.md` |
| `./scripts/build-lod.sh --all` | `data/3dgs/lod/<tile>-lod.rad` + `<tile>-lod-<n>.radc`: each tile's paged LoD tree | `specs/build-lod.md` |

All of them are **gitignored**. None is required: with no `georef.csv` the
`splats` table is empty and the map shows no splats.

The splat tools live in `scripts/` and, like everything here, run from
`infra/`. To add a scan:

1. copy its scan folder into `data/3dgs/original/`;
2. clean it with `./scripts/process-splat.sh <scan>`;
3. rebuild the mosaic with `node scripts/splat-mosaic.mjs` (every tile, from
   every clean scan);
4. rebuild the trees with `./scripts/build-lod.sh --all`;
5. run `./load.sh`.

A tile without its `lod/<tile>-lod.rad` fails the splat load. `./load.sh`
ends by restarting both Martin and the files service: on Docker Desktop for
Mac a running `files` container can go on serving the tiles and trees from
before a rebuild, which the app then places by the new `ground_z`. If you
rebuild without reloading, `docker compose restart files`.

**Aligning and cleaning.** A capture straight from training sits a few
centimetres — sometimes more — from where the scanner's own RTK and lidar put
it, and carries Gaussians that only get in the way on the map: sparse strays
around and above the scene, oversized blobs, and floaters.
`process-splat.sh` corrects the first, drops the rest, and writes the result
as a lossless `.ply`:

```bash
./scripts/process-splat.sh KZ0918-075047                          # 2 m voxels, 1%, every axis <= 0.25 m
./scripts/process-splat.sh KZ0918-075047 --min-density 0.02 --max-scale 0.5
```

It reads the scan's one `point_cloud.<ext>` — `.ply`, `.compressed.ply`,
`.sog`, `.spz`, `.splat` or `.ksplat` — and writes `clean/<scan>.ply`, with
`clean/<scan>.align.json` beside it. A folder with none, or with more than one
(say a `.ply` and a `.sog` of the same scan), is refused: keep the one to use.
A `point_cloud.mjs` is never run — a generator is code, and the folder is
data. Only a georeferenced `point_cloud.ply` can go into the mosaic, which
refuses any other. Cleaning needs ~1 GB of free disk per 13M Gaussians for its
intermediate file, and about as much again for the output.

First it aligns (`scripts/splat-align.mjs`, a port of the XGRIDS handoff's
`align.py`), when the splat is a `point_cloud.ply` and the folder also has
`gnss.csv`, `poses.csv`, `octree.bin`, `metadata.json` and `map_config.json`:
it fits the trajectory to the RTK-fixed GNSS fixes (antenna lever arm from
`map_config.json`), carries the lidar into the PLY's frame with that fit,
matches it to the Gaussians by ICP, and moves every Gaussian by the rigid
correction found — within the PLY's own frame, so the header's offset still
places it. The `.align.json` records the outcome: `pass` (moved under 10 cm),
`corrected` (more), `fail` or `skipped`. A scan missing one of those files is
skipped, and one that fails validation (ICP matching under 40% of the lidar,
or the RTK fit's p95 over 10 cm) prints an error and is written unaligned —
the run still succeeds. Of the 22 scans delivered, 7 have no
`map_config.json`. The step takes ~20 s and 1.3–1.8 GB, under what the
density step needs.

The outlier rule follows the capture's own distribution, not a distance. It
counts the Gaussians in 2 m cubes (`--cell`), takes the count of the cube the
median Gaussian sits in as the capture's typical density, and drops every
cube holding less than 1% of that (`--min-density`). Then it drops the
Gaussians with any axis over `--max-scale` and runs splat-transform's floater
filter (`--floaters`, its defaults). So a long or L-shaped street is kept
whole, and a sky floater above a dense street goes. It always reads
`original/`, so re-running with other settings never compounds the cuts.

With the defaults the KY0917 captures lost 3.7–5.3%. It needs
`splat-transform` 3.10.x installed globally with npm (the density step uses its
library) and `node`. It holds a scan in memory: KZ0918-075047 (19.3M
Gaussians) peaks at 3.5 GB and takes ~2.5 min.

**The mosaic.** Where scans overlap, drawing each one whole draws every
surface once per scan, one through the other. `splat-mosaic.mjs` instead
keeps, in each 1 m voxel, the splats of the one scan of best quality there:

```bash
node scripts/splat-mosaic.mjs
```

Every delivered scan is stored in its UTM zone less its header's offset, x
east and y north, so moving it into the zone is a translation by that offset.
Heights are kept as RTK's ellipsoidal heights, with no datum. The area is cut into 100 m × 100 m tiles on a grid fixed in
the zone, named by their south-west corner (`32651-352600-2770000`), and each
splat belongs to the 1 m voxel holding its centre. In each voxel every scan
with splats there is scored from its own splats alone — how many of the
voxel's 0.25 m sub-cells its opaque splats fill, times how sharp they are
(the inverse of their median largest axis) — and within 10% of the best, the
denser scan wins. That method is `scripts/voxel-quality.mjs`, a module of its
own behind a small seam, so it can be tuned or replaced
(`specs/voxel-quality.md`).

Because the map has no terrain, each tile also records **its own ground**:
the lowest 0.1 m layer of its splats' heights holding at least a fifth as
many as the densest layer, which is the ground in all but a tile whose
ground is hidden; sparser layers below it, reflections in puddles and
glass, are passed over.

It writes each tile as `tiles/<tile>.ply`, in its own frame (its centre the
origin, z the ellipsoidal height, the header carrying its georeference as
the delivered scans' do, with `offsetz` 0), `tiles/mosaic.json` (which scan
won how many voxels of each tile, each tile's ground, and the step between
every two neighbouring tiles' grounds, the largest also printed), and
`georef.csv`, one row per tile:

```
SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ,GROUNDZ
32651-352600-2770000,32651-352600-2770000.ply,32651,352650,2770050,0,24.987
```

It always rebuilds every tile from every `clean/<scan>.ply`, replacing the
previous mosaic only when the whole run succeeds; a tile that no longer has
splats is removed. A tile left with fewer than 10,000 splats is dropped,
listed in `mosaic.json`'s `dropped_tiles`: it is a scan's stray fringe,
floaters and sky, with no ground to stand on. It refuses scans in different UTM zones, a clean scan
without its original's georeferenced `point_cloud.ply`, and spherical
harmonics beyond degree 0. While it runs it needs about the clean scans' size
again in free disk, for its per-tile buckets.

**The LoD trees.** The app draws each tile through Spark's paged LoD: a tree
built offline, in one file per 64K-splat chunk, streamed chunk by chunk into a
fixed-size page pool, so it holds only what the view needs. `build-lod.sh`
builds it from the tile's `.ply` with Spark's own `build-lod`, at the version
the app pins (v2.3.1), in a Rust container, so it needs only Docker, plus
`node` (to read the header it wrote):

```bash
./scripts/build-lod.sh --all                   # every tile, then lod/ pruned to them
./scripts/build-lod.sh 32651-352600-2770000    # tiles/<tile>.ply → lod/<tile>-lod.rad + -lod-<n>.radc
```

The first run compiles the tool (about a minute, cached in a Docker volume).
A tree is about 1.5× its tile's splats, in chunk files of 64K. Re-run it
after rebuilding the mosaic: it replaces each header and its chunks, removes
chunks a new tree no longer has, and with `--all` removes the trees of tiles
that are gone.

**Placement.** The loader places each tile from its row of `georef.csv`:
origin `(OFFSETX, OFFSETY)` in the row's UTM zone, the tile's centre; facing
grid north (≈ 359.38° here); at UTM's point scale (≈ 1.0001). Its ground,
`ground_z` = `GROUNDZ − OFFSETZ` as a local z, is drawn on the map's ground,
so each tile sits on the map by its own ground, with no regard to its
neighbours: where two neighbours' grounds differ, a surface crossing their
edge shows that step. The load prints each capture's `OFFSETZ`, `GROUNDZ`
and `ground_z`.

**When the load fails.** The splat load fails — the trees still load — and
names the line or the capture and the rule, on a header other than the one
above, an empty `SplatID` or `File`, a `File` that is a path, not `.ply`
(the only format `build-lod.sh` reads), or not in `tiles/`, an `EPSG` outside
WGS 84 / UTM, an offset that is not a number, a `SplatID` or `File` on two
rows, or a tile without its LoD.

## Attribution

The tree inventory is Taipei City open data and carries its own attribution
requirement, separate from OpenStreetMap's. The app disables MapLibre's own
attribution control, so the string must be rendered by the status bar — see
`app/src/layers/tree/specs/spec.md`.
