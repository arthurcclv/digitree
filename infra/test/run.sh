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
# The fixtures in test/fixtures/splats/ were generated from known placements:
# each control point's LAT/LON is where a capture with that origin, heading and
# scale puts its file x/y, on the WGS 84 ellipsoid, as the loader projects
# (equirectangular at the points' centroid, with its radii N and M there). X/Y/Z are file coordinates, z-up, as the CSV takes them (the
# capture's own frame, as stored). The loader must recover the placement, and reject every
# file that would place a capture somewhere plausible and wrong. source/ and
# lod/ hold small stand-ins: the loader checks that a capture file and its
# <stem>-lod.rad exist, and never reads either.

SPL=$FIX/splats
load_splats() {
  docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d "$DB" \
    -v splats_csv="$SPL/$1" -v splats_dir="$SPL/source" -v splats_lod_dir="$SPL/lod" \
    -f /sql/04_splats.sql 2>&1
}

case_ "control points from known placements"
schema
out=$(load_splats ok.csv) || { echo "$out"; echo "splat load failed unexpectedly" >&2; exit 1; }
expect_query "loads both captures"              "SELECT count(*) FROM splats" 2
expect_query "ids follow splat_id"              "SELECT string_agg(id||'='||splat_id, ',' ORDER BY id) FROM splats" "1=FOUR,2=SYN"
expect_query "recovers the origin within 1 mm" \
  "SELECT ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(121.5608, 25.0345), 4326)::geography) < 0.001 FROM splats WHERE splat_id='SYN'" t
expect_query "recovers heading 30° within 0.01°" "SELECT abs(heading_deg - 30) < 0.01 FROM splats WHERE splat_id='SYN'" t
expect_query "recovers scale 1"                  "SELECT abs(scale - 1) < 1e-5 FROM splats WHERE splat_id='SYN'" t
expect_query "sets the ground through H − Z"     "SELECT abs(altitude_m - 2) < 1e-3 FROM splats WHERE splat_id='SYN'" t
expect_query "an exact fit has no residual"      "SELECT rms_m < 1e-3 FROM splats WHERE splat_id='SYN'" t
expect_query "takes four points"                 "SELECT points FROM splats WHERE splat_id='FOUR'" 4
expect_query "  heading 200°, past 180"          "SELECT abs(heading_deg - 200) < 0.01 FROM splats WHERE splat_id='FOUR'" t
expect_query "  scale 1.05"                      "SELECT abs(scale - 1.05) < 1e-5 FROM splats WHERE splat_id='FOUR'" t
# FOUR's H is blank on every row, so each point is on the ground: the offset is
# −scale × mean(Z) = −1.05 × 0.425.
expect_query "  blank H is a point on the ground" "SELECT abs(altitude_m + 1.05 * 0.425) < 1e-3 FROM splats WHERE splat_id='FOUR'" t
expect_query "  trims stray spaces"              "SELECT file FROM splats WHERE splat_id='FOUR'" four.spz
expect_query "records the file's size"           "SELECT bytes FROM splats WHERE splat_id='SYN'" 36
expect_contains "reports each point's residual" "$out" "control point residuals"

case_ "re-running the splat loader"
out=$(load_splats ok.csv) || { echo "$out"; echo "second splat load failed" >&2; exit 1; }
expect_query "reloads, not appends, with the same ids" "SELECT string_agg(id||'='||splat_id, ',' ORDER BY id) FROM splats" "1=FOUR,2=SYN"

# SYN's points turned 180° about up. A rotation is exactly what the fit solves
# for, so it fits perfectly and lands the capture turned around: this case
# documents that no check can catch a reading in a turned frame, and why the
# CSV's frame has to be right by construction.
case_ "points turned 180° about up"
out=$(load_splats old-frame.csv) || { echo "$out"; echo "splat load failed unexpectedly" >&2; exit 1; }
expect_query "fits, with no residual to flag it" "SELECT rms_m < 1e-3 FROM splats WHERE splat_id='OLD'" t
expect_query "  but lands turned 180° (210°, not 30°)" "SELECT abs(heading_deg - 210) < 0.01 FROM splats WHERE splat_id='OLD'" t

case_ "no control points at all"
out=$(load_splats nothing-here.csv) || { echo "$out"; echo "splat load failed unexpectedly" >&2; exit 1; }
expect_contains "says so"        "$out" "no captures loaded"
expect_query   "loads nothing"   "SELECT count(*) FROM splats" 0

# Each must fail, name the capture or the line and the rule, and leave the
# table as the previous load left it: the load is one transaction.
splat_rejects() {
  local label=$1 file=$2 needle=$3
  load_splats ok.csv > /dev/null
  if out=$(load_splats "$file"); then bad "$label" "the load succeeded"; return; fi
  expect_contains "$label" "$out" "$needle"
  expect_query "  keeps the previous load" "SELECT count(*) FROM splats" 2
}

case_ "rejected control points"
splat_rejects "a misspelt header"               bad-header.csv     "could not be loaded"
splat_rejects "LAT and LON the other way round" swapped.csv        "could not be loaded"
splat_rejects "two points"                      two-points.csv     "TWO: 2 control point(s); at least 3 are needed"
splat_rejects "points in a line"                collinear.csv      "LINE: the points are too close to a line"
splat_rejects "two points 0.7 m apart"          coincident.csv     "NEAR: Points 1 and 2 are 0.707 m apart"
splat_rejects "a mirrored capture"              mirrored.csv       "MIRROR: the control points fit with an RMS of"
# Generated with a scale of 1.5 on the map's sphere, before the loader fitted
# on the ellipsoid; kept as it was, since it only has to stay out of range.
splat_rejects "a scale of 1.5"                  scaled.csv         "SCALED: the fit's scale is 1.4961"
splat_rejects "rows naming different files"     file-differs.csv   "SPLIT: its rows name 2 files"
splat_rejects "a file that is not there"        missing-file.csv   "File 'absent.spz' is not in"
splat_rejects "a directory, not a file"         directory.csv      "File 'folder.spz' is not in"
splat_rejects "a path in File"                  path.csv           "must be a bare file name"
splat_rejects "an unsupported extension"        extension.csv      "File 'syn.txt' is not .spz"
# A format Spark could parse, but build-lod.sh reads only <scan>.spz, so its
# LoD could never be built: refused as the format, not as a missing LoD.
splat_rejects "a .ply capture"                  ply.csv            "File 'syn.ply' is not .spz"
splat_rejects "an upper-case .SPZ"              upper-ext.csv      "File 'syn.SPZ' is not .spz"
splat_rejects "a Point given twice"             dup-point.csv      "DUP: Point 1 appears 2 times (lines 2, 3)"
splat_rejects "one file, two captures"          shared-file.csv    "shared.spz is used by 2 captures"
splat_rejects "a coordinate that is not a number" not-a-number.csv "line 2 (NAN): X 'N/A' is not a number"
splat_rejects "a capture with no LoD built"      missing-lod.csv    "NOLOD: its LoD nolod-lod.rad is not in /test/fixtures/splats/lod (run ./scripts/build-lod.sh nolod)"
# The same kind of points read y-up, as a viewer shows them (X = −x, Y = z,
# Z = y): turned a quarter-turn on their side, they cannot be fitted by a
# rotation of the ground.
splat_rejects "points read y-up, not in the file's own frame" unconverted.csv "UNCONV: the control points fit with an RMS of"

# control-points.mjs's output, through the real loader. T1's header is
# KZ0918-075047's and its fixes are 30–50 m apart in UTM 51N, so the loader
# must put the file's origin on T1's first fix, facing grid north: 360° less
# the grid convergence there, γ = atan(tan(λ − 123°)·sin φ) = −0.6177°, at a
# scale of 1/k, where k = 0.999868 is UTM's point scale there: a file unit is
# a grid metre, 1/k true metres. The loader fits on the same ellipsoid as UTM,
# so only the projections' curvature is left over: millimetres
# (specs/control-points.md).
# The CSV and a stand-in T1.spz go into the container's /tmp: /test is
# read-only, and the loader only checks that the file exists.
case_ "control points generated from a scan's georeference"
cp_work=$(mktemp -d)
SPLATS_ORIGINAL_DIR=test/fixtures/control-points SPLATS_CONTROL_POINTS=$cp_work/cp.csv \
  node scripts/control-points.mjs T1 > /dev/null
docker compose exec -T db sh -c 'mkdir -p /tmp/cp-source /tmp/cp-lod && echo stand-in > /tmp/cp-source/T1.spz &&
  echo stand-in > /tmp/cp-lod/T1-lod.rad && cat > /tmp/cp.csv' < "$cp_work/cp.csv"
rm -rf "$cp_work"
out=$(docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U taipei -d "$DB" \
  -v splats_csv=/tmp/cp.csv -v splats_dir=/tmp/cp-source -v splats_lod_dir=/tmp/cp-lod -f /sql/04_splats.sql 2>&1) \
  || { echo "$out"; echo "splat load of generated points failed" >&2; exit 1; }
expect_query "loads the scan"                    "SELECT splat_id||' '||points FROM splats" "T1 3"
expect_query "puts the origin on the first fix, within 5 mm" \
  "SELECT ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(121.540875478, 25.039362564), 4326)::geography) < 0.005 FROM splats" t
expect_query "faces grid north (359.3823°) within 0.01°" "SELECT abs(heading_deg - 359.3823) < 0.01 FROM splats" t
expect_query "  at scale 1/k (1.000132) within 1e-4" "SELECT abs(scale - 1.000132) < 1e-4 FROM splats" t
expect_query "  with RMS under 5 mm"             "SELECT rms_m < 0.005 FROM splats" t

docker compose exec -T db psql -q -U taipei -d taipei -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" > /dev/null

printf '\n%s passed, %s failed\n' "$pass" "$fail"

# --- the splat processor (process-splat.sh) -----------------------------------
#
# Its own suite, with its own count: it needs splat-transform rather than the
# database, and runs on its own as ./test/process-splat.sh.
printf '\n== process-splat.sh ==\n'
processor_ok=1
./test/process-splat.sh || processor_ok=0

# --- the align step (splat-align.mjs) -----------------------------------------
printf '\n== splat-align.mjs ==\n'
align_ok=1
./test/splat-align.sh || align_ok=0

# --- the control-point generator (control-points.mjs) ------------------------
printf '\n== control-points.mjs ==\n'
generator_ok=1
./test/control-points.sh || generator_ok=0

# --- the LoD builder (build-lod.sh) -------------------------------------------
printf '\n== build-lod.sh ==\n'
lod_ok=1
./test/build-lod.sh || lod_ok=0

[ "$fail" -eq 0 ] && [ "$processor_ok" = 1 ] && [ "$align_ok" = 1 ] && [ "$generator_ok" = 1 ] && [ "$lod_ok" = 1 ]
