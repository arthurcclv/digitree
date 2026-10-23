#!/usr/bin/env bash
# The splat cleaner's test suite.
#
# Runs the real clean-splat.sh against scans generated here — written with
# splat-transform's .mjs generator input and saved as <scan>/point_cloud.<ext> —
# in a scratch directory, so no binary fixture is checked in and data/ is never
# touched. Needs splat-transform (with its library, installed globally) and
# node, as the script does; no database.
#
#   ./test/clean-splat.sh   # from infra/; test/run.sh also runs it
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

for tool in splat-transform node; do
  command -v "$tool" > /dev/null || { echo "error: $tool is not on PATH" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export SPLATS_ORIGINAL_DIR=$work/original SPLATS_SOURCE_DIR=$work/source
mkdir -p "$SPLATS_ORIGINAL_DIR" "$work/gen"

count() { splat-transform -q --no-tty "$1" --info json null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).numGaussians));'; }
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
clean() { ./scripts/clean-splat.sh "$@" 2>&1; }

# The scene, in file coordinates. Every clump is a dense grid — 1 cm apart,
# 2 cm across, under 10 cm in all — that starts 0.5 m past an even metre on
# every axis. Voxels sit on multiples of the cell from the origin, so with 2 m
# voxels each clump fills the middle of exactly one, mirrored or not.
#
#   main   10³ = 1000 at (−29.5, −39.5, 0.5): the typical density, so at
#          --min-density 0.01 a voxel needs 10 to stay
#   c27    3³ = 27, a voxel of its own: kept (27 ≥ 10)
#   c8     2³ = 8 beside the scene: removed (8 < 10)
#   sky    2³ = 8, 50 m above main: removed — a ground-column count keeps it
#   far    6³ = 216, 150 m from main: kept — distance alone removes nothing
#   sizes  6³ = 216: 64 Gaussians 0.5 m along x (removed by --max-scale 0.25)
#          and 64 0.12 m along y (kept). SOG stores scales in a 256-entry
#          codebook that pools rare values — one Gaussian at 0.3 m and one at
#          0.24 m both decoded as 0.2683 — so each size is given 64, and the
#          two sit well either side of the limit.
#
# scene is point_cloud.sog, as the KZ0918 scans were delivered. mirror is the
# same scene through the origin, every coordinate negative. The same scene is
# also written in each other format splat-transform can write, and both is a
# folder holding a .ply (main alone) beside a .sog, which must be refused.
cat > "$work/gen/scene.mjs" <<'EOF'
const s = 1; // 1 for scene, −1 for mirror
const only = Infinity; // how many clumps; 1 for main alone
const clumps = [
  { at: [-29.5, -39.5, 0.5], n: [10, 10, 10] },
  { at: [-19.5, -39.5, 0.5], n: [3, 3, 3] },
  { at: [-9.5, -39.5, 0.5], n: [2, 2, 2] },
  { at: [-29.5, -39.5, 50.5], n: [2, 2, 2] },
  { at: [120.5, -39.5, 0.5], n: [6, 6, 6] },
  { at: [-29.5, -19.5, 0.5], n: [6, 6, 6], sizes: true },
];
const rows = [];
for (const c of clumps.slice(0, only)) {
  let k = 0;
  for (let i = 0; i < c.n[0]; i++) for (let j = 0; j < c.n[1]; j++) for (let l = 0; l < c.n[2]; l++, k++) {
    const scale = [0.02, 0.02, 0.02];
    if (c.sizes && k < 64) scale[0] = 0.5;
    else if (c.sizes && k < 128) scale[1] = 0.12;
    rows.push({
      x: s * (c.at[0] + i * 0.01), y: s * (c.at[1] + j * 0.01), z: s * (c.at[2] + l * 0.01),
      scale_0: Math.log(scale[0]), scale_1: Math.log(scale[1]), scale_2: Math.log(scale[2]),
      rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
      f_dc_0: 0.5, f_dc_1: 0.5, f_dc_2: 0.5, opacity: 5,
    });
  }
}
export class Generator {
  static create() {
    return { count: rows.length, columnNames: Object.keys(rows[0]), getRow: (i, row) => Object.assign(row, rows[i]) };
  }
}
EOF
formats=(ply compressed.ply spz)
for d in scene mirror empty both code "${formats[@]/#/as-}"; do mkdir -p "$SPLATS_ORIGINAL_DIR/$d"; done
splat-transform -q --no-tty -w "$work/gen/scene.mjs" "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog"
sed 's/^const s = 1;/const s = -1;/' "$work/gen/scene.mjs" > "$work/gen/mirror.mjs"
splat-transform -q --no-tty -w "$work/gen/mirror.mjs" "$SPLATS_ORIGINAL_DIR/mirror/point_cloud.sog"
for ext in "${formats[@]}"; do
  splat-transform -q --no-tty -w "$work/gen/scene.mjs" "$SPLATS_ORIGINAL_DIR/as-$ext/point_cloud.$ext"
done
sed 's/^const only = Infinity;/const only = 1;/' "$work/gen/scene.mjs" > "$work/gen/main.mjs"
splat-transform -q --no-tty -w "$work/gen/main.mjs" "$SPLATS_ORIGINAL_DIR/both/point_cloud.ply"
cp "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog" "$SPLATS_ORIGINAL_DIR/both/"
# A generator is code; one in a scan folder must never be run.
cp "$work/gen/scene.mjs" "$SPLATS_ORIGINAL_DIR/code/point_cloud.mjs"
before=$(sum "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog")
out=$SPLATS_SOURCE_DIR/scene.spz

case_ "the density, size and floater cuts"
expect "the original has every clump" "$(count "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog")" 1475
log=$(clean scene) || { echo "$log"; echo "clean-splat.sh failed unexpectedly" >&2; exit 1; }
expect_contains "names the file it read" "$log" "==> scene (point_cloud.sog)"
expect_contains "the typical voxel is main's, and both 8s go" "$log" "1475 gaussians; typical voxel holds 1000; 1459 kept by density"
expect "writes source/<scan>.spz with main, c27, far and sizes less 64" "$(count "$out")" 1395
expect_contains "reports the size cut on its own" "$log" "1395 kept by size"
expect_contains "reports what it removed" "$log" "1395 kept after floaters; 80 removed in all (5.4%)"

case_ "every coordinate negative"
if log=$(clean mirror); then
  expect "keeps the same clumps" "$(count "$SPLATS_SOURCE_DIR/mirror.spz")" 1395
else
  bad "cleans a mirrored scan" "$log"
fi
rm -f "$SPLATS_SOURCE_DIR/mirror.spz"

case_ "every format splat-transform can write"
for ext in "${formats[@]}"; do
  if log=$(clean "as-$ext"); then
    expect "point_cloud.$ext gives the same counts" "$(count "$SPLATS_SOURCE_DIR/as-$ext.spz")" 1395
  else
    bad "cleans a point_cloud.$ext" "$log"
  fi
  rm -f "$SPLATS_SOURCE_DIR/as-$ext.spz"
done

case_ "each cut alone"
clean scene --max-scale 1 > /dev/null
expect "without the size cut the 0.5 m Gaussians stay" "$(count "$out")" 1459
clean scene --min-density 0.03 > /dev/null
expect "at 0.03 a voxel needs 30, so c27 goes too" "$(count "$out")" 1368
log=$(clean scene --cell 100)
# 100 m voxels put main, the sky clump and every clump near them in one voxel,
# and far's 216 still clears 1% of it: the cell is what tells a sky floater
# from the street below it.
expect_contains "in 100 m voxels the sky clump shares main's, and nothing goes" "$log" "1475 kept by density"

case_ "the output"
clean scene > /dev/null
expect "is gzipped" "$(od -An -tx1 -N2 "$out" | tr -d ' ')" 1f8b
expect "is SPZ v3"  "$(node -e '
  const h = require("zlib").gunzipSync(require("fs").readFileSync(process.argv[1]));
  console.log(h.toString("latin1", 0, 4), h.readUInt32LE(4));' -- "$out")" "NGSP 3"
expect "leaves the original as it was" "$(sum "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog")" "$before"
clean scene > /dev/null
expect "a re-run starts from the original" "$(count "$out")" 1395

case_ "refusals"
kept=$(sum "$out")
if log=$(clean scene --min-density 2); then bad "fails when nothing is left" "it succeeded"; else ok "fails when nothing is left"; fi
expect_contains "  says so"                     "$log" "remove every Gaussian"
expect "  leaves the previous output"           "$(sum "$out")" "$kept"
expect "  leaves no temporary file"             "$(ls -A "$SPLATS_SOURCE_DIR")" scene.spz
if log=$(clean absent); then bad "refuses a missing scan" "it succeeded"; else expect_contains "refuses a missing scan" "$log" "'absent' is not a scan folder in"; fi
if log=$(clean empty); then bad "refuses a scan with no splat" "it succeeded"; else expect_contains "refuses a scan with no splat" "$log" "'empty' has no point_cloud.<ext>"; fi
if log=$(clean both); then bad "refuses two splats" "it succeeded"; else expect_contains "refuses two splats, naming both" "$log" "more than one splat: point_cloud.ply point_cloud.sog"; fi
if log=$(clean code); then bad "refuses a point_cloud.mjs" "it succeeded"; else expect_contains "refuses a point_cloud.mjs, never running it" "$log" "'code' has no point_cloud.<ext>"; fi
if log=$(clean ../original/scene); then bad "refuses a path" "it succeeded"; else expect_contains "refuses a path" "$log" "must be a bare scan folder name"; fi
if log=$(clean scene --cell 0); then bad "refuses a zero cell" "it succeeded"; else expect_contains "refuses a zero cell" "$log" "--cell must be a positive number"; fi
if log=$(clean scene --min-density -1); then bad "refuses a negative density" "it succeeded"; else expect_contains "refuses a negative density" "$log" "--min-density must be a positive fraction"; fi
if log=$(clean scene --max-scale 0); then bad "refuses a zero size" "it succeeded"; else expect_contains "refuses a zero size" "$log" "--max-scale must be a positive number"; fi

case_ "run from outside infra/"
# Without the overrides, the default folders are found from the script's own
# location, not the working directory. A missing scan is refused before
# anything is written, so data/ is only read.
if log=$(here=$PWD; cd "$work" && env -u SPLATS_ORIGINAL_DIR -u SPLATS_SOURCE_DIR "$here/scripts/clean-splat.sh" no-such-scan 2>&1); then bad "finds infra/data from elsewhere" "it succeeded"; else expect_contains "finds infra/data from elsewhere" "$log" "not a scan folder in $PWD/data/3dgs/original"; fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
