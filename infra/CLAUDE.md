# CLAUDE.md — `infra/`

Guidance for the local data stack. The repo-wide rules live in the root
`CLAUDE.md`; this file covers what is specific to `infra/`.

## What this is

Postgres + PostGIS with a Martin tile server in front of it, run locally with
Docker Compose. It serves the Taipei tree inventory — plus any custom trees
dropped into `data/custom/` — to `app/` as Mapbox Vector Tiles. It is a
**development fixture**: credentials are trivial, ports bind to `127.0.0.1`,
and there is no deployment story. Do not add one without a decision
entry.

`infra/` has no `DECISIONS.md` of its own. Its decisions — the drop-in schema,
the cleaning rules, the published property names — are recorded in
`app/ai/DECISIONS.md`, beside the app decisions that depend on them, and a
change here that needs one appends it there.

```
docker-compose.yml   postgis/postgis + ghcr.io/maplibre/martin
martin.yaml          which tables are published, and under what names
sql/01_schema.sql    the trees table and its indexes
sql/02_load.sql      staging COPY -> normalise -> clean -> insert
sql/03_checks.sql    assertions over the loaded table; fails the load
load.sh              the whole bring-up in one command
test/                fixture CSVs and run.sh, the loader's test suite
data/                raw open-data extracts (gitignored, not redistributed)
data/custom/         optional drop-in CSVs, loaded as kind = 'custom'
```

Commands (run from `infra/`): `./load.sh` does everything, `./test/run.sh` runs
the loader against fixtures in a scratch database. `docker compose down` stops
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
  `custom_dir`), defaulting to the mounted paths. That is what lets
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
  and the loader still never writes to it, in either direction.

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

One more constraint worth knowing before changing the schema: **the MVT feature
id must be an integer column**, which is why `trees.id` exists alongside the
text `tree_id`. Pointing `id_column` at a text column does not fail at startup —
every tile request returns HTTP 500 with `mvt_agg_transfn: Could not find column
… of integer type`, while `/catalog` and the TileJSON still look perfectly
healthy.
