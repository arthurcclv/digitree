#!/usr/bin/env bash
# The control-point generator's test suite.
#
# Runs the real control-points.mjs against scans in a scratch directory: the
# committed fixture test/fixtures/control-points/T1, and broken scans written
# here. Their Gaussians come from test/control-points-scene.mjs. data/ is never touched. Needs only node; test/run.sh also loads T1's
# output through the real 04_splats.sql.
#
#   ./test/control-points.sh   # from infra/; test/run.sh also runs it
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
export SPLATS_ORIGINAL_DIR=$work/original SPLATS_CONTROL_POINTS=$work/control_points.csv
mkdir -p "$SPLATS_ORIGINAL_DIR"
cp -R test/fixtures/control-points/T1 "$SPLATS_ORIGINAL_DIR/"
# A scan's Gaussians: <scan> ['<options as JSON>'] (see the script).
scene() { node test/control-points-scene.mjs -- "$SPLATS_ORIGINAL_DIR/$1" "${2:-}"; }
scene T1

HEADER='SplatID,File,Point,X,Y,Z,LAT,LON,ALT,H,Note'
OLD_HEADER='SplatID,File,Point,X,Y,Z,LAT,LON,H,Note'
GNSS_HEAD='#timestamp,status,latitude,longitude,altitude,gnss_type,undulation,pdop,hdop,vdop,var_x2,var_y2,var_z2,satellite_num,satellite_utc'
gen() { node scripts/control-points.mjs "$@" 2>&1; }
row() { grep "^T1,T1.spz,$1," "$SPLATS_CONTROL_POINTS" | cut -d, -f"$2"; }

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

# A scan in UTM 51N at offset 0: its fixes given as "lat lon" pairs, all RTK
# fixed, one a second.
scan() {
  local name=$1 t=1; shift
  ply "$name" 'epsg 32651' 'offsetx 0' 'offsety 0' 'offsetz 0'
  printf '%s\n' "$GNSS_HEAD" > "$SPLATS_ORIGINAL_DIR/$name/gnss.csv"
  while [ $# -gt 0 ]; do
    printf '%s.02,4,%s,%s,26.9,WGS84,19,1,1,1,0,0,0,27,0\n' "$t" "$1" "$2" >> "$SPLATS_ORIGINAL_DIR/$name/gnss.csv"
    t=$((t + 1)); shift 2
  done
}

# --- the happy path -----------------------------------------------------------
#
# T1's header is KZ0918-075047's, as the scanner's software wrote it, and its
# fixes sit at file (x, y) 1 (0,0) 2 (40,0) 3 (40,30) 4 (10,5), all status 4;
# 5 (−20,−5) is status 2 and would be in the widest pair if it were used, and
# 6 is a status-0 fix with nan, as the receiver writes one. Eight more RTK
# fixes inside the triangle, 4 m apart, give the antenna height ten samples
# and more; they are never picked. Its ground is 1.6 m below every fix.

case_ "a scan's three points"
out=$(gen T1) || { echo "$out"; echo "generation failed unexpectedly" >&2; exit 1; }
expect "writes the header and three rows" "$(wc -l < "$SPLATS_CONTROL_POINTS" | tr -d ' ')" 4
expect "keeps the header"                 "$(head -1 "$SPLATS_CONTROL_POINTS")" "$HEADER"
# Fix 1 is KZ0918-075047's first fix, which the scanner's software made the
# file's origin: our UTM agrees with theirs to the millimetre.
expect "the fix at the header's offset is the file's origin" "$(row 1 4-6)" "0.000,0.000,0.000"
expect "1 and 2 are the widest pair, 3 the farthest off its line" \
  "$(cut -d, -f11 "$SPLATS_CONTROL_POINTS" | tail -3 | cut -d' ' -f2 | tr -d ';' | tr '\n' ' ')" "100.020000 102.020000 101.020000 "
# Fix (40, 30) at 27.6006 m: every axis distinct and non-zero, so a swap or
# a negation shows.
expect "X, Y, Z are the fix in the file's frame" "$(row 2 4-6)" "40.000,30.000,0.700"
expect "names the cleaned file"           "$(row 1 2)" "T1.spz"
expect "takes LAT/LON as written"         "$(row 2 7-8)" "25.039637300,121.541268665"
expect "ALT is the header's offsetz as written, on every point" \
  "$(cut -d, -f9 "$SPLATS_CONTROL_POINTS" | tail -3 | tr '\n' ' ')" "26.9006000000000007 26.9006000000000007 26.9006000000000007 "
expect "H is the antenna height, on every point" "$(cut -d, -f10 "$SPLATS_CONTROL_POINTS" | tail -3 | tr '\n' ' ')" "1.600 1.600 1.600 "
expect "notes the fix, the CRS and the samples" "$(row 3 11)" "gnss 101.020000; EPSG:32651; antenna over 12 of 12 samples"
expect_contains "reports the georeference" "$out" "EPSG:32651, offset 352796.828723579 2770099.747090695 26.9006"
expect_contains "reports the spread"      "$out" "1–2 50.00 m"
expect_contains "  and the RTK fixes"     "$out" "12 RTK fixes"
expect_contains "  and the antenna height" "$out" "T1: antenna 1.600 m above the ground, the median of 12 of 12 samples"
expect "skips a fix that is not RTK fixed" "$(grep -c 104.020000 "$SPLATS_CONTROL_POINTS" || true)" 0
expect "skips a nan fix without a solution" "$(grep -c 105.020000 "$SPLATS_CONTROL_POINTS" || true)" 0

case_ "the southern hemisphere"
# The Sydney Opera House in UTM 56S, its offset computed by a separate Python
# implementation (the one checked against the KZ0918 headers): the false
# northing must be added.
ply SOUTH 'epsg 32756' 'offsetx 334900.2613' 'offsety 6252290.5224' 'offsetz 10'
printf '%s\n1.02,4,-33.856784,151.215297,10,W,0,1,1,1,0,0,0,9,0\n2.02,4,-33.856284,151.215297,10,W,0,1,1,1,0,0,0,9,0\n3.02,4,-33.856784,151.215797,10,W,0,1,1,1,0,0,0,9,0\n' \
  "$GNSS_HEAD" > "$SPLATS_ORIGINAL_DIR/SOUTH/gnss.csv"
# Eight more inside its triangle, for the antenna height.
for i in 0 1 2 3 4 5 6 7; do
  printf '%s.02,4,-33.85670%s,151.2154%s,10,W,0,1,1,1,0,0,0,9,0\n' $((4 + i)) $((i % 2 * 4)) $((i * 4 + 10)) >> "$SPLATS_ORIGINAL_DIR/SOUTH/gnss.csv"
done
scene SOUTH
out=$(SPLATS_CONTROL_POINTS=$work/south.csv gen SOUTH) || bad "projects a 327xx zone" "$out"
expect "  the fix at the offset is the origin" "$(grep 'gnss 1.02;' "$work/south.csv" | cut -d, -f4-6)" "0.000,0.000,0.000"
rm -rf "$work/south.csv" "$SPLATS_ORIGINAL_DIR/SOUTH"

# --- the antenna height -------------------------------------------------------

# 50 RTK fixes in two rows 40 m apart, 3.3 m apart along them, the offset at
# the first: every fix is a sample.
scan50() {
  local name=$1 i pairs=()
  for i in $(seq 0 24); do
    pairs+=("25.03$(printf '%03d' $((i * 3)))" 121.5600 "25.03$(printf '%03d' $((i * 3)))" 121.5604)
  done
  scan "$name" "${pairs[@]}"
  scene "$name" "{\"recenter\":true${2:+,$2}}"
}
h_of() { SPLATS_CONTROL_POINTS=$work/$1.csv gen "$1" > /dev/null && cut -d, -f10 "$work/$1.csv" | tail -3 | sort -u | tr '\n' ' '; }

case_ "the antenna height"
scan50 FLAT
expect "a ground 1.600 m below every fix"  "$(h_of FLAT)" "1.600 "
expect "  noted over 50 of 50 samples"     "$(tail -1 "$work/FLAT.csv" | cut -d, -f11 | sed 's/.*; antenna/antenna/')" "antenna over 50 of 50 samples"
scan50 FLOAT '"floaters":true'
expect "  with floaters 2.0–2.9 m below"   "$(h_of FLOAT)" "1.600 "
scan50 ROOF '"roof":true'
expect "  with a car roof 0.8 m below a fifth of the samples" "$(h_of ROOF)" "1.600 "
scan50 CLEAR '"transparent":true'
expect "  with a denser transparent layer 1.2 m below" "$(h_of CLEAR)" "1.600 "
scan50 ALL '"floaters":true,"roof":true,"transparent":true'
expect "  with all three"                  "$(h_of ALL)" "1.600 "
first=$(shasum "$work/ALL.csv")
h_of ALL > /dev/null
expect "  and the same again on a re-run"  "$(shasum "$work/ALL.csv")" "$first"
scan50 DEEP '"depth":2.2'
expect "a ground 2.2 m below"              "$(h_of DEEP)" "2.200 "
rm -f "$work"/{FLAT,FLOAT,ROOF,CLEAR,ALL,DEEP}.csv
rm -rf "$SPLATS_ORIGINAL_DIR"/{FLAT,FLOAT,ROOF,CLEAR,ALL,DEEP}

case_ "merging into an existing file"
printf '%s\nKY0917A,KY0917A.spz,1,-1.247,-0.367,-4.934,25.038566,121.539141,,,"a note, quoted"\r\nT1,T1.spz,9,0,0,0,25,121,,,stale\n' "$HEADER" > "$SPLATS_CONTROL_POINTS"
gen T1 > /dev/null
expect "keeps another capture's row byte for byte" \
  "$(sed -n 2p "$SPLATS_CONTROL_POINTS")" "$(printf 'KY0917A,KY0917A.spz,1,-1.247,-0.367,-4.934,25.038566,121.539141,,,"a note, quoted"\r')"
expect "replaces the scan's old rows"     "$(grep -c '^T1,' "$SPLATS_CONTROL_POINTS")" 3
expect "  and drops the stale one"        "$(grep -c stale "$SPLATS_CONTROL_POINTS" || true)" 0
before=$(shasum "$SPLATS_CONTROL_POINTS")
gen T1 > /dev/null
expect "a re-run gives the same file"     "$(shasum "$SPLATS_CONTROL_POINTS")" "$before"

case_ "upgrading a file from before ALT"
printf '%s\nKY0917A,KY0917A.spz,1,-1.247,-0.367,-4.934,25.038566,121.539141,0.5,"a note, quoted"\r\nT1,T1.spz,9,0,0,0,25,121,,stale\n' "$OLD_HEADER" > "$SPLATS_CONTROL_POINTS"
out=$(gen T1) || bad "upgrades the file" "$out"
expect "takes the header with ALT"        "$(head -1 "$SPLATS_CONTROL_POINTS")" "$HEADER"
expect "gives a kept row an empty ALT after LON, its Note as it was" \
  "$(sed -n 2p "$SPLATS_CONTROL_POINTS")" "$(printf 'KY0917A,KY0917A.spz,1,-1.247,-0.367,-4.934,25.038566,121.539141,,0.5,"a note, quoted"\r')"
expect "  and replaces the scan's old rows" "$(grep -c '^T1,' "$SPLATS_CONTROL_POINTS")" 3
expect_contains "  and says so"          "$out" "upgrading"
before=$(shasum "$SPLATS_CONTROL_POINTS")
gen T1 > /dev/null
expect "a re-run gives the same file"     "$(shasum "$SPLATS_CONTROL_POINTS")" "$before"

case_ "no scan given"
rm "$SPLATS_CONTROL_POINTS"
mkdir -p "$SPLATS_ORIGINAL_DIR/not-a-scan" "$SPLATS_ORIGINAL_DIR/gnss-only"
printf '%s\n' "$GNSS_HEAD" > "$SPLATS_ORIGINAL_DIR/gnss-only/gnss.csv"
out=$(gen) || { echo "$out"; echo "generation failed unexpectedly" >&2; exit 1; }
expect "takes every folder with gnss.csv and point_cloud.ply" "$(cut -d, -f1 "$SPLATS_CONTROL_POINTS" | sort -u | tr '\n' ' ')" "SplatID T1 "
rm -rf "$SPLATS_ORIGINAL_DIR/not-a-scan" "$SPLATS_ORIGINAL_DIR/gnss-only"

# --- refusals: each names the problem and leaves the file untouched ----------

refuses() {
  local label=$1 needle=$2; shift 2
  local before
  before=$(shasum "$SPLATS_CONTROL_POINTS")
  if out=$(gen "$@"); then bad "$label" "the run succeeded"; return; fi
  expect_contains "$label" "$out" "$needle"
  expect "  leaves the file untouched" "$(shasum "$SPLATS_CONTROL_POINTS")" "$before"
  expect "  and no temporary file" "$(ls -A "$work" | grep -c tmp || true)" 0
}

# A scan with good fixes and the given header comments.
georef() { local name=$1; shift; scan "$name" 25.0300 121.5600  25.0303 121.5600  25.0300 121.5604; ply "$name" "$@"; }

case_ "refused scans"
gen T1 > /dev/null
scan LINE 25.0300 121.5600  25.0300 121.5601  25.0300 121.5602  25.0300 121.5603
# 100 m east, and the apex 2.2 m north of its middle: 2.2 m off the line 1–2,
# which the old check passed, but a spread across it of 1.80 m, which the
# loader refuses.
scan THIN 25.0300000 121.5600000  25.0300000 121.5609917  25.0300199 121.5604959
scan FEW  25.0300 121.5600  25.0303 121.5600
scan NOGNSS 25.0300 121.5600  25.0303 121.5600  25.0300 121.5604
rm "$SPLATS_ORIGINAL_DIR/NOGNSS/gnss.csv"
scan NOPLY 25.0300 121.5600  25.0303 121.5600  25.0300 121.5604
rm "$SPLATS_ORIGINAL_DIR/NOPLY/point_cloud.ply"
scan SOG 25.0300 121.5600  25.0303 121.5600  25.0300 121.5604
mv "$SPLATS_ORIGINAL_DIR/SOG/point_cloud.ply" "$SPLATS_ORIGINAL_DIR/SOG/point_cloud.sog"
scan TWO 25.0300 121.5600  25.0303 121.5600  25.0300 121.5604
touch "$SPLATS_ORIGINAL_DIR/TWO/point_cloud.spz"
scan NANRTK 25.0300 121.5600  25.0303 121.5600  25.0300 121.5604
sed -i.bak '3s/25.0303,121.5600/nan,nan/' "$SPLATS_ORIGINAL_DIR/NANRTK/gnss.csv" && rm "$SPLATS_ORIGINAL_DIR/NANRTK/gnss.csv.bak"
georef NOEPSG 'offsetx 0' 'offsety 0' 'offsetz 0'
georef NOZ    'epsg 32651' 'offsetx 0' 'offsety 0'
georef TWD97  'epsg 3826' 'offsetx 0' 'offsety 0' 'offsetz 0'
georef SHIFT  'epsg 32651' 'offsetx 0' 'offsety 0' 'offsetz 0' 'shiftx 1'
georef SCALE  'epsg 32651' 'offsetx 0' 'offsety 0' 'offsetz 0' 'scalez 2'
scan50 HOLES '"ground":9'
scan50 LOW '"depth":0.7'
scan50 NOOPAC '"noOpacity":true'
scan50 DOUBLEZ '"doubleZ":true'
refuses "a ground under only 9 samples" "HOLES: the ground was found under 9 samples of 50; at least 10" HOLES
refuses "an antenna height under 1.0 m" "LOW: the antenna height is 0.700 m, outside 1–2.5 m" LOW
refuses "a PLY without opacity"         "NOOPAC: point_cloud.ply has no property opacity" NOOPAC
refuses "a PLY with a double z"         "DOUBLEZ: point_cloud.ply property z must be float" DOUBLEZ
refuses "an RTK fix without a position" "NANRTK: gnss.csv line 3: 'nan' is not a number" NANRTK
refuses "fixes along a line"          "LINE: the RTK fixes are too close to a line"      T1 LINE
refuses "a thin triangle, by the loader's measure" "THIN: the RTK fixes are too close to a line (spread across it is 1.8" THIN
refuses "fewer than 3 RTK fixes"      "FEW: 2 RTK-fixed GNSS fix(es)"                    FEW
refuses "a folder without gnss.csv"   "NOGNSS: $SPLATS_ORIGINAL_DIR/NOGNSS/gnss.csv is missing" NOGNSS
refuses "a folder without point_cloud.ply" "NOPLY: no point_cloud.ply"               NOPLY
refuses "a capture that is not a PLY" "SOG: point_cloud.sog carries no georeference" SOG
refuses "two captures"                "TWO: more than one capture"                   TWO
refuses "a header without epsg"       "NOEPSG: point_cloud.ply has no 'comment epsg'" NOEPSG
refuses "a header without offsetz"    "NOZ: point_cloud.ply has no 'comment offsetz'" NOZ
refuses "a CRS that is not UTM"       "TWD97: point_cloud.ply is in EPSG:3826"       TWD97
refuses "a shift"                     "SHIFT: point_cloud.ply has shiftx 1"          SHIFT
refuses "a scale"                     "SCALE: point_cloud.ply has scalez 2"          SCALE
refuses "a path as the scan"          "must be a bare scan folder name"              ../T1
refuses "a missing scan"              "ABSENT: $SPLATS_ORIGINAL_DIR/ABSENT/gnss.csv is missing" ABSENT
printf 'SplatID,File,Point,X,Y,Z,LON,LAT,H,Note\n' > "$SPLATS_CONTROL_POINTS"
refuses "a file with another header"  "does not start with the header"               T1

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
