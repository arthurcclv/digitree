#!/usr/bin/env bash
# The loader's test suite.
#
# Runs sql/01_schema.sql, sql/02_load.sql, sql/03_checks.sql and
# sql/04_splats.sql — the real files, not copies — against the fixtures in
# test/fixtures/, in a scratch database. The loaders take their inputs as psql
# variables for exactly this reason, so a test is a directory of CSVs rather than a second loader
# that drifts from the first.
#
# The development database (`taipei`) is never touched, and neither is data/.
#
#   ./test/run.sh          # from infra/
set -euo pipefail
cd "$(dirname "$0")/.."

DB=trees_test
FIX=/test/fixtures
pass=0
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail + 1)); }
case_() { printf '\n%s\n' "$1"; }

# -A -t: one bare value per line, which is what the assertions compare against.
q() { docker compose exec -T db psql -At -U taipei -d "$DB" -c "$1" | tr -d '\r'; }

expect() {
  local label=$1 actual=$2 want=$3
  if [ "$actual" = "$want" ]; then ok "$label"; else bad "$label" "want [$want], got [$actual]"; fi
}

expect_query() { expect "$1" "$(q "$2")" "$3"; }

expect_contains() {
  local label=$1 haystack=$2 needle=$3
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) bad "$label" "output does not mention [$needle]" ;;
  esac
}

schema() { docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d "$DB" -f /sql/01_schema.sql; }

# Returns non-zero when the load fails, with everything it printed on stdout —
# the failure cases assert on both.
load() {
  docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d "$DB" \
    -v street_csv="$FIX/extracts/street.csv" \
    -v park_csv="$FIX/extracts/park.csv" \
    -v custom_dir="$1" \
    -f /sql/02_load.sql 2>&1
}

checks() { docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d "$DB" -f /sql/03_checks.sql 2>&1; }

# --- bring the stack up, with the fixtures mounted --------------------------

echo "==> postgres"
docker compose up -d db > /dev/null
for _ in $(seq 60); do
  [ "$(docker compose ps db --format '{{.Health}}' 2>/dev/null || echo)" = "healthy" ] && break
  sleep 1
done
if ! docker compose exec -T db test -d /test; then
  echo "error: /test is not mounted in the db container." >&2
  echo "Run 'docker compose up -d db' to recreate it with the mount in docker-compose.yml." >&2
  exit 1
fi

echo "==> scratch database $DB"
docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d taipei \
  -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" > /dev/null

# --- the happy path ---------------------------------------------------------

case_ "a custom directory alongside the extracts"
schema
out=$(load "$FIX/custom-ok") || { echo "$out"; echo "load failed unexpectedly" >&2; exit 1; }

expect_query "loads every valid row"                 "SELECT count(*) FROM trees" 14
expect_query "  3 street"                            "SELECT count(*) FROM trees WHERE kind='street'" 3
expect_query "  2 park"                              "SELECT count(*) FROM trees WHERE kind='park'" 2
expect_query "  9 custom, from three files"          "SELECT count(*) FROM trees WHERE kind='custom'" 9
expect_contains "names each file as it loads it" "$out" "custom: a.csv — 4 rows"
# Squeezed, because the report is a psql table and its padding is not the point.
squeezed=$(printf '%s' "$out" | tr -s ' ')
expect_contains "counts the dropped rows per file" "$squeezed" "a.csv | 1 | 0"
expect_contains "  and for the second file"        "$squeezed" "b.csv | 1 | 0"
expect_query "ignores a non-CSV in the directory" \
  "SELECT count(*) FROM trees WHERE tree_id LIKE 'CUSTOM-900%'" 0

# The two coordinate paths. A custom point is stored exactly as given; an
# extract point is transformed out of TWD97 and must land in Taipei.
expect_query "stores custom LAT/LON untransformed" \
  "SELECT round(ST_X(geom)::numeric,4)||','||round(ST_Y(geom)::numeric,4) FROM trees WHERE tree_id='CUSTOM-0005'" \
  "135.7681,35.0116"
expect_query "custom data may sit outside Taipei" \
  "SELECT count(*) FROM trees WHERE kind='custom' AND ST_X(geom) > 130" 1
expect_query "transforms TWD97 into Taipei" \
  "SELECT count(*) FROM trees WHERE kind<>'custom' AND ST_X(geom) BETWEEN 121.4 AND 121.7 AND ST_Y(geom) BETWEEN 24.9 AND 25.3" 5

# Skipped rows: `geom` is NOT NULL, so an unusable coordinate drops the row.
expect_query "drops a row with an empty LAT"      "SELECT count(*) FROM trees WHERE tree_id='CUSTOM-0004'" 0
expect_query "drops a row with a non-numeric LAT" "SELECT count(*) FROM trees WHERE tree_id='CUSTOM-0006'" 0

# Cleaning applies to custom rows on the same terms as to the extracts.
expect_query "nulls a non-positive custom height" \
  "SELECT coalesce(height_m::text,'null')||'/'||coalesce(diameter_cm::text,'null') FROM trees WHERE tree_id='CUSTOM-0003'" \
  "null/120"
expect_query "keeps an ordinary custom height" \
  "SELECT height_m::text FROM trees WHERE tree_id='CUSTOM-0001'" "12.5"
# Height has no ceiling: both paths into the insert must keep a value that the
# old (0, 40] rule discarded, keying damage included.
expect_query "keeps a custom height above the old 40 m ceiling" \
  "SELECT height_m::text FROM trees WHERE tree_id='CUSTOM-0005'" "999"
expect_query "keeps the street file's 2023.0 height" \
  "SELECT coalesce(height_m::text,'null') FROM trees WHERE tree_id='BT0000000002'" "2023"
# Diameter is the mirror of height: no ceiling, but the floor stays, and the
# floor is the half that matters — a 0 is a blank field, not a thin tree.
expect_query "keeps a diameter above the old 400 cm ceiling" \
  "SELECT diameter_cm::text FROM trees WHERE tree_id='SL0000000002'" "2637"
expect_query "nulls a zero diameter" \
  "SELECT coalesce(diameter_cm::text,'null') FROM trees WHERE tree_id='BT0000000003'" "null"
expect_query "empty columns become NULL, not ''" \
  "SELECT count(*) FROM trees WHERE tree_id='CUSTOM-0002' AND species IS NULL AND height_m IS NULL AND diameter_cm IS NULL" 1

# Canopy width: the optional seventh column. a.csv and b.csv keep the six-column
# header, so the old format must still load; c.csv carries CanopyWidth, cleaned
# on the same terms as height and diameter.
expect_contains "loads the seven-column header" "$out" "custom: c.csv — 5 rows"
expect_query "keeps a positive canopy width" \
  "SELECT canopy_width_m::text FROM trees WHERE tree_id='CUSTOM-0007'" "8.5"
expect_query "nulls an empty, zero, negative or non-numeric canopy width" \
  "SELECT count(*) FROM trees WHERE tree_id IN ('CUSTOM-0008','CUSTOM-0009','CUSTOM-0010','CUSTOM-0011') AND canopy_width_m IS NULL" 4
expect_query "a six-column file loads with no canopy width" \
  "SELECT count(*) FROM trees WHERE tree_id IN ('CUSTOM-0001','CUSTOM-0005') AND canopy_width_m IS NULL" 2
expect_query "city rows never carry a canopy width" \
  "SELECT count(*) FROM trees WHERE kind<>'custom' AND canopy_width_m IS NOT NULL" 0
# The report's columns are trees | with_height | with_diameter |
# with_canopy_width | with_species: one custom row, CUSTOM-0007, keeps a width.
expect_contains "reports how many rows kept a width" "$squeezed" "custom | 9 | 7 | 8 | 1 | 8"

# The property the app's spec leans on: a NULL district means a custom row.
expect_query "custom rows carry no district/place/survey_date" \
  "SELECT count(*) FROM trees WHERE kind='custom' AND (district IS NOT NULL OR place IS NOT NULL OR survey_date IS NOT NULL)" 0
expect_query "city rows always carry a district" \
  "SELECT count(*) FROM trees WHERE kind<>'custom' AND district IS NULL" 0

expect_query "ids are a gapless 1..n over every source" \
  "SELECT (count(*) = max(id))::text FROM trees" "true"
expect_contains "the checks pass" "$(checks)" "checks passed"

case_ "re-running the loader without recreating the schema"
out=$(load "$FIX/custom-ok") || { echo "$out"; echo "second load failed" >&2; exit 1; }
expect_query "truncates rather than duplicating" "SELECT count(*) FROM trees" 14

# --- no custom data ---------------------------------------------------------

case_ "an empty custom directory"
schema
out=$(load "$FIX/custom-empty") || { echo "$out"; echo "load failed unexpectedly" >&2; exit 1; }
expect_query "loads the extracts only" "SELECT count(*) FROM trees" 5
expect_contains "says so" "$out" "no *.csv"

case_ "no custom directory at all"
schema
out=$(load "$FIX/nothing-here") || { echo "$out"; echo "load failed unexpectedly" >&2; exit 1; }
expect_query "loads the extracts only" "SELECT count(*) FROM trees" 5
expect_contains "says so" "$out" "is absent"

# --- the three ways a drop-in is rejected -----------------------------------
#
# Each must fail, name the file or the id, and leave the table empty: the whole
# load is one transaction, so a bad drop-in must not half-load the extracts.

case_ "a file with LAT and LON the other way round"
schema
if out=$(load "$FIX/custom-bad-header"); then bad "rejects the file" "the load succeeded"; else ok "rejects the file"; fi
expect_contains "names the file"        "$out" "swapped.csv"
expect_contains "quotes the mismatch"   "$out" "column name mismatch"
expect_contains "gives the real header" "$out" "TreeID,TreeType,Diameter,TreeHeight,LAT,LON"
expect_query   "loads nothing at all"   "SELECT count(*) FROM trees" 0

case_ "a seventh column that is not CanopyWidth"
schema
if out=$(load "$FIX/custom-bad-width-header"); then bad "rejects the file" "the load succeeded"; else ok "rejects the file"; fi
expect_contains "names the file"          "$out" "misspelt.csv"
expect_contains "says the header is too wide" "$out" "wrong number of fields"
expect_contains "gives both real headers" "$out" "TreeID,TreeType,Diameter,TreeHeight,CanopyWidth,LAT,LON"
expect_query   "loads nothing at all"     "SELECT count(*) FROM trees" 0

case_ "CanopyWidth spelt with the wrong case"
schema
if out=$(load "$FIX/custom-width-wrong-case"); then bad "rejects the file" "the load succeeded"; else ok "rejects the file"; fi
expect_contains "names the file"              "$out" "lowercase.csv"
expect_contains "says the header is too wide" "$out" "wrong number of fields"
expect_query   "loads nothing at all"         "SELECT count(*) FROM trees" 0

case_ "a header that is not UTF-8"
schema
if out=$(load "$FIX/custom-not-utf8"); then bad "rejects the file" "the load succeeded"; else ok "rejects the file"; fi
expect_contains "names the file"       "$out" "latin1.csv"
expect_query   "loads nothing at all"  "SELECT count(*) FROM trees" 0

case_ "CanopyWidth anywhere but after TreeHeight"
schema
if out=$(load "$FIX/custom-width-out-of-place"); then bad "rejects the file" "the load succeeded"; else ok "rejects the file"; fi
expect_contains "names the file"        "$out" "last.csv"
expect_contains "quotes the mismatch"   "$out" "column name mismatch"
expect_query   "loads nothing at all"   "SELECT count(*) FROM trees" 0

case_ "a drop-in reusing a TreeID from the extracts"
schema
if out=$(load "$FIX/custom-dup-extract"); then bad "rejects the file" "the load succeeded"; else ok "rejects the file"; fi
expect_contains "names the id"   "$out" "BT0000000001"
expect_contains "names the file" "$out" "dupe.csv"
expect_contains "says where the clash is" "$out" "already in the city extracts"
expect_query   "loads nothing at all" "SELECT count(*) FROM trees" 0

case_ "two drop-ins sharing a TreeID"
schema
if out=$(load "$FIX/custom-dup-custom"); then bad "rejects the files" "the load succeeded"; else ok "rejects the files"; fi
expect_contains "names the id"        "$out" "CUSTOM-0001"
expect_contains "names both files"    "$out" "one.csv, two.csv"
expect_contains "counts the copies"   "$out" "2 copies"
expect_query   "loads nothing at all" "SELECT count(*) FROM trees" 0

# --- the checks themselves --------------------------------------------------

case_ "sql/03_checks.sql catches a broken load"
schema
load "$FIX/custom-ok" > /dev/null
docker compose exec -T db psql -q -U taipei -d "$DB" -c "DELETE FROM trees WHERE kind='park'" > /dev/null
if out=$(checks); then bad "fails on a missing extract" "the checks passed"; else ok "fails on a missing extract"; fi
expect_contains "says which one" "$out" "no park trees loaded"

schema
load "$FIX/custom-ok" > /dev/null
docker compose exec -T db psql -q -U taipei -d "$DB" -c "UPDATE trees SET canopy_width_m = 5 WHERE tree_id='BT0000000001'" > /dev/null
if out=$(checks); then bad "fails on a city tree with a canopy width" "the checks passed"; else ok "fails on a city tree with a canopy width"; fi
expect_contains "says so" "$out" "city trees carry a canopy_width_m"

# --- the splat captures (sql/04_splats.sql) ---------------------------------
#
# The captures are the mosaic's tiles, each placed from its row of
# georef.csv. tiles/ and lod/ hold small stand-ins: the loader checks that a
# capture file and its <stem>-lod.rad exist, and never reads either.
#
# georef-ok.csv holds two georeferences: SYN's is KZ0918-075047's header (UTM
# 51N) and FOUR's is the Sydney Opera House in UTM 56S, its fields padded with
# spaces. The expected values were computed outside PostGIS, with
# scripts/utm.mjs's inverse and the ellipsoid's radii over the 100 m
# grid-north step: SYN's origin is 25.039362567, 121.540875478, heading
# 359.38231°, scale 1.0001324; FOUR's origin is −33.856784003, 151.215297000,
# heading 0.99450°, scale 1.0000640.
SPL=$FIX/splats
load_georef() {
  docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d "$DB" \
    -v splats_georef="$SPL/$1" -v splats_dir="$SPL/tiles" -v splats_lod_dir="$SPL/lod" "${@:2}" \
    -f /sql/04_splats.sql 2>&1
}

case_ "captures placed by their georeferences"
schema
out=$(load_georef georef-ok.csv) || { echo "$out"; echo "the splat load failed unexpectedly" >&2; exit 1; }
expect_contains "says how it places them"         "$out" "the mosaic's tiles, placed by georef.csv"
expect_query "loads both"                         "SELECT string_agg(id||'='||splat_id, ',' ORDER BY id) FROM splats" "1=FOUR,2=SYN"
expect_query "puts the origin at the offset, within 1 mm" \
  "SELECT ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(121.540875478, 25.039362567), 4326)::geography) < 0.001 FROM splats WHERE splat_id='SYN'" t
expect_query "  as exact lng/lat"                  "SELECT lng = ST_X(geom) AND lat = ST_Y(geom) AND pg_typeof(lng)::text = 'double precision' FROM splats WHERE splat_id='SYN'" t
expect_query "faces grid north (359.38231°) within 0.001°" "SELECT abs(heading_deg - 359.38231) < 0.001 FROM splats WHERE splat_id='SYN'" t
expect_query "  at scale 1/k (1.0001324) within 1e-5" "SELECT abs(scale - 1.0001324) < 1e-5 FROM splats WHERE splat_id='SYN'" t
# OFFSETZ 26.9006 over GROUNDZ 25.3: the ground is 1.6006 m below the origin.
expect_query "  its ground at GROUNDZ − OFFSETZ"  "SELECT ground_z FROM splats WHERE splat_id='SYN'" -1.6006
expect_query "  as a double"                      "SELECT pg_typeof(ground_z)::text FROM splats WHERE splat_id='SYN'" "double precision"
expect_query "  with no fit columns left"         "SELECT count(*) FROM information_schema.columns WHERE table_name = 'splats' AND column_name IN ('rms_m', 'points')" 0
expect_query "the southern hemisphere: the origin within 1 mm" \
  "SELECT ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(151.215297000, -33.856784003), 4326)::geography) < 0.001 FROM splats WHERE splat_id='FOUR'" t
expect_query "  heading 0.99450° within 0.001°"   "SELECT abs(heading_deg - 0.99450) < 0.001 FROM splats WHERE splat_id='FOUR'" t
expect_query "  scale 1.0000640 within 1e-5"      "SELECT abs(scale - 1.0000640) < 1e-5 FROM splats WHERE splat_id='FOUR'" t
expect_query "  trims stray spaces"               "SELECT file||' '||ground_z FROM splats WHERE splat_id='FOUR'" "four.ply 0"
expect_query "records the file's size"           "SELECT bytes FROM splats WHERE splat_id='SYN'" 36

case_ "re-running the splat loader"
out=$(load_georef georef-ok.csv) || { echo "$out"; echo "the second splat load failed" >&2; exit 1; }
expect_query "reloads, not appends, with the same ids" "SELECT string_agg(id||'='||splat_id, ',' ORDER BY id) FROM splats" "1=FOUR,2=SYN"

# Each capture grounded on its own: (OFFSETZ, GROUNDZ) (26.9, 25.3), a
# tile's (0, 24.98731) and (10, 10). Nothing is computed across captures, so
# each ground_z is its own row's alone, in double precision.
case_ "each capture's own ground"
out=$(load_georef georef-grounds.csv) || { echo "$out"; echo "the splat load failed unexpectedly" >&2; exit 1; }
expect_query "ground_z = GROUNDZ − OFFSETZ, each on its own" \
  "SELECT string_agg(splat_id||'='||round(ground_z::numeric, 6), ' ' ORDER BY splat_id) FROM splats" \
  "HIGH=-1.600000 LEVEL=0.000000 TILE=24.987310"
expect_query "  a tile's, exactly its GROUNDZ"    "SELECT ground_z = 24.98731 FROM splats WHERE splat_id='TILE'" t
expect_contains "  reports the grounds"           "$out" "splats: grounds"
# The report's rows, spaces squeezed: splat_id | offsetz | groundz | ground_z.
printed=$(printf '%s\n' "$out" | tr -d '\r' | tr -s ' ' | sed 's/^ //; s/ $//' | grep -E '^(HIGH|LEVEL|TILE)( \| [^|]*){3}$' | tr '\n' ';')
expect "  each capture's OFFSETZ, GROUNDZ and ground_z" "$printed" \
  "HIGH | 26.9 | 25.3 | -1.600;LEVEL | 10 | 10 | 0.000;TILE | 0 | 24.98731 | 24.987;"
expect "  and no datum groups"                    "$(printf '%s' "$out" | grep -c 'datum' || true)" 0

case_ "no georef.csv at all"
out=$(load_georef nothing-here.csv) || { echo "$out"; echo "the splat load failed unexpectedly" >&2; exit 1; }
expect_contains "says so"        "$out" "no captures loaded"
expect_query   "loads nothing"   "SELECT count(*) FROM splats" 0

georef_rejects() {
  local label=$1 file=$2 needle=$3
  load_georef georef-ok.csv > /dev/null
  if out=$(load_georef "$file"); then bad "$label" "the load succeeded"; return; fi
  expect_contains "$label" "$out" "$needle"
  expect_query "  keeps the previous load" "SELECT count(*) FROM splats" 2
}

case_ "rejected georeferences"
georef_rejects "OFFSETX and OFFSETY the other way round" georef-bad-header.csv "could not be loaded"
georef_rejects "an empty SplatID"            georef-empty-id.csv     "line 2: SplatID is empty"
georef_rejects "an offset that is not a number" georef-not-a-number.csv "line 2 (SYN): OFFSETX 'N/A' is not a number"
georef_rejects "a GROUNDZ that is not a number" georef-groundz-not-a-number.csv "line 2 (SYN): GROUNDZ 'ground' is not a number"
georef_rejects "the header without GROUNDZ"  georef-no-groundz.csv   "could not be loaded"
georef_rejects "a CRS that is not UTM"       georef-not-utm.csv      "line 2 (SYN): EPSG '3826' is not WGS 84 / UTM"
georef_rejects "a file that is not there"    georef-missing-file.csv "File 'absent.ply' is not in"
georef_rejects "a directory, not a file"     georef-directory.csv    "File 'folder.ply' is not in"
# .spz was the per-scan capture before the mosaic: build-lod.sh now reads
# <tile>.ply alone, so any other extension could never have its LoD.
georef_rejects "a .spz capture"              georef-spz.csv          "File 'syn.spz' is not .ply"
georef_rejects "an unsupported extension"    georef-extension.csv    "File 'syn.txt' is not .ply"
georef_rejects "an upper-case .PLY"          georef-upper-ext.csv    "File 'syn.PLY' is not .ply"
georef_rejects "a SplatID on two rows"       georef-dup.csv          "SYN appears on 2 rows (lines 2, 3)"
georef_rejects "an empty File"               georef-empty-file.csv   "line 2 (SYN): File is empty"
georef_rejects "a File that is a path"       georef-path.csv         "line 2 (SYN): File '../tiles/syn.ply' must be a bare file name"
georef_rejects "a File on two rows"          georef-shared-file.csv  "syn.ply is used by 2 captures (SYN, OTHER)"
georef_rejects "  with the row's shape as a hint" georef-shared-file.csv "HINT:  Each row is one capture: SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ,GROUNDZ"
georef_rejects "a capture with no LoD built" georef-no-lod.csv       "NOLOD: its LoD nolod-lod.rad is not in /test/fixtures/splats/lod (run ./scripts/build-lod.sh nolod)"

# splat-mosaic.mjs's output, through the real loader: two scans whose
# splats fall in two tiles, each placed at its centre, with its ground_z
# the GROUNDZ the mosaic wrote. The expected origins are scripts/utm.mjs's
# inverse of the tiles' centres.
case_ "the mosaic's georef.csv"
mz=$(mktemp -d)
mz_scan() {
  mkdir -p "$mz/original/$1" "$mz/clean"
  echo "{\"comments\": {\"epsg\": \"32651\", \"offsetx\": \"$2\", \"offsety\": \"$3\", \"offsetz\": \"$4\"}, \"splats\": []}" \
    | node test/splat-mosaic-scene.mjs -- "$mz/original/$1/point_cloud.ply"
  echo "{\"splats\": $5}" | node test/splat-mosaic-scene.mjs -- "$mz/clean/$1.ply"
}
mz_scan A 352650 2770050 27 '[{"x": 1, "y": 1, "z": 1}, {"x": 60, "y": 1, "z": 1}]'
mz_scan B 352660 2770040 26 '[{"x": 1, "y": 1, "z": 1}]'
SPLATS_ORIGINAL_DIR=$mz/original SPLATS_CLEAN_DIR=$mz/clean SPLATS_TILES_DIR=$mz/tiles SPLATS_GEOREF=$mz/georef.csv \
  SPLATS_MIN_TILE_SPLATS=1 node scripts/splat-mosaic.mjs > /dev/null
# Stand-ins for the tiles and their trees, named from the CSV's File column.
stand_ins=$(tail -n +2 "$mz/georef.csv" | cut -d, -f2 | while read -r f; do
  printf 'echo stand-in > /tmp/mz-tiles/%s && echo stand-in > /tmp/mz-lod/%s-lod.rad && ' "$f" "${f%.ply}"; done)
docker compose exec -T db sh -c "rm -rf /tmp/mz-tiles /tmp/mz-lod && mkdir -p /tmp/mz-tiles /tmp/mz-lod && ${stand_ins} cat > /tmp/mz.csv" < "$mz/georef.csv"
read -r lng0 lat0 lng1 lat1 < <(node --input-type=module -e '
  import { utmInverse } from "./scripts/utm.mjs";
  const a = utmInverse(352650, 2770050, 51, true), b = utmInverse(352750, 2770050, 51, true);
  console.log([a[1], a[0], b[1], b[0]].join(" ")); // utmInverse gives [lat, lon]')
grounds=$(tail -n +2 "$mz/georef.csv" | cut -d, -f7 | paste -sd, -)
rm -rf "$mz"
out=$(docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d "$DB" \
  -v splats_georef=/tmp/mz.csv -v splats_dir=/tmp/mz-tiles -v splats_lod_dir=/tmp/mz-lod -f /sql/04_splats.sql 2>&1) \
  || { echo "$out"; echo "the splat load of the mosaic's georef.csv failed" >&2; exit 1; }
expect_query "loads both tiles"                  "SELECT string_agg(splat_id||' '||file, ',' ORDER BY splat_id) FROM splats" \
  "32651-352600-2770000 32651-352600-2770000.ply,32651-352700-2770000 32651-352700-2770000.ply"
expect_query "  each at its centre, within 1 mm" \
  "SELECT bool_and(ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(CASE splat_id WHEN '32651-352600-2770000' THEN $lng0 ELSE $lng1 END, CASE splat_id WHEN '32651-352600-2770000' THEN $lat0 ELSE $lat1 END), 4326)::geography) < 0.001) FROM splats" t
# Every splat at z 1: A's over offsetz 27 (H 28), B's over 26 (H 27). Tile
# 352600 holds one of each, two bins of one, and the lower is its ground;
# tile 352700 holds A's other splat alone.
expect "  the mosaic's GROUNDZ"                    "$grounds" "27,28"
expect_query "  each with ground_z its GROUNDZ"  "SELECT string_agg(ground_z::text, ',' ORDER BY splat_id) FROM splats" "$grounds"
expect_query "  facing grid north"               "SELECT bool_and(abs(heading_deg - 359.38) < 0.01) FROM splats" t

docker compose exec -T db psql -q -U taipei -d taipei -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" > /dev/null

printf '\n%s passed, %s failed\n' "$pass" "$fail"

# --- the splat tools ------------------------------------------------------------
#
# Each has its own suite, with its own count, and runs on its own as
# ./test/<tool>.sh: they need splat-transform, node or Docker rather than the
# database.
suites_ok=1
for suite in process-splat splat-align voxel-quality splat-mosaic build-lod; do
  printf '\n== %s ==\n' "$suite"
  ./test/$suite.sh || suites_ok=0
done

[ "$fail" -eq 0 ] && [ "$suites_ok" = 1 ]
