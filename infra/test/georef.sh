#!/usr/bin/env bash
# The georef.csv generator's test suite.
#
# Runs the real georef.mjs against scans in a scratch directory: the committed
# fixture test/fixtures/control-points/T1, and header-only scans written here.
# data/ is never touched. Needs only node; test/run.sh also loads T1's row
# through the real 04_splats.sql.
#
#   ./test/georef.sh   # from infra/; test/run.sh also runs it
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail + 1)); }
case_() { printf '\n%s\n' "$1"; }

expect() {
  local label=$1 actual=$2 want=$3
  if [ "$actual" = "$want" ]; then ok "$label"; else bad "$label" "want [$want], got [$actual]"; fi
}

expect_contains() {
  local label=$1 haystack=$2 needle=$3
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) bad "$label" "output does not mention [$needle]" ;;
  esac
}

command -v node > /dev/null || { echo "error: node is not on PATH" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export SPLATS_ORIGINAL_DIR=$work/original SPLATS_GEOREF=$work/georef.csv
mkdir -p "$SPLATS_ORIGINAL_DIR"
cp -R test/fixtures/control-points/T1 "$SPLATS_ORIGINAL_DIR/"
t1_files() { (cd "$SPLATS_ORIGINAL_DIR/T1" && find . -type f | sort | xargs shasum); }
t1_before=$(t1_files)

HEADER='SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ'
T1_ROW='T1,T1.spz,32651,352796.8287235790048726,2770099.7470906949602067,26.9006000000000007'
gen() { node scripts/georef.mjs "$@" 2>&1; }

# A header-only point_cloud.ply: <scan> <comment lines…>, e.g. 'epsg 32651'.
ply() {
  local name=$1; shift
  mkdir -p "$SPLATS_ORIGINAL_DIR/$name"
  {
    printf 'ply\nformat binary_little_endian 1.0\nelement vertex 0\n'
    for c in "$@"; do printf 'comment %s\n' "$c"; done
    printf 'property float x\nproperty float y\nproperty float z\nend_header\n'
  } > "$SPLATS_ORIGINAL_DIR/$name/point_cloud.ply"
}

# --- the happy path -----------------------------------------------------------
#
# T1's header is KZ0918-075047's, as the scanner's software wrote it: every
# offset carries more digits than a double keeps, so a value parsed and
# printed again would show.

case_ "a scan's row"
out=$(gen T1) || { echo "$out"; echo "generation failed unexpectedly" >&2; exit 1; }
expect "writes the header and one row"    "$(wc -l < "$SPLATS_GEOREF" | tr -d ' ')" 2
expect "keeps the header"                 "$(head -1 "$SPLATS_GEOREF")" "$HEADER"
expect "copies EPSG and the offsets as written" "$(sed -n 2p "$SPLATS_GEOREF")" "$T1_ROW"
expect_contains "reports the georeference" "$out" "T1: EPSG:32651, offset 352796.8287235790048726 2770099.7470906949602067 26.9006000000000007"

case_ "a scan without gnss.csv"
ply NOGNSS 'epsg 32756' 'offsetx 334900.2613' 'offsety 6252290.5224' 'offsetz 10'
out=$(gen NOGNSS) || bad "is still written" "$out"
expect "  is still written, in its own zone" "$(grep '^NOGNSS,' "$SPLATS_GEOREF")" "NOGNSS,NOGNSS.spz,32756,334900.2613,6252290.5224,10"

case_ "merging into an existing file"
printf '%s\nKY0917A,KY0917A.spz,32651,1,2,3\r\nT1,T1.spz,32651,0,0,0\n' "$HEADER" > "$SPLATS_GEOREF"
gen T1 > /dev/null
expect "keeps another capture's row byte for byte" "$(sed -n 2p "$SPLATS_GEOREF")" "$(printf 'KY0917A,KY0917A.spz,32651,1,2,3\r')"
expect "replaces the scan's old row"      "$(grep -c '^T1,' "$SPLATS_GEOREF")" 1
expect "  with the header's"              "$(grep '^T1,' "$SPLATS_GEOREF")" "$T1_ROW"
before=$(shasum "$SPLATS_GEOREF")
gen T1 > /dev/null
expect "a re-run gives the same file"     "$(shasum "$SPLATS_GEOREF")" "$before"

case_ "no scan given"
rm "$SPLATS_GEOREF"
mkdir -p "$SPLATS_ORIGINAL_DIR/not-a-scan"
out=$(gen) || { echo "$out"; echo "generation failed unexpectedly" >&2; exit 1; }
expect "takes every folder with a point_cloud.ply" "$(cut -d, -f1 "$SPLATS_GEOREF" | tr '\n' ' ')" "SplatID NOGNSS T1 "
rm -rf "$SPLATS_ORIGINAL_DIR/not-a-scan" "$SPLATS_ORIGINAL_DIR/NOGNSS"

# --- refusals: each names the problem and leaves the file untouched ----------

refuses() {
  local label=$1 needle=$2; shift 2
  local before
  before=$(shasum "$SPLATS_GEOREF")
  if out=$(gen "$@"); then bad "$label" "the run succeeded"; return; fi
  expect_contains "$label" "$out" "$needle"
  expect "  leaves the file untouched" "$(shasum "$SPLATS_GEOREF")" "$before"
  expect "  and no temporary file" "$(ls -A "$work" | grep -c tmp || true)" 0
}

case_ "refused scans"
gen T1 > /dev/null
ply NOEPSG 'offsetx 0' 'offsety 0' 'offsetz 0'
ply NOZ    'epsg 32651' 'offsetx 0' 'offsety 0'
ply TWD97  'epsg 3826' 'offsetx 0' 'offsety 0' 'offsetz 0'
ply SHIFT  'epsg 32651' 'offsetx 0' 'offsety 0' 'offsetz 0' 'shiftx 1'
ply SCALE  'epsg 32651' 'offsetx 0' 'offsety 0' 'offsetz 0' 'scalez 2'
ply EPSGDOT 'epsg 32651.0' 'offsetx 0' 'offsety 0' 'offsetz 0'
ply NANX   'epsg 32651' 'offsetx abc' 'offsety 0' 'offsetz 0'
ply SOG    'epsg 32651' 'offsetx 0' 'offsety 0' 'offsetz 0'
mv "$SPLATS_ORIGINAL_DIR/SOG/point_cloud.ply" "$SPLATS_ORIGINAL_DIR/SOG/point_cloud.sog"
ply TWO    'epsg 32651' 'offsetx 0' 'offsety 0' 'offsetz 0'
touch "$SPLATS_ORIGINAL_DIR/TWO/point_cloud.spz"
refuses "a header without epsg"       "NOEPSG: point_cloud.ply has no 'comment epsg'" NOEPSG
refuses "a header without offsetz"    "NOZ: point_cloud.ply has no 'comment offsetz'" NOZ
refuses "a CRS that is not UTM"       "TWD97: point_cloud.ply is in EPSG:3826"       TWD97
refuses "a shift"                     "SHIFT: point_cloud.ply has shiftx 1"          SHIFT
refuses "a scale"                     "SCALE: point_cloud.ply has scalez 2"          SCALE
refuses "a capture that is not a PLY" "SOG: point_cloud.sog carries no georeference" SOG
refuses "two captures"                "TWO: more than one capture"                   TWO
refuses "one bad scan among good ones" "NOZ: point_cloud.ply has no 'comment offsetz'" T1 NOZ
refuses "a path as the scan"          "must be a bare scan folder name"              ../T1
refuses "an epsg that is not a whole number" "EPSGDOT: point_cloud.ply has epsg 32651.0; it must be a whole number" EPSGDOT
refuses "an offset that is not a number" "NANX: point_cloud.ply comment offsetx: 'abc' is not a number" NANX
refuses "a scan given twice"          "'T1' is given twice"                          T1 T1
refuses "a missing scan"              "ABSENT: no point_cloud.ply in $SPLATS_ORIGINAL_DIR/ABSENT" ABSENT
printf 'SplatID,File,EPSG,OFFSETY,OFFSETX,OFFSETZ\n' > "$SPLATS_GEOREF"
refuses "a file with another header"  "does not start with the header"               T1

case_ "original/ is only read"
expect "T1's folder is as it was, after every run" "$(t1_files)" "$t1_before"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
