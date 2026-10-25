# CLAUDE.md — `infra/`

Guidance for the local data stack. The repo-wide rules live in the root
`CLAUDE.md`; this file covers what is specific to `infra/`.

## What this is

Postgres + PostGIS with a Martin tile server in front of it, run locally with
Docker Compose. It serves the Taipei tree inventory — plus any custom trees
dropped into `data/custom/` — to `app/` as Mapbox Vector Tiles, and the
Gaussian splat captures in `data/3dgs/`: their placements as tiles from Martin,
the files from a static `files` service. It is a
**development fixture**: credentials are trivial, ports bind to `127.0.0.1`,
and there is no deployment story. Do not add one without a decision
entry. The one concession is `MARTIN_PORT`, which moves Martin's host port off
a taken `:3000` (DECISIONS 2026-10-12), and `FILES_PORT`, its twin for the
`files` service (default `:3080`).

`infra/` has no `DECISIONS.md` of its own. Its decisions — the drop-in schema,
the cleaning rules, the published property names — are recorded in
`app/ai/DECISIONS.md`, beside the app decisions that depend on them, and a
change here that needs one appends it there.

```
docker-compose.yml   postgis/postgis + ghcr.io/maplibre/martin + nginx (files)
martin.yaml          which tables are published, and under what names
files.conf           the files service: data/3dgs/source/ read-only at /3dgs/,
                     data/3dgs/lod/ at /3dgs-lod/
sql/01_schema.sql    the trees and splats tables and their indexes
sql/02_load.sql      staging COPY -> normalise -> clean -> insert
sql/03_checks.sql    assertions over the loaded table; fails the load
sql/04_splats.sql    control points -> validate -> fit -> splats
load.sh              the whole bring-up in one command
scripts/             the splat tools, each an explicit step load.sh never runs:
  process-splat.sh   original/<scan>/ -> align -> density, size and floater
                     cuts -> source/<scan>.spz + <scan>.align.json
  splat-align.mjs    process-splat.sh's align step: RTK + lidar -> one rigid
                     correction, in the PLY's own frame
  splat-density-cut.mjs
                     process-splat.sh's density cut, on splat-transform's library
  utm.mjs            WGS 84 <-> UTM, shared by control-points and splat-align
  control-points.mjs original/<scan>/gnss.csv + point_cloud.ply's header
                     (+ its Gaussians, for the antenna height H) -> the
                     scan's rows of control_points.csv
  build-lod.sh       source/<scan>.spz -> Spark's build-lod (v2.3.1, in
                     Docker) -> lod/<scan>-lod.rad + <scan>-lod-<n>.radc,
                     the chunked tree the app draws
specs/               specs for the scripts (process-splat.md, splat-align.md,
                     control-points.md, build-lod.md)
test/                fixture CSVs and run.sh, the loader's test suite;
                     process-splat.sh, the splat processor's; splat-align.sh
                     (+ splat-align-scene.mjs, its scan generator), the align
                     step's; control-points.sh (+ control-points-scene.mjs,
                     the Gaussians under its fixes), the control-point
                     generator's; build-lod.sh, the LoD builder's
data/                raw open-data extracts (gitignored, not redistributed)
data/custom/         optional drop-in CSVs, loaded as kind = 'custom'
data/3dgs/           splat captures and control_points.csv (gitignored):
                     original/<scan>/ as delivered, source/<scan>.spz as
                     aligned and cleaned (+ .align.json), lod/<scan>-lod.rad
                     and -lod-<n>.radc as drawn
```

Commands (run from `infra/`): `./load.sh` does everything, `./test/run.sh` runs
the loader against fixtures in a scratch database. The splat tools run from
here too — `./scripts/process-splat.sh <scan>`, `./scripts/build-lod.sh <scan>`,
`node scripts/control-points.mjs [<scan>…]`. The two `.sh` tools find
`data/` from their own location; `control-points.mjs` takes its default paths
relative to the working directory, so it must run from here. `docker compose down` stops
it; `docker compose down -v` also discards the database volume, which is the
right way to start over.

## Rules

- **`sql/` is the source of truth for the data's shape**, the way a layer's
  `specs/spec.md` is for its behaviour. A column added to the table without the
  schema file changing is a bug.
- **Every SQL file is idempotent.** `01_schema.sql` drops and recreates the
  table; `02_load.sql` truncates and reloads all of it. Re-running `./load.sh`
  must always be safe, and must always leave the live schema identical to the
  file.
- **The loader takes its inputs as psql variables** (`street_csv`, `park_csv`,
  `custom_dir`; `splats_csv`, `splats_dir`, `splats_lod_dir`,
  `splats_max_rms_m` for the splats), defaulting to the mounted paths. That is what lets
  `test/run.sh` exercise the real SQL against fixtures instead of a second
  loader that drifts from it. A new input follows the same pattern.
- **A bad drop-in fails the load; it never half-loads it.** The whole load is
  one transaction, and a wrong header or a duplicate `TreeID` raises with the
  file named. Anything that would instead load a plausible-looking wrong value
  — a swapped LAT/LON, a shadowed city tree — must be made to fail instead.
- **Test a loader change in `test/`.** New cleaning rules, new columns and new
  failure modes each get a fixture and an assertion; `./test/run.sh` must be
  green before a load change lands.
- **Cleaning rules are documented where they are applied**, in the comment block
  above the insert in `02_load.sql`, with the specific values that motivated
  them. Open data is dirty in specific ways and a bare threshold teaches nobody
  why it is there.
- **A value that fails a cleaning rule becomes `NULL`, never clamped or
  zeroed.** An unmeasured trunk must not render as a thin one. Note that no
  measurement has an upper bound any more: height, diameter and canopy width
  keep any positive value, keying damage included. The `> 0` floor is the rule that remains, and
  it is load-bearing — 9,319 rows record a diameter of exactly `0`.
- **Never modify `data/`.** The extracts are treated as read-only inputs; every
  correction belongs in `02_load.sql` so it is reproducible and reviewable. The
  one thing a contributor *adds* there is a drop-in CSV under `data/custom/` —
  and the loader still never writes to it, in either direction. The one
  exception is `data/3dgs/source/` — the `.spz` files and their
  `.align.json` — which `process-splat.sh` owns: it is derived
  from `data/3dgs/original/` (read-only, like the extracts) and can always be
  rebuilt from it. Nothing else writes `source/`, and a capture is never edited
  there by hand — change the script's settings and re-run it. The second
  exception is `data/3dgs/control_points.csv`: `control-points.mjs` rewrites
  the rows of the scans it is run on, and only those — every other row, hand
  measured, is kept byte for byte. Its spec is `specs/control-points.md`.
  The third is `data/3dgs/lod/`, which `build-lod.sh` owns: derived from
  `source/`, rebuilt by re-running it, never edited by hand. Its spec is
  `specs/build-lod.md`.
- **The align step works in the PLY's own frame and never converts it.**
  `splat-align.mjs` moves Gaussians by one rigid correction within UTM less
  the header's offset, so `control-points.mjs` and the loader need no change;
  the handoff's `align.py` converts to ENU, and that part was left out on
  purpose. Its sampling is seeded, so a re-run is byte-identical, but a
  correction near 0.10 m can read `pass` or `corrected` with the seed — it
  is applied either way. A scan missing a file it reads, or failing its
  validation, is served unaligned, not refused. Its spec is
  `specs/splat-align.md`.
- **The splat processor's traps live in `process-splat.sh` and
  `splat-density-cut.mjs`, with comments and tests**: `-V` compares `scale_*` in metres though the file
  stores log scale; a negative number passed to `node` without `--` is read as
  a node option; and splat-transform's `--stats`, `.csv` output and library
  report x and y negated relative to the coordinates `-V`/`-S` filter on (the
  density count does not care, but anything that turns a reported position
  into a filter argument must negate it). Its output is SPZ v3 because Spark
  2.3.1 recognises an SPZ only by gzip magic, and v4 is not gzipped. The
  density step uses splat-transform's library API, so the script refuses any
  version but 3.4.x. Its spec is `specs/process-splat.md`.

## The contract with `app/`

`app/` reaches this stack over HTTP only — it never imports from `infra/`, and
the app must still run, minus the tree layers, with nothing here running.

Two names in `martin.yaml` are a published interface, not an internal detail:

| name | where it is set | what depends on it |
| --- | --- | --- |
| source id `trees` | `postgres.tables.trees` key | the tile path `/trees/{z}/{x}/{y}` and the app's `source.url` |
| MVT layer `trees` | the same key | the app's `source.sourceLayer` |

Renaming either breaks `app/src/layers/tree/` silently — the map simply renders
nothing. Change them together, and update the layer spec in the same commit.

`kind` is part of that interface too, not just the names above it: the app
colours and filters on the literal values `street`, `park` and `custom`, so
adding a fourth means editing `TreeKindFilter` in `app/src/layers/tree/index.ts`
and `TreeKind` in `treeLayer.ts`, plus the spec, in the same commit. Note that
`district`, `place`, `place_note` and `survey_date` are NULL on every `custom`
row — the drop-in schema has no columns for them — which is what `03_checks.sql`
asserts and what the app's spec promises. The mirror image holds for
`canopy_width_m`: only the drop-ins have a column for it (the optional
`CanopyWidth`), so it is NULL on every `street` and `park` row, and
`03_checks.sql` asserts that too. The app scales a tree's crown by it, so the
custom header's order is part of the interface as well:
`TreeID,TreeType,Diameter,TreeHeight[,CanopyWidth],LAT,LON`.

The published property names (`tree_id`, `kind`, `district`, `place`, `species`,
`height_m`, `diameter_cm`, `canopy_width_m`) are equally load-bearing: the app styles and filters
on them by name, and `tree_id` additionally deduplicates the tile-buffer repeats
that `querySourceFeatures` returns. Note that `id_column` makes `id` the MVT
*feature* id, which is not a property — so `tree_id` has to be listed explicitly
or the 3D layer silently renders nothing.

The splat captures are a second published interface, read by
`app/src/layers/splat/` (its spec: `app/src/layers/splat/specs/spec.md`):

| name | where it is set | what depends on it |
| --- | --- | --- |
| source id `splats` | `postgres.tables.splats` key | the tile path `/splats/{z}/{x}/{y}` and the app's `SPLATS.tiles` |
| MVT layer `splats` | the same key | the app's `SPLATS.sourceLayer` |
| `/3dgs/<file>` | `files.conf` | the app's `SPLATS.files` (`/files/3dgs/`, through its `/files` proxy) |
| `/3dgs-lod/<stem>-lod.rad`, `<stem>-lod-<n>.radc` | `files.conf` | the app's `SPLATS.lodFiles` and `lodUrlOf`: what the layer draws, the header (by byte range) naming its chunk files beside it |

Its properties — `splat_id`, `file`, `bytes`, `altitude_m`, `heading_deg`,
`scale`, `lng`, `lat` — are read by name, as the tree properties are. The LoD file's name is
not a property: it is `file` less its extension, plus `-lod.rad`, a rule held
once on each side (`04_splats.sql` requires the file, the app's `lodUrlOf`
derives the URL), so a rename touches both. The point is where the
capture's local `(0, 0)` lands, but snapped to the tile's grid (~0.54 m at the
app's z14), so it only says which tiles hold the capture. The origin the app
draws from is `lng`/`lat`: the same point as doubles, generated from `geom`; `heading_deg` is its local +y, clockwise from
north. Rename any of these together with the app's schema and spec.

The placements are **solved, not typed**: `04_splats.sql` fits each capture
from its rows in `data/3dgs/control_points.csv`
(`SplatID,File,Point,X,Y,Z,LAT,LON,H,Note`, at least three points per capture).
X/Y/Z are **file coordinates as stored**: a capture's file and its control
points share one frame, z-up, the ground on x/y, and nothing converts between
them — not the loader (`file x = X`, …, in one place), not the app, which
draws the file as stored. `control-points.mjs` gets there through the PLY
header's georeference (UTM less `offsetx/y/z`), never through `poses.csv`,
which is in a frame of its own (the KZ0918 poses are turned 21.9° and 91.3°
from their files; `splat-align.mjs` reads them, but only to fit them to RTK,
and writes nothing in their frame). The header is trusted, not checked against the vertices:
it was verified on the KZ0918 scans by hand. (Where the align step runs, it
does check the vertices against RTK and the lidar, and moves them to the
header's frame; its `.align.json` says how far.) `control-points.mjs` does
read the vertices, but only to measure the antenna's height above the
capture's ground, which it writes as `H` so the loader sets that ground on
the map's; it never checks the georeference with them. No check can catch a reading turned about up: a
rotation is what the fit solves for, so the capture fits and lands turned.
`test/run.sh` keeps a case that shows it; a wrong frame is found only by eye. It fits them with a 2D similarity on a local projection of the WGS 84
ellipsoid, in true metres, because a capture is metric. (It used to fit on the
map's sphere, R = 6371008.8 m, to match how MapLibre draws, but no uniform
scale matches the map's uneven stretch of true metres, ~0.4% more north–south,
and that left 0.13–0.22 m RMS. The app now draws each axis with its own
map-metres-per-metre instead; see the splat spec's *The frame*.) It fails the splat load — never the
trees, which are committed before it runs — on a bad row or a bad fit: fewer
than 3 points, points under 2 m apart or under 2 m across their line, an RMS
residual over `splats_max_rms_m` (1 m), or a scale outside [0.8, 1.25]. A
loosened check is a spec change, like any other.

One more constraint worth knowing before changing the schema: **the MVT feature
id must be an integer column**, which is why `trees.id` exists alongside the
text `tree_id`. Pointing `id_column` at a text column does not fail at startup —
every tile request returns HTTP 500 with `mvt_agg_transfn: Could not find column
… of integer type`, while `/catalog` and the TileJSON still look perfectly
healthy.
