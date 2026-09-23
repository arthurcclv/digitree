#!/usr/bin/env bash
# The loader's test suite.
#
# Runs sql/01_schema.sql, sql/02_load.sql and sql/03_checks.sql — the real
# files, not copies — against the fixtures in test/fixtures/, in a scratch
# database. The loader takes its three inputs as psql variables for exactly
# this reason, so a test is a directory of CSVs rather than a second loader
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

expect_query "loads every valid row"                 "SELECT count(*) FROM trees" 9
expect_query "  3 street"                            "SELECT count(*) FROM trees WHERE kind='street'" 3
expect_query "  2 park"                              "SELECT count(*) FROM trees WHERE kind='park'" 2
expect_query "  4 custom, from two files"            "SELECT count(*) FROM trees WHERE kind='custom'" 4
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
expect_query "nulls a zero diameter" \
  "SELECT coalesce(diameter_cm::text,'null') FROM trees WHERE tree_id='BT0000000003'" "null"
expect_query "empty columns become NULL, not ''" \
  "SELECT count(*) FROM trees WHERE tree_id='CUSTOM-0002' AND species IS NULL AND height_m IS NULL AND diameter_cm IS NULL" 1

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
expect_query "truncates rather than duplicating" "SELECT count(*) FROM trees" 9

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

docker compose exec -T db psql -q -U taipei -d taipei -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" > /dev/null

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
