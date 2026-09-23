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

## Tests

```bash
./test/run.sh
```

Runs `sql/01_schema.sql`, `sql/02_load.sql` and `sql/03_checks.sql` — the real
files — against the fixture CSVs in `test/fixtures/`, in a scratch database. It
covers the transform, the cleaning rules, the drop-in contract and the three
ways a drop-in is rejected, in a second or two and without touching `data/` or
the development database.

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

The header must be exactly, in this order:

```
TreeID,TreeType,Diameter,TreeHeight,LAT,LON
```

| column | maps to | notes |
| --- | --- | --- |
| `TreeID` | `tree_id` | must be unique across *every* file, including the two extracts |
| `TreeType` | `species` | may be empty |
| `Diameter` | `diameter_cm` | cm; cleaned like the extracts |
| `TreeHeight` | `height_m` | m; cleaned like the extracts |
| `LAT`, `LON` | `geom` | **WGS84 degrees** — stored as-is, no transform |

`district`, `place`, `place_note` and `survey_date` are `NULL` for these rows:
the schema carries no columns for them.

Three failure modes, all deliberate:

- **A wrong header fails the load**, loudly, naming the file. `COPY … HEADER
  MATCH` compares the header against the expected columns, so a file with
  `LON,LAT` reversed — or with the extracts' own column set — is rejected
  instead of loading longitude into `lat`.
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
in `sql/02_load.sql`. In short: height is kept only within (0, 40] m — the
street file's maximum is **2023.0**, a survey year keyed into the height column
— and diameter only within (0, 400] cm. Out-of-range values become `NULL`
rather than being clamped, so a tree of unknown height is never rendered as a
40 m one. The same two rules apply to custom rows: they are properties of what
the app can render, not of who supplied the file.

## Attribution

The tree inventory is Taipei City open data and carries its own attribution
requirement, separate from OpenStreetMap's. The app disables MapLibre's own
attribution control, so the string must be rendered by the status bar — see
`app/src/layers/tree/specs/spec.md`.
