# infra — local data stack

Postgres + PostGIS behind a [Martin](https://github.com/maplibre/martin) tile
server, serving Taipei's tree inventory to `app/` as vector tiles.

```bash
cd infra
./load.sh                    # bring up, create schema, load, start Martin
```

Then:

```bash
curl -s localhost:3000/catalog | jq        # the published sources
curl -s localhost:3000/trees | jq          # TileJSON
```

`docker compose down` stops it. `docker compose down -v` also drops the database
volume — the right way to start over.

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

### What gets cleaned, and why

Heights and diameters are usable but carry obvious data-entry damage. The full
rules, with the values that motivated them, are in the comment above the insert
in `sql/02_load.sql`. In short: height is kept only within (0, 40] m — the
street file's maximum is **2023.0**, a survey year keyed into the height column
— and diameter only within (0, 400] cm. Out-of-range values become `NULL`
rather than being clamped, so a tree of unknown height is never rendered as a
40 m one.

## Attribution

The tree inventory is Taipei City open data and carries its own attribution
requirement, separate from OpenStreetMap's. The app disables MapLibre's own
attribution control, so the string must be rendered by the status bar — see
`app/src/layers/tree/specs/spec.md`.
