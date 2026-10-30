#!/usr/bin/env bash
# splat-mosaic.mjs's test suite.
#
# Runs the real splat-mosaic.mjs against scans written here by
# test/splat-mosaic-scene.mjs, in a scratch directory: an original/<scan>/
# point_cloud.ply carrying only the georeferenced header, and a
# clean/<scan>.ply carrying the splats without it, as process-splat.sh leaves
# them. No binary fixture is checked in and data/ is never touched. The
# selection is tested through a stub quality module (SPLATS_QUALITY_MODULE),
# so the cases do not depend on the real metric's numbers; one run uses the
# real one. Needs node only.
#
#   ./test/splat-mosaic.sh    # from infra/; test/run.sh also runs it
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

# The stub: a voxel's value is its largest f_dc_0, and every scan with the
# best value is returned, so ties reach the mosaic's own tie-break.
cat > "$work/stub.mjs" <<'EOF'
export const name = 'stub';
export const version = 7;
export function score(v) {
  let value = -Infinity;
  for (let i = 0; i < v.n; i++) value = Math.max(value, v.dc0[i]);
  return { value, count: v.n };
}
export function choose(scores) {
  const best = Math.max(...scores.map((s) => s.value));
  return scores.flatMap((s, i) => (s.value === best ? [i] : []));
}
EOF

# mk_scan <root> <scan> <epsg> <offsetx> <offsety> <offsetz> <splats JSON> [props JSON]
mk_scan() {
  local root=$1 scan=$2 epsg=$3 ox=$4 oy=$5 oz=$6 splats=$7 props=${8:-null}
  mkdir -p "$root/original/$scan" "$root/clean"
  echo "{\"comments\": {\"epsg\": \"$epsg\", \"offsetx\": \"$ox\", \"offsety\": \"$oy\", \"offsetz\": \"$oz\"}, \"splats\": []}" \
    | node test/splat-mosaic-scene.mjs -- "$root/original/$scan/point_cloud.ply"
  echo "{\"props\": $props, \"splats\": $splats}" | node test/splat-mosaic-scene.mjs -- "$root/clean/$scan.ply"
}

# mosaic <root> [env…]: the real script on <root>, with the stub unless the
# caller sets SPLATS_QUALITY_MODULE itself, and every tile kept (the scenes
# are a few splats each) unless it sets SPLATS_MIN_TILE_SPLATS.
mosaic() {
  local root=$1; shift
  env SPLATS_ORIGINAL_DIR="$root/original" SPLATS_CLEAN_DIR="$root/clean" \
    SPLATS_TILES_DIR="$root/tiles" SPLATS_GEOREF="$root/georef.csv" \
    SPLATS_QUALITY_MODULE="$work/stub.mjs" SPLATS_MIN_TILE_SPLATS=1 "$@" node scripts/splat-mosaic.mjs 2>&1
}

# tile_read <tile.ply> <JS expression over r = { header, comments, props, splats }>
tile_read() { node test/splat-mosaic-scene.mjs -- --read "$1" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const r = JSON.parse(s); console.log(eval(process.argv[1]));
  });' -- "$2"; }
sums() { (cd "$1" && find . -type f | sort | xargs shasum -a 256); }

# The scene. A at offset (352650, 2770050, 27), B at (352660, 2770040, 26):
# no datum, so H = z + 27 for A and z + 26 for B. Every splat's f_dc_0 is
# what the stub ranks by.
#
#   a1   alone in its voxel, with exact attributes to compare bit for bit
#   a2   E = 352699.999, the last of tile 352600;  a3  E = 352700, tile 352700
#   a4   E = 352653.9995, in voxel V with b1 (B's, preferred): dropped
#   a5   E = 352654, the next voxel, alone: kept
#   W    a6, a7 (0.9) against b2–b4 (0.2): A keeps both, B none
#   W2   a8 (0.2) against b5 (0.9): B keeps it
#   T    a9 and b6, both 0.5: a tie, A sorts first
A_SPLATS='[
  {"x": 1.25, "y": 2.5, "z": 0.75, "dc0": 0.3, "dc1": 0.125, "dc2": -0.75, "opacity": -1.25,
   "s0": -3.5, "s1": -4.25, "s2": -2.5, "r0": 0.5, "r1": 0.5, "r2": -0.5, "r3": 0.5},
  {"x": 49.999, "y": 10, "z": 0.75},
  {"x": 50, "y": 10, "z": 0.75},
  {"x": 3.9995, "y": 10.5, "z": 1, "dc0": 0.1},
  {"x": 4.0, "y": 10.5, "z": 1, "dc0": 0.1},
  {"x": 5.2, "y": 20.5, "z": 1, "dc0": 0.9},
  {"x": 5.4, "y": 20.5, "z": 1, "dc0": 0.9},
  {"x": 6.5, "y": 20.5, "z": 1, "dc0": 0.2},
  {"x": 7.5, "y": 20.5, "z": 1, "dc0": 0.5}
]'
B_SPLATS='[
  {"x": -6.5, "y": 20.5, "z": 2, "dc0": 0.9},
  {"x": -4.7, "y": 30.5, "z": 2, "dc0": 0.2},
  {"x": -4.5, "y": 30.5, "z": 2, "dc0": 0.2},
  {"x": -4.3, "y": 30.5, "z": 2, "dc0": 0.2},
  {"x": -3.5, "y": 30.5, "z": 2, "dc0": 0.9},
  {"x": -2.5, "y": 30.5, "z": 2, "dc0": 0.5}
]'
R=$work/run
mk_scan "$R" A 32651 352650 2770050 27 "$A_SPLATS"
mk_scan "$R" B 32651 352660 2770040 26 "$B_SPLATS"
T0=$R/tiles/32651-352600-2770000.ply
T1=$R/tiles/32651-352700-2770000.ply

case_ "two overlapping scans"
out=$(mosaic "$R") || { echo "$out"; echo "the mosaic failed unexpectedly" >&2; exit 1; }
expect "writes two tiles and the report" "$(ls "$R/tiles" | tr '\n' ' ')" "32651-352600-2770000.ply 32651-352700-2770000.ply mosaic.json "
# Tile 352600 keeps a1 and a2 at H 27.75 and six splats at 28: the lower
# layer holds over a fifth of the peak, so it is the ground. Tile 352700
# holds a3 alone, at 27.75.
expect "georef.csv: one row per tile, by id, at their centres, OFFSETZ 0 and their ground" "$(cat "$R/georef.csv")" \
"SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ,GROUNDZ
32651-352600-2770000,32651-352600-2770000.ply,32651,352650,2770050,0,27.75
32651-352700-2770000,32651-352700-2770000.ply,32651,352750,2770050,0,27.75"
expect "the tile header: the frame, the method and the 14 properties" "$(tile_read "$T0" 'r.header.join("|")')" \
  "ply|format binary_little_endian 1.0|element vertex 8|comment epsg 32651|comment offsetx 352650|comment offsety 2770050|comment offsetz 0|comment mosaic splat-mosaic revision 1, quality stub v7|property float x|property float y|property float z|property float f_dc_0|property float f_dc_1|property float f_dc_2|property float opacity|property float scale_0|property float scale_1|property float scale_2|property float rot_0|property float rot_1|property float rot_2|property float rot_3|end_header"
expect_contains "reports each scan" "$out" "A: 9 splats, 7 kept"
expect_contains "  and the totals" "$out" "2 tiles, 8 voxels (4 contested); 9 of 15 splats kept"

case_ "the common frame"
expect "a1 lands in the tile's frame: (1.25, 2.5) from its centre, at its ellipsoidal height 27.75" \
  "$(tile_read "$T0" '[r.splats[0].x, r.splats[0].y, r.splats[0].z].join(" ")')" "1.25 2.5 27.75"
expect "  its colour, opacity, scales and rotation unchanged, bit for bit" \
  "$(tile_read "$T0" 'const s = r.splats[0]; [s.f_dc_0 === Math.fround(0.3), s.f_dc_1, s.f_dc_2, s.opacity, s.scale_0, s.scale_1, s.scale_2, s.rot_0, s.rot_1, s.rot_2, s.rot_3].join(" ")')" \
  "true 0.125 -0.75 -1.25 -3.5 -4.25 -2.5 0.5 0.5 -0.5 0.5"
expect "B's frame: b1 at (−6.5, 20.5, 2) in B is (3.5, 10.5, 28) in the tile" \
  "$(tile_read "$T0" '[r.splats[6].x, r.splats[6].y, r.splats[6].z].join(" ")')" "3.5 10.5 28"

case_ "the grid"
expect "E = 352699.999 is the last metre of tile 352600" "$(tile_read "$T0" 'Math.abs(r.splats[1].x - 49.999) < 1e-4')" true
expect "E = 352700 starts tile 352700, at x = −50" "$(tile_read "$T1" 'r.splats.length + " " + r.splats[0].x')" "1 -50"
expect "a4 (E = 352653.9995) shares voxel V with b1, and loses it" "$(tile_read "$T0" 'r.splats.some(s => Math.abs(s.x - 3.9995) < 1e-4)')" false
expect "a5 (E = 352654) is the next voxel, alone, and kept" "$(tile_read "$T0" 'r.splats.some(s => s.x === 4 && s.y === 10.5)')" true

case_ "the selection"
expect "voxel W: A keeps both its splats, B none of its three" \
  "$(tile_read "$T0" 'r.splats.filter(s => s.x > 5 && s.x < 6).map(s => s.f_dc_0.toFixed(1)).join(" ")')" "0.9 0.9"
expect "voxel W2, next to it: B keeps its splat, A loses its own" \
  "$(tile_read "$T0" 'r.splats.filter(s => s.x >= 6 && s.x < 7).map(s => s.f_dc_0.toFixed(1)).join(" ")')" "0.9"
expect "voxel T, a tie: A, which sorts first" \
  "$(tile_read "$T0" 'r.splats.filter(s => s.x >= 7 && s.x < 8).length + " " + r.splats.findIndex(s => s.x >= 7 && s.x < 8)')" "1 5"
expect "order: A's splats in file order, then B's" \
  "$(tile_read "$T0" 'r.splats.map(s => s.x.toFixed(2)).join(" ")')" "1.25 50.00 4.00 5.20 5.40 7.50 3.50 6.50"

case_ "mosaic.json"
m() { node -e 'const m = require(process.argv[1]); console.log(eval(process.argv[2]))' "$R/tiles/mosaic.json" "$1"; }
expect "names the method, the ground's constants, and no datum" \
  "$(m '[m.revision, m.quality.name, m.quality.version, m.ground.bin_m, m.ground.peak_fraction, m.epsg, "datum_m" in m].join(" ")')" "1 stub 7 0.1 0.2 32651 false"
expect "per scan: splats, kept, voxels won" "$(m 'm.scans.map(s => [s.scan, s.splats, s.kept, s.voxels_won].join(":")).join(" ")')" "A:9:7:6 B:6:2:2"
expect "per tile: splats, voxels, contested, won by" \
  "$(m 'm.tiles.map(t => [t.id, t.splats, t.voxels, t.contested_voxels, JSON.stringify(t.won_by)].join(":")).join(" ")')" \
  '32651-352600-2770000:8:7:4:{"A":5,"B":2} 32651-352700-2770000:1:1:0:{"A":1}'
expect "per tile: the ground and how it was reached" \
  "$(m 'm.tiles.map(t => [t.id, t.ground.ground_m, t.ground.bin_splats, t.ground.peak_m, t.ground.peak_splats, t.ground.lowest_m].join(":")).join(" ")')" \
  "32651-352600-2770000:27.75:2:28:6:27.75 32651-352700-2770000:27.75:1:27.7:1:27.75"
expect "the step between the two neighbours, and the largest" \
  "$(m 'JSON.stringify(m.ground_steps) + " " + m.totals.largest_ground_step_m')" \
  '[{"tiles":["32651-352600-2770000","32651-352700-2770000"],"step_m":0}] 0'
expect "  and the counts add up" \
  "$(m '[m.totals.splats_in, m.totals.splats_kept, m.tiles.reduce((a, t) => a + t.splats, 0), m.scans.reduce((a, s) => a + s.kept, 0)].join(" ")')" "15 9 9 9"

case_ "determinism"
before=$(sums "$R/tiles"; shasum -a 256 "$R/georef.csv" | cut -d' ' -f1)
mosaic "$R" > /dev/null
expect "a re-run is byte-identical" "$(sums "$R/tiles"; shasum -a 256 "$R/georef.csv" | cut -d' ' -f1)" "$before"
R2=$work/reversed
mk_scan "$R2" B 32651 352660 2770040 26 "$B_SPLATS"
mk_scan "$R2" A 32651 352650 2770050 27 "$A_SPLATS"
mosaic "$R2" > /dev/null
expect "  and so is a run with the scans written in the other order" "$(sums "$R2/tiles")" "$(sums "$R/tiles")"

case_ "heights: no datum"
R3=$work/heights
mk_scan "$R3" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0.5}]'
mk_scan "$R3" B 32651 352650 2770050 26 '[{"x": 10, "y": 0, "z": 0.5}]'
mk_scan "$R3" C 32651 352650 2770050 40 '[{"x": 20, "y": 0, "z": 0.5}]'
mosaic "$R3" > /dev/null
expect "each splat at its scan's offsetz plus its z" "$(tile_read "$R3/tiles/32651-352600-2770000.ply" 'r.splats.map(s => s.z).join(" ")')" "27.5 26.5 40.5"
expect "  the tile's offsetz 0" "$(tile_read "$R3/tiles/32651-352600-2770000.ply" 'r.comments.offsetz')" 0
expect "  and georef.csv's OFFSETZ 0" "$(tail -n 1 "$R3/georef.csv" | cut -d, -f6)" 0

# One scan at offset (352650, 2770050, 0), so H is z. Four tiles, each a
# dense layer of 15 splats at 10.05 (the peak: a fifth is 3, and 0.2 × 15 is
# a hair over 3 in doubles) and something lower:
#   G1  352600: 2 splats at 9.05, under a fifth: the ground is the dense layer
#   G2  352700: 3 splats at 9.02, 9.04, 9.06, exactly a fifth: they are the
#       ground, their median 9.04
#   G3  352800: 4 splats at 9.01, 9.03, 9.05, 9.07: an even count, the mean
#       of the middle two, 9.04
#   G4  352900-2770100: one splat at 5.05, its own ground; a corner
#       neighbour of G3, so no step between them
case_ "the ground"
layer() { node -e 'const [x, y, n, ...zs] = process.argv.slice(1).map(Number);
  const out = []; for (let k = 0; k < n; k++) out.push(zs.length ? { x, y, z: zs[k] } : { x, y, z: 10.05 });
  console.log(JSON.stringify(out).slice(1, -1));' -- "$@"; }
G_SPLATS="[$(layer 0 0 15),$(layer 0 0 2 9.05 9.05),$(layer 100 0 15),$(layer 100 0 3 9.02 9.04 9.06),$(layer 200 0 15),$(layer 200 0 4 9.01 9.03 9.05 9.07),$(layer 300 100 1 5.05)]"
R4=$work/ground
mk_scan "$R4" A 32651 352650 2770050 0 "$G_SPLATS"
out=$(mosaic "$R4") || { echo "$out"; echo "the mosaic failed unexpectedly" >&2; exit 1; }
expect "GROUNDZ: the dense layer; a layer at exactly a fifth; an even count's middle two; a tile on its own" \
  "$(tail -n +2 "$R4/georef.csv" | cut -d, -f1,7 | tr '\n' ' ')" \
  "32651-352600-2770000,10.05 32651-352700-2770000,9.04 32651-352800-2770000,9.04 32651-352900-2770100,5.05 "
m4() { node -e 'const m = require(process.argv[1]); console.log(eval(process.argv[2]))' "$R4/tiles/mosaic.json" "$1"; }
expect "  mosaic.json's ground for G1: the bin, the peak and the lowest splat" \
  "$(m4 'JSON.stringify(m.tiles[0].ground)')" '{"ground_m":10.05,"bin_splats":15,"peak_m":10,"peak_splats":15,"lowest_m":9.05}'
expect "steps between edge neighbours only, not the corner" \
  "$(m4 'm.ground_steps.map(p => p.tiles.join("|") + "=" + p.step_m).join(" ") + " " + m.totals.largest_ground_step_m')" \
  "32651-352600-2770000|32651-352700-2770000=1.01 32651-352700-2770000|32651-352800-2770000=0 1.01"
expect_contains "  and reports the largest" "$out" "largest ground step between neighbouring tiles: 1.01 m (32651-352600-2770000 | 32651-352700-2770000)"
R5=$work/alone
mk_scan "$R5" A 32651 352650 2770050 0 '[{"x": 0, "y": 0, "z": 1}]'
out=$(mosaic "$R5") || { echo "$out"; echo "the mosaic failed unexpectedly" >&2; exit 1; }
expect "a lone tile: no steps, and the largest is null" \
  "$(node -e 'const m = require(process.argv[1]); console.log(JSON.stringify(m.ground_steps) + " " + m.totals.largest_ground_step_m)' "$R5/tiles/mosaic.json")" "[] null"
expect_contains "  and says so" "$out" "no two tiles share an edge"

# Tiles of 2 and 3 splats, at a minimum of 3: the first dropped, the second
# kept. Tile 352700, the one dropped, shares an edge with the kept 352600.
case_ "dropped tiles"
R6=$work/dropped
mk_scan "$R6" A 32651 352650 2770050 0 '[{"x": 0, "y": 0, "z": 1}, {"x": 10, "y": 0, "z": 1}, {"x": 20, "y": 0, "z": 1},
  {"x": 100, "y": 0, "z": 1}, {"x": 110, "y": 0, "z": 1}]'
out=$(mosaic "$R6" SPLATS_MIN_TILE_SPLATS=3) || { echo "$out"; echo "the mosaic failed unexpectedly" >&2; exit 1; }
m6() { node -e 'const m = require(process.argv[1]); console.log(eval(process.argv[2]))' "$R6/tiles/mosaic.json" "$1"; }
expect "the tile of 2 has no .ply; the tile of exactly 3 has one" "$(ls "$R6/tiles" | tr '\n' ' ')" "32651-352600-2770000.ply mosaic.json "
expect "  no georef.csv row" "$(tail -n +2 "$R6/georef.csv" | cut -d, -f1 | tr '\n' ' ')" "32651-352600-2770000 "
expect "  in dropped_tiles with its count, in splats_dropped, and in no step" \
  "$(m6 'JSON.stringify(m.dropped_tiles) + " " + m.totals.splats_dropped + " " + m.ground_steps.length')" \
  '[{"id":"32651-352700-2770000","splats":2}] 2 0'
expect "  in no scan's kept or voxels_won, and the counts add up" \
  "$(m6 '[m.scans[0].kept, m.scans[0].voxels_won, m.totals.splats_kept, m.totals.splats_in].join(" ")')" "3 3 3 5"
expect_contains "  and the run says so" "$out" "1 tiles under 3 splats dropped, 2 splats: 32651-352700-2770000 (2)"
out=$(mosaic "$R6" SPLATS_MIN_TILE_SPLATS=) || { echo "$out"; echo "the mosaic failed unexpectedly" >&2; exit 1; }
expect "unset, the minimum is 10,000: both dropped" "$(m6 'm.tiles.length + " " + m.dropped_tiles.length')" "0 2"
for bad in 0 2.5 abc; do
  if out=$(mosaic "$R6" SPLATS_MIN_TILE_SPLATS=$bad); then bad "SPLATS_MIN_TILE_SPLATS=$bad" "the mosaic succeeded"; else
    expect_contains "SPLATS_MIN_TILE_SPLATS=$bad is refused" "$out" "SPLATS_MIN_TILE_SPLATS is '$bad'; it must be a positive integer"
  fi
done

case_ "the real quality module"
out=$(mosaic "$R" SPLATS_QUALITY_MODULE=) || { echo "$out"; echo "the mosaic with the real module failed" >&2; exit 1; }
expect "runs, and the tile names it" "$(tile_read "$T0" 'r.comments.mosaic')" "splat-mosaic revision 1, quality coverage-sharpness v1"

case_ "replacing the mosaic"
mosaic "$R" > /dev/null
rm "$R/clean/A.ply"
mosaic "$R" > /dev/null
expect "a tile that no longer exists is removed" "$(ls "$R/tiles" | tr '\n' ' ')" "32651-352600-2770000.ply mosaic.json "
expect "  and leaves georef.csv" "$(wc -l < "$R/georef.csv" | tr -d ' ')" 2
before=$(sums "$R/tiles"; cat "$R/georef.csv")
mk_scan "$R" Z 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'
printf 'junk' >> "$R/clean/Z.ply"
if out=$(mosaic "$R"); then bad "fails on a scan it cannot read" "the mosaic succeeded"; else
  expect_contains "fails on a scan it cannot read" "$out" "Z: $R/clean/Z.ply: is"
fi
expect "  and leaves the previous mosaic" "$(sums "$R/tiles"; cat "$R/georef.csv")" "$before"
expect "  and no temporary directory" "$(find "$R/tiles" -name '.mosaic-*' | wc -l | tr -d ' ')" 0
# The next two fail after the tiles are written. A succeeding run would
# write two tiles where the previous mosaic has one, so a leftover shows.
rm "$R/clean/Z.ply"; rm -r "$R/original/Z"
mk_scan "$R" A 32651 352650 2770050 27 "$A_SPLATS"
touch "$R/blocker"
if out=$(mosaic "$R" SPLATS_GEOREF="$R/blocker/georef.csv"); then bad "fails when georef.csv cannot be staged" "the mosaic succeeded"; else
  expect_contains "fails when georef.csv cannot be staged" "$out" "$R/blocker"
fi
expect "  and leaves the previous mosaic" "$(sums "$R/tiles"; cat "$R/georef.csv")" "$before"
expect "  and no temporary directory" "$(find "$R/tiles" -name '.mosaic-*' | wc -l | tr -d ' ')" 0
mkdir "$R/georef-dir"
if out=$(mosaic "$R" SPLATS_GEOREF="$R/georef-dir"); then bad "fails when georef.csv cannot be renamed in" "the mosaic succeeded"; else
  expect_contains "fails when georef.csv cannot be renamed in" "$out" "$R/georef-dir"
fi
expect "  and moves the previous tiles back" "$(sums "$R/tiles"; cat "$R/georef.csv")" "$before"
expect "  and leaves no temporary directory or staged georef.csv" \
  "$(find "$R" -maxdepth 2 \( -name '.mosaic-*' -o -name '.georef*' \) | wc -l | tr -d ' ')" 0

# A run that fails after it made tiles/ removes it again. The bad stub fails
# in choose, after the work directory exists inside it.
cat > "$work/bad-choose.mjs" <<'EOF'
export const name = 'bad-choose';
export const version = 1;
export function score(v) { return { value: 0, count: v.n }; }
export function choose() { return []; }
EOF
X=$work/fresh; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'
if out=$(mosaic "$X" SPLATS_QUALITY_MODULE="$work/bad-choose.mjs"); then bad "fails when choose returns nothing" "the mosaic succeeded"; else
  expect_contains "fails when choose returns nothing" "$out" "bad-choose: choose returned [] for 1 candidates"
fi
expect "  and removes the tiles/ it made" "$([ -e "$X/tiles" ] && echo present || echo absent)" absent

case_ "refusals"
rejects() {
  local label=$1 root=$2 needle=$3
  if out=$(mosaic "$root"); then bad "$label" "the mosaic succeeded"; return; fi
  expect_contains "$label" "$out" "$needle"
  [ ! -e "$root/tiles" ] || [ -z "$(ls "$root/tiles")" ] || bad "  $label: writes nothing" "$(ls "$root/tiles")"
}
X=$work/zones; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'; mk_scan "$X" B 32650 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'
rejects "scans in two UTM zones" "$X" "the scans are in 2 CRSs (A EPSG:32651, B EPSG:32650)"
X=$work/orphan; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'; rm -r "$X/original/A"
rejects "a clean scan without its original" "$X" "A: $X/clean/A.ply has no scan folder"
X=$work/noply; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'; rm "$X/original/A/point_cloud.ply"
rejects "an original without its point_cloud.ply" "$X" "A: no point_cloud.ply in $X/original/A"
X=$work/spz; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'; mv "$X/original/A/point_cloud.ply" "$X/original/A/point_cloud.spz"
rejects "an original that is not a PLY" "$X" "A: point_cloud.spz carries no georeference; only a point_cloud.ply with one can be placed"
X=$work/nogeo; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]'
echo '{"comments": {"epsg": "32651"}, "splats": []}' | node test/splat-mosaic-scene.mjs -- "$X/original/A/point_cloud.ply"
rejects "an original without its georeference" "$X" "A: point_cloud.ply has no 'comment offsetx' georeference"
X=$work/noprop; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]' '["x","y","z","f_dc_0","f_dc_1","f_dc_2","opacity","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2"]'
rejects "a layout without rot_3" "$X" "has no property rot_3"
X=$work/sh; mk_scan "$X" A 32651 352650 2770050 27 '[{"x": 0, "y": 0, "z": 0}]' '["x","y","z","f_dc_0","f_dc_1","f_dc_2","f_rest_0","opacity","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3"]'
rejects "spherical harmonics beyond degree 0" "$X" "carries spherical harmonics beyond degree 0"
X=$work/empty; mkdir -p "$X/clean"
rejects "no clean scans" "$X" "no cleaned scans in $X/clean"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
