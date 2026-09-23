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

```
docker-compose.yml   postgis/postgis + ghcr.io/maplibre/martin
martin.yaml          which tables are published, and under what names
sql/01_schema.sql    the trees table and its indexes
sql/02_load.sql      staging COPY -> normalise -> clean -> insert
load.sh              the whole bring-up in one command
data/                raw open-data extracts (gitignored, not redistributed)
data/custom/         optional drop-in CSVs, loaded as kind = 'custom'
```

Commands (run from `infra/`): `./load.sh` does everything. `docker compose down`
stops it; `docker compose down -v` also discards the database volume, which is
the right way to start over.

## Rules

- **`sql/` is the source of truth for the data's shape**, the way a layer's
  `specs/spec.md` is for its behaviour. A column added to the table without the
  schema file changing is a bug.
- **Every SQL file is idempotent.** `01_schema.sql` drops and recreates the
  table; `02_load.sql` truncates and reloads all of it. Re-running `./load.sh`
  must always be safe, and must always leave the live schema identical to the
  file.
- **The loader takes its inputs as psql variables** (`street_csv`, `park_csv`,
  `custom_dir`), defaulting to the mounted paths, so the same SQL can be aimed
  at other files without being copied. A new input follows the same pattern.
- **A bad drop-in fails the load; it never half-loads it.** The whole load is
  one transaction, and a wrong header or a duplicate `TreeID` raises with the
  file named. Anything that would instead load a plausible-looking wrong value
  — a swapped LAT/LON, a shadowed city tree — must be made to fail instead.
- **Cleaning rules are documented where they are applied**, in the comment block
  above the insert in `02_load.sql`, with the specific values that motivated
  them. Open data is dirty in specific ways and a bare threshold teaches nobody
  why it is there.
- **Out-of-range values become `NULL`, never clamped.** A tree of unknown height
  must not render as a 40 m one.
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
row — the drop-in schema has no columns for them — which is what the app's spec
promises.

The published property names (`tree_id`, `kind`, `district`, `place`, `species`,
`height_m`, `diameter_cm`) are equally load-bearing: the app styles and filters
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
