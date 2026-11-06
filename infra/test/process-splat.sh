#!/usr/bin/env bash
# process-splat.sh's test suite.
#
# Runs the real process-splat.sh against scans generated here — written with
# splat-transform's .mjs generator input and saved as <scan>/point_cloud.<ext> —
# in a scratch directory, so no binary fixture is checked in and data/ is never
# touched. Needs splat-transform (with its library, installed globally) and
# node, as the script does; no database.
#
#   ./test/process-splat.sh   # from infra/; test/run.sh also runs it
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
export SPLATS_ORIGINAL_DIR=$work/original SPLATS_CLEAN_DIR=$work/clean
mkdir -p "$SPLATS_ORIGINAL_DIR" "$work/gen"

count() { splat-transform -q --no-tty "$1" --info json null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).numGaussians));'; }
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
# Every scene below is a set of detached clumps, which footprint pruning would
# cut to one; 1000 m voxels put each scene in one group, so nothing is pruned
# and each later cut is seen alone. plain runs with the default.
process() { ./scripts/process-splat.sh "$@" --footprint-cell 1000 2>&1; }
plain() { ./scripts/process-splat.sh "$@" 2>&1; }

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
# A delivered PLY carries a georeference, and the align step refuses one
# without (splat-align.md revision 5); splat-transform writes none, so it is
# added. It has no `comment source`, so the step skips it.
georef() { node -e '
  const fs = require("fs"), p = process.argv[1], buf = fs.readFileSync(p);
  const end = buf.indexOf("end_header\n") + "end_header\n".length;
  const head = buf.subarray(0, end).toString("latin1")
    .replace(/^(format [^\n]*\n)/m, "$1comment offsetx 0\ncomment offsety 0\ncomment offsetz 0\ncomment epsg 32651\n" + (process.argv[2] ? `comment source ${process.argv[2]}\n` : ""));
  fs.writeFileSync(p, Buffer.concat([Buffer.from(head, "latin1"), buf.subarray(end)]));' -- "$1" "${2:-}"; }
georef "$SPLATS_ORIGINAL_DIR/as-ply/point_cloud.ply"
# coarse: a capture as a drone delivers it, every Gaussian an order of
# magnitude larger. main is 10³ = 1000 with a 0.3 m largest axis, so the
# typical size is 0.3 m and the limit 4 × that, 1.2 m; big is 4 × 4 × 8 = 128
# in a voxel of its own, 64 at 0.5 m (kept; revision 12's fixed 0.25 m
# removed them) and 64 at 2 m (removed). A .ply, so no codebook pools them.
# flown is coarse plus a clump of 8 beside it, as `comment source Drone`:
# the source decides nothing, so it is cut as any capture is. ground is the
# same file as `comment source L2Pro`. Both are written from coarse-clump.mjs.
cat > "$work/gen/coarse.mjs" <<'EOF2'
const extra = false; // true for flown and ground: the clump of 8
const rows = [];
const clump = (at, n, scaleOf) => {
  let k = 0;
  for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let l = 0; l < n[2]; l++, k++) {
    const scale = scaleOf(k);
    rows.push({
      x: at[0] + i * 0.01, y: at[1] + j * 0.01, z: at[2] + l * 0.01,
      scale_0: Math.log(scale[0]), scale_1: Math.log(scale[1]), scale_2: Math.log(scale[2]),
      rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
      f_dc_0: 0.5, f_dc_1: 0.5, f_dc_2: 0.5, opacity: 5,
    });
  }
};
clump([-29.5, -39.5, 0.5], [10, 10, 10], () => [0.3, 0.3, 0.02]);
clump([-29.5, -19.5, 0.5], [4, 4, 8], (k) => [k < 64 ? 0.5 : 2, 0.1, 0.02]);
if (extra) clump([-9.5, -39.5, 0.5], [2, 2, 2], () => [0.3, 0.3, 0.02]);
export class Generator {
  static create() {
    return { count: rows.length, columnNames: Object.keys(rows[0]), getRow: (i, row) => Object.assign(row, rows[i]) };
  }
}
EOF2
mkdir -p "$SPLATS_ORIGINAL_DIR/coarse"
splat-transform -q --no-tty -w "$work/gen/coarse.mjs" "$SPLATS_ORIGINAL_DIR/coarse/point_cloud.ply"
georef "$SPLATS_ORIGINAL_DIR/coarse/point_cloud.ply"
sed 's/^const extra = false;/const extra = true;/' "$work/gen/coarse.mjs" > "$work/gen/coarse-clump.mjs"
for d in flown:Drone ground:L2Pro; do
  mkdir -p "$SPLATS_ORIGINAL_DIR/${d%%:*}"
  splat-transform -q --no-tty -w "$work/gen/coarse-clump.mjs" "$SPLATS_ORIGINAL_DIR/${d%%:*}/point_cloud.ply"
  georef "$SPLATS_ORIGINAL_DIR/${d%%:*}/point_cloud.ply" "${d#*:}"
done
# spread: the typical size is taken over what the density cut keeps. main is
# 10³ = 1000, 600 with a 0.1 m largest axis and 400 with 0.3 m, so over it
# the median is 0.1 m and the limit 0.4 m. 50 clumps of 8 at 2 m, each in a
# voxel of its own, are removed by the density cut; over all 1400 the median
# would be 0.3 m and the limit 1.2 m.
cat > "$work/gen/spread.mjs" <<'EOF3'
const rows = [];
const clump = (at, n, scaleOf) => {
  let k = 0;
  for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let l = 0; l < n[2]; l++, k++) {
    const scale = scaleOf(k);
    rows.push({
      x: at[0] + i * 0.01, y: at[1] + j * 0.01, z: at[2] + l * 0.01,
      scale_0: Math.log(scale[0]), scale_1: Math.log(scale[1]), scale_2: Math.log(scale[2]),
      rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
      f_dc_0: 0.5, f_dc_1: 0.5, f_dc_2: 0.5, opacity: 5,
    });
  }
};
clump([-29.5, -39.5, 0.5], [10, 10, 10], (k) => [k < 600 ? 0.1 : 0.3, 0.05, 0.02]);
for (let c = 0; c < 50; c++) clump([0.5 + 4 * c, 0.5, 0.5], [2, 2, 2], () => [2, 0.05, 0.02]);
export class Generator {
  static create() {
    return { count: rows.length, columnNames: Object.keys(rows[0]), getRow: (i, row) => Object.assign(row, rows[i]) };
  }
}
EOF3
mkdir -p "$SPLATS_ORIGINAL_DIR/spread"
splat-transform -q --no-tty -w "$work/gen/spread.mjs" "$SPLATS_ORIGINAL_DIR/spread/point_cloud.ply"
georef "$SPLATS_ORIGINAL_DIR/spread/point_cloud.ply"
sed 's/^const only = Infinity;/const only = 1;/' "$work/gen/scene.mjs" > "$work/gen/main.mjs"
splat-transform -q --no-tty -w "$work/gen/main.mjs" "$SPLATS_ORIGINAL_DIR/both/point_cloud.ply"
cp "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog" "$SPLATS_ORIGINAL_DIR/both/"
# A generator is code; one in a scan folder must never be run.
cp "$work/gen/scene.mjs" "$SPLATS_ORIGINAL_DIR/code/point_cloud.mjs"
before=$(sum "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog")
out=$SPLATS_CLEAN_DIR/scene.ply

case_ "the density, size and floater cuts"
expect "the original has every clump" "$(count "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog")" 1475
log=$(process scene) || { echo "$log"; echo "process-splat.sh failed unexpectedly" >&2; exit 1; }
expect_contains "names the file it read" "$log" "==> scene (point_cloud.sog)"
expect_contains "in 1000 m voxels footprint pruning keeps every clump" "$log" "1475 gaussians; 1 groups in 1000 m voxels, largest 2 voxels; 1475 kept by footprint"
expect_contains "the typical voxel is main's, and both 8s go" "$log" "typical voxel holds 1000; 1459 kept by density"
expect "writes clean/<scan>.ply with main, c27, far and sizes less 64" "$(count "$out")" 1395
expect_contains "reports the size cut on its own" "$log" "1395 kept by size"
expect_contains "reports what it removed" "$log" "1395 kept after floaters; 80 removed in all (5.4%)"
expect_contains "skips the align step for a .sog" "$log" "align skipped: point_cloud.sog is not a point_cloud.ply"
expect "  and says so beside the .ply" "$(node -e 'const j = require(process.argv[1]); console.log(j.status, j.reason)' -- "$SPLATS_CLEAN_DIR/scene.align.json")" "skipped point_cloud.sog is not a point_cloud.ply"

case_ "the size limit follows the capture"
log=$(process scene)
expect_contains "the scene's typical size is 0.02 m, so the floor holds" "$log" "typical size 0.02 m; size limit 0.25 m"
if log=$(process coarse); then
  expect_contains "a coarse capture's limit is 4 × its 0.3 m" "$log" "typical size 0.3 m; size limit 1.2 m"
  expect "  so its 0.5 m Gaussians stay and its 2 m ones go" "$(count "$SPLATS_CLEAN_DIR/coarse.ply")" 1064
else
  bad "cleans a coarse capture" "$log"
fi
log=$(process coarse --scale-ratio 1)
expect_contains "at --scale-ratio 1 the limit is the typical size" "$log" "size limit 0.3 m"
expect "  and both sizes go" "$(count "$SPLATS_CLEAN_DIR/coarse.ply")" 1000
if log=$(process spread); then
  expect_contains "the typical size is taken after the density cut" "$log" "typical voxel holds 1000; 1000 kept by density"
  expect_contains "  so the floaters it removes do not shift it" "$log" "typical size 0.1 m; size limit 0.4 m"
else
  bad "cleans a capture with large floaters" "$log"
fi
rm -f "$SPLATS_CLEAN_DIR"/coarse.* "$SPLATS_CLEAN_DIR"/spread.*

case_ "a Drone capture is cut like any other"
if log=$(process flown); then
  expect_contains "runs both cuts" "$log" "typical voxel holds 1000; 1128 kept by density"
  expect "  so its clump of 8 and its 2 m Gaussians go" "$(count "$SPLATS_CLEAN_DIR/flown.ply")" 1064
  expect "  and its log names no aerial capture" "$(echo "$log" | grep -c 'aerial' || true)" 0
else
  bad "cleans a Drone capture" "$log"
fi
if log=$(process ground); then
  expect_contains "the same file as L2Pro has no module's files, so its align is skipped" "$log" "align skipped: no "
  expect_contains "  and it is cut" "$log" "typical voxel holds 1000; 1128 kept by density"
  expect "  as coarse is" "$(count "$SPLATS_CLEAN_DIR/ground.ply")" 1064
else
  bad "cleans the same file as L2Pro" "$log"
fi
rm -f "$SPLATS_CLEAN_DIR"/flown.* "$SPLATS_CLEAN_DIR"/ground.*

case_ "every coordinate negative"
if log=$(process mirror); then
  expect "keeps the same clumps" "$(count "$SPLATS_CLEAN_DIR/mirror.ply")" 1395
else
  bad "cleans a mirrored scan" "$log"
fi
rm -f "$SPLATS_CLEAN_DIR"/mirror.*

case_ "every format splat-transform can write"
for ext in "${formats[@]}"; do
  if log=$(process "as-$ext"); then
    expect "point_cloud.$ext gives the same counts" "$(count "$SPLATS_CLEAN_DIR/as-$ext.ply")" 1395
  else
    bad "cleans a point_cloud.$ext" "$log"
  fi
  rm -f "$SPLATS_CLEAN_DIR"/as-$ext.*
done

case_ "each cut alone"
process scene --max-scale 1 > /dev/null
expect "without the size cut the 0.5 m Gaussians stay" "$(count "$out")" 1459
process scene --min-density 0.03 > /dev/null
expect "at 0.03 a voxel needs 30, so c27 goes too" "$(count "$out")" 1368
log=$(process scene --cell 100)
# 100 m voxels put main, the sky clump and every clump near them in one voxel,
# and far's 216 still clears 1% of it: the cell is what tells a sky floater
# from the street below it.
expect_contains "in 100 m voxels the sky clump shares main's, and nothing goes" "$log" "1475 kept by density"

case_ "a scan's own config"
# configured is scene again, with a process_splat_config.json beside it that
# each case writes; flown-config is flown again.
mkdir -p "$SPLATS_ORIGINAL_DIR/configured" "$SPLATS_ORIGINAL_DIR/flown-config"
cp "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog" "$SPLATS_ORIGINAL_DIR/configured/"
cp "$SPLATS_ORIGINAL_DIR/flown/point_cloud.ply" "$SPLATS_ORIGINAL_DIR/flown-config/"
cfg=$SPLATS_ORIGINAL_DIR/configured/process_splat_config.json
cout=$SPLATS_CLEAN_DIR/configured.ply
log=$(plain configured)
expect_contains "with no config and no flag, every setting is a default" "$log" "    settings: defaults"
process configured > /dev/null
plain=$(sum "$cout")
echo '{"version": 1, "min_density": 0.03, "note": "c27 is noise here"}' > "$cfg"
cfg_sum=$(sum "$cfg")
log=$(process configured)
expect "the config's min_density removes c27, as the flag does" "$(count "$cout")" 1368
expect_contains "  the first line gives the value used" "$log" ">= 0.03 x typical"
expect_contains "  and the settings line names where each came from" "$log" "settings: config process_splat_config.json (min_density); flags (footprint_cell); defaults (cell, max_scale, scale_ratio, floaters)"
log=$(process configured --min-density 0.01)
expect "a flag wins over the config" "$(count "$cout")" 1395
expect_contains "  and is named as a flag" "$log" "settings: flags (footprint_cell, min_density); defaults (cell, max_scale, scale_ratio, floaters)"
log=$(process configured --max-scale 0.6)
expect_contains "config and flags are named together" "$log" "settings: config process_splat_config.json (min_density); flags (footprint_cell, max_scale); defaults (cell, scale_ratio, floaters)"
expect "the config file is never written" "$(sum "$cfg")" "$cfg_sum"
echo '{"version": 1, "max_scale": 0.6}' > "$cfg"
process configured > /dev/null
expect "the config's max_scale keeps the 0.5 m Gaussians" "$(count "$cout")" 1459
echo '{"version": 1, "floaters": {"size": 0.05, "opacity": 0.1, "min": 0.004}}' > "$cfg"
log=$(process configured)
expect "floaters at splat-transform's own values change nothing" "$(count "$cout")" 1395
expect_contains "  and reach -F as size,opacity,min" "$log" "floaters 0.05,0.1,0.004"
echo '{"version": 1, "cell": 0.0000001}' > "$cfg"
expect_contains "a tiny value is passed as a plain decimal, not 1e-7" "$(process configured --min-density 2 || true)" "density in 0.0000001 m voxels"
echo '{"version": 1}' > "$cfg"
process configured > /dev/null
expect "a config with only version gives the same output as none" "$(sum "$cout")" "$plain"
expect_contains "  and says defaults" "$(plain configured)" "    settings: defaults"
echo '{"version": 1, "floaters": {"size": 0.05, "opacity": 0, "min": 0.004}}' > "$cfg"
log=$(process configured)
expect_contains "a floaters part of 0 is accepted and reaches -F as 0" "$log" "floaters 0.05,0,0.004"
# Every bad file is refused, naming it, before anything in clean/ is touched.
process configured > /dev/null
kept=$(sum "$cout")
refused() {
  local label=$1 body=$2 want=$3; shift 3
  printf '%s' "$body" > "$cfg"
  if log=$(process configured "$@"); then bad "refuses $label" "it succeeded"; return; fi
  expect_contains "refuses $label" "$log" "error: $cfg: $want"
}
refused "a file that is not JSON"      '{"version": 1,'                          "not valid JSON"
refused "a JSON array"                 '[1]'                                     "must be a JSON object"
refused "a file with no version"       '{"cell": 2}'                             'has no "version"'
refused "version 2"                    '{"version": 2}'                          "has version 2"
refused "a misspelt key"               '{"version": 1, "min_densty": 0.02}'      'unknown key "min_densty"'
refused "a number written as a string" '{"version": 1, "min_density": "0.02"}'   '"min_density" must be a number, got "0.02"'
refused "a zero cell"                  '{"version": 1, "cell": 0}'               '"cell" must be a positive number of metres, got 0'
refused "a cell that writes as 0"      '{"version": 1, "cell": 1e-25}'           '"cell" must be a positive number of metres, got 1e-25'
refused "a negative ratio"             '{"version": 1, "scale_ratio": -1}'       '"scale_ratio" must be a positive number, got -1'
refused "floaters missing min"         '{"version": 1, "floaters": {"size": 0.05, "opacity": 0.1}}'                         '"floaters" must have exactly the keys'
refused "floaters with an extra key"   '{"version": 1, "floaters": {"size": 0.05, "opacity": 0.1, "min": 0.004, "x": 1}}'   '"floaters" must have exactly the keys'
refused "floaters as -F's string"      '{"version": 1, "floaters": "0.05,0.1,0.004"}'                                       '"floaters" must be an object'
refused "a negative floaters.opacity"  '{"version": 1, "floaters": {"size": 0.05, "opacity": -0.1, "min": 0.004}}'         '"floaters" must be three non-negative numbers size,opacity,min'
refused "a non-string note"            '{"version": 1, "note": 3}'               '"note" must be a string'
refused "a bad cell a flag overrides"  '{"version": 1, "cell": 0}'               '"cell" must be a positive number' --cell 2
refused "a skip that is not an array"  '{"version": 1, "skip": "size"}'          '"skip" must be an array of step names'
refused "a misspelt step"              '{"version": 1, "skip": ["floater"]}'     '"skip" names an unknown step "floater"'
refused "a step that is not a name"    '{"version": 1, "skip": [1]}'             '"skip" names an unknown step 1'
refused "a step named twice"           '{"version": 1, "skip": ["size", "size"]}' '"skip" names a step more than once'
refused "density skipped without size" '{"version": 1, "skip": ["density"]}'     '"skip" names "density" without "size"'
expect "  each leaves the previous output" "$(sum "$cout")" "$kept"
expect "  and no temporary file" "$(ls -A "$SPLATS_CLEAN_DIR" | grep -c '^\.' || true)" 0
rm -f "$cfg" "$SPLATS_CLEAN_DIR"/configured.*

case_ "a config's skipped steps"
cfg=$SPLATS_ORIGINAL_DIR/configured/process_splat_config.json
echo '{"version": 1, "skip": ["density", "size", "floaters"]}' > "$cfg"
if log=$(process configured); then
  expect "skipping every step keeps every Gaussian" "$(count "$cout")" 1475
  expect_contains "  names all three on the first line" "$log" "==> configured (point_cloud.sog): align, footprint in 1000 m voxels (largest 26-connected group), no density cut (skip), no size cut (skip), no floater pass (skip)"
  expect_contains "  and in place of the cuts' counts" "$log" "    density and size cuts skipped: process_splat_config.json"
  expect_contains "  and of the floater pass's" "$log" "1475 kept, floater pass skipped: process_splat_config.json; 0 removed in all (0.0%)"
  expect_contains "  and on the settings line" "$log" "    settings: flags (footprint_cell); skip (density, size, floaters)"
  expect "  still writes a binary little-endian PLY" "$(head -c 200 "$cout" | LC_ALL=C sed -n 2p)" "format binary_little_endian 1.0"
else
  bad "skips every step" "$log"
fi
echo '{"version": 1, "skip": ["density", "size"]}' > "$cfg"
if log=$(process configured); then
  expect "skipping both cuts keeps the clumps of 8 and the 0.5 m Gaussians" "$(count "$cout")" 1475
  expect_contains "  and the floater pass still runs" "$log" "no density cut (skip), no size cut (skip), floaters 0.05,0.1,0.004"
  expect_contains "  as the settings line says" "$log" "settings: flags (footprint_cell); defaults (floaters); skip (density, size)"
  expect_contains "  and reports it" "$log" "1475 kept after floaters"
else
  bad "skips both cuts" "$log"
fi
echo '{"version": 1, "skip": ["size"]}' > "$cfg"
if log=$(process configured); then
  expect "skipping the size cut removes the clumps of 8 and keeps the 0.5 m Gaussians" "$(count "$cout")" 1459
  expect_contains "  names it on the first line, between the cuts that run" "$log" "footprint in 1000 m voxels (largest 26-connected group), density in 2 m voxels >= 0.01 x typical, no size cut (skip), floaters 0.05,0.1,0.004"
  expect_contains "  reports the typical size" "$log" "    typical size 0.02 m"
  expect_contains "  and that the cut was skipped" "$log" "    size cut skipped: process_splat_config.json"
  expect "  and no limit" "$(echo "$log" | grep -c 'size limit' || true)" 0
else
  bad "skips the size cut" "$log"
fi
echo '{"version": 1, "skip": ["floaters"]}' > "$cfg"
if log=$(process configured); then
  expect "skipping the floater pass keeps what it would (the scene has no floaters)" "$(count "$cout")" 1395
  expect_contains "  and says it was skipped" "$log" "1395 kept, floater pass skipped: process_splat_config.json"
else
  bad "skips the floater pass" "$log"
fi
echo '{"version": 1, "skip": []}' > "$cfg"
process configured > /dev/null
expect "an empty skip gives the same output as no config" "$(sum "$cout")" "$plain"
expect_contains "  and says defaults" "$(plain configured)" "    settings: defaults"
echo '{"version": 1, "min_density": 0.5, "skip": ["density", "size"]}' > "$cfg"
if log=$(process configured --max-scale 0.6); then
  expect_contains "a skipped step's settings, from config and flag, are named unused" "$log" "settings: flags (footprint_cell); defaults (floaters); unused, skipped (min_density, max_scale); skip (density, size)"
  expect "  and have no effect" "$(count "$cout")" 1475
else
  bad "skips the cuts with their settings set" "$log"
fi
echo '{"version": 1, "skip": ["density", "size"]}' > "$SPLATS_ORIGINAL_DIR/flown-config/process_splat_config.json"
if log=$(process flown-config); then
  expect "a Drone capture skipping both cuts keeps the clump of 8 and the 2 m Gaussians" "$(count "$SPLATS_CLEAN_DIR/flown-config.ply")" 1136
else
  bad "skips both cuts on a Drone capture" "$log"
fi
rm -f "$cfg" "$SPLATS_CLEAN_DIR"/configured.* "$SPLATS_CLEAN_DIR"/flown-config.*

case_ "footprint pruning"
# footprint, in file coordinates: every voxel listed is a clump in the middle
# of a 1 m voxel (a grid 1 cm apart from 0.45 m past the metre), of 8 small
# Gaussians unless stated.
#   body   x = 0..5 at y = 0, z = 0 (face links), and (6, 1, 1), touching the
#          row's end at a corner only: 7 voxels, 56, one group only under
#          26-connectivity
#   dense  x = 11..13 at y = 0, z = 0, 125 each: 375, more Gaussians than
#          body but fewer voxels, so removed
#   speck  1 Gaussian alone at (0, 20, 0): removed
# tie: two rows of 3 voxels, at x = 0..2 and x = 10..12, of 8 and of `far`
# (27; 8 for tie8) each.
cat > "$work/gen/footprint.mjs" <<'EOF4'
const scene = 'footprint'; // or tie, tie8
const rows = [];
const voxel = (v, side) => {
  for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) for (let l = 0; l < side; l++) {
    rows.push({
      x: v[0] + 0.45 + i * 0.01, y: v[1] + 0.45 + j * 0.01, z: v[2] + 0.45 + l * 0.01,
      scale_0: Math.log(0.02), scale_1: Math.log(0.02), scale_2: Math.log(0.02),
      rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
      f_dc_0: 0.5, f_dc_1: 0.5, f_dc_2: 0.5, opacity: 5,
    });
  }
};
if (scene === 'footprint') {
  for (let x = 0; x <= 5; x++) voxel([x, 0, 0], 2);
  voxel([6, 1, 1], 2);
  for (let x = 11; x <= 13; x++) voxel([x, 0, 0], 5);
  voxel([0, 20, 0], 1);
} else {
  for (let x = 0; x <= 2; x++) voxel([x, 0, 0], 2);
  for (let x = 10; x <= 12; x++) voxel([x, 0, 0], scene === 'tie' ? 3 : 2);
}
export class Generator {
  static create() {
    return { count: rows.length, columnNames: Object.keys(rows[0]), getRow: (i, row) => Object.assign(row, rows[i]) };
  }
}
EOF4
for sc in footprint tie tie8; do
  mkdir -p "$SPLATS_ORIGINAL_DIR/$sc"
  sed "s/^const scene = 'footprint';/const scene = '$sc';/" "$work/gen/footprint.mjs" > "$work/gen/fp-$sc.mjs"
  splat-transform -q --no-tty -w "$work/gen/fp-$sc.mjs" "$SPLATS_ORIGINAL_DIR/$sc/point_cloud.ply"
  georef "$SPLATS_ORIGINAL_DIR/$sc/point_cloud.ply"
  # The later cuts are skipped, so the output is what footprint pruning kept.
  echo '{"version": 1, "skip": ["density", "size", "floaters"]}' > "$SPLATS_ORIGINAL_DIR/$sc/process_splat_config.json"
done
fout=$SPLATS_CLEAN_DIR/footprint.ply
fcfg=$SPLATS_ORIGINAL_DIR/footprint/process_splat_config.json
expect "the footprint scene has every clump" "$(count "$SPLATS_ORIGINAL_DIR/footprint/point_cloud.ply")" 432
if log=$(plain footprint); then
  expect_contains "names the step and its cell on the first line" "$log" "align, footprint in 1 m voxels (largest 26-connected group), no density cut (skip)"
  expect_contains "finds 3 groups and keeps the 7 voxels of body" "$log" "432 gaussians; 3 groups in 1 m voxels, largest 7 voxels; 56 kept by footprint"
  expect "  so the output is body alone, its corner voxel included" "$(count "$fout")" 56
  expect "  the corner voxel is there" "$(splat-transform -q --no-tty "$fout" -V z,gt,1 --info json null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).numGaussians));')" 8
  expect_contains "  and the settings line names the default" "$log" "settings: defaults; skip (density, size, floaters)"
else
  bad "prunes the footprint scene" "$log"
fi
if log=$(plain footprint --footprint-cell 10); then
  expect_contains "10 m voxels join body and dense; the speck stays alone" "$log" "2 groups in 10 m voxels, largest 2 voxels; 431 kept by footprint"
  expect "  and both are kept" "$(count "$fout")" 431
  expect_contains "  the flag is named" "$log" "settings: flags (footprint_cell); skip (density, size, floaters)"
else
  bad "prunes in 10 m voxels" "$log"
fi
echo '{"version": 1, "footprint_cell": 10, "skip": ["density", "size", "floaters"]}' > "$fcfg"
if log=$(plain footprint); then
  expect "the config's footprint_cell acts as the flag does" "$(count "$fout")" 431
  expect_contains "  and is named as from the config" "$log" "settings: config process_splat_config.json (footprint_cell); skip (density, size, floaters)"
else
  bad "takes footprint_cell from the config" "$log"
fi
echo '{"version": 1, "skip": ["footprint", "density", "size", "floaters"]}' > "$fcfg"
if log=$(plain footprint); then
  expect "skipping footprint keeps every Gaussian" "$(count "$fout")" 432
  expect_contains "  names it on the first line" "$log" "align, no footprint pruning (skip), no density cut (skip)"
  expect_contains "  and in place of its count" "$log" "432 gaussians; footprint pruning skipped: process_splat_config.json"
  expect_contains "  and every step skipped leaves no setting in use" "$log" "    settings: skip (footprint, density, size, floaters)"
else
  bad "skips footprint pruning" "$log"
fi
echo '{"version": 1, "skip": ["footprint"]}' > "$fcfg"
if log=$(plain footprint); then
  expect_contains "footprint may be skipped alone; the density cut then counts first" "$log" "432 gaussians; footprint pruning skipped"
  expect_contains "  and the density cut runs" "$log" "kept by density"
  expect "  and the density line does not repeat the count" "$(printf '%s\n' "$log" | grep -cE '^    typical voxel holds [0-9]+; [0-9]+ kept by density$')" 1
else
  bad "skips footprint pruning alone" "$log"
fi
if log=$(plain tie); then
  expect "a tie on voxels goes to the group with more Gaussians" "$(count "$SPLATS_CLEAN_DIR/tie.ply")" 81
else
  bad "breaks a tie by Gaussians" "$log"
fi
if log=$(plain tie8); then
  expect "a full tie goes to the group at the lower x" "$(splat-transform -q --no-tty "$SPLATS_CLEAN_DIR/tie8.ply" -V x,lt,5 --info json null 2> /dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => console.log(s ? JSON.parse(s).numGaussians : 0));')" 24
else
  bad "breaks a full tie by position" "$log"
fi
echo '{"version": 1, "skip": ["density", "size", "floaters"]}' > "$fcfg"
plain footprint > /dev/null
fkept=$(sum "$fout")
for v in 0 -1; do
  if log=$(plain footprint --footprint-cell "$v"); then bad "refuses --footprint-cell $v" "it succeeded"; else expect_contains "refuses --footprint-cell $v" "$log" "--footprint-cell must be a positive number of metres, got '$v'"; fi
done
echo '{"version": 1, "footprint_cell": 0}' > "$fcfg"
if log=$(plain footprint); then bad "refuses a zero footprint_cell" "it succeeded"; else expect_contains "refuses a zero footprint_cell" "$log" "\"footprint_cell\" must be a positive number of metres, got 0"; fi
echo '{"version": 1, "footprint_cell": "1"}' > "$fcfg"
if log=$(plain footprint); then bad "refuses a footprint_cell string" "it succeeded"; else expect_contains "refuses a footprint_cell string" "$log" "\"footprint_cell\" must be a number, got \"1\""; fi
expect "  each leaves the previous output" "$(sum "$fout")" "$fkept"
# no-gaussians: the footprint scene's header, with no Gaussians after it.
mkdir -p "$SPLATS_ORIGINAL_DIR/no-gaussians"
node -e '
  const fs = require("fs"), buf = fs.readFileSync(process.argv[1]);
  const end = buf.indexOf("end_header\n") + "end_header\n".length;
  fs.writeFileSync(process.argv[2], buf.subarray(0, end).toString("latin1").replace(/element vertex \d+/, "element vertex 0"), "latin1");' \
  -- "$SPLATS_ORIGINAL_DIR/footprint/point_cloud.ply" "$SPLATS_ORIGINAL_DIR/no-gaussians/point_cloud.ply"
if log=$(plain no-gaussians); then bad "refuses an empty capture" "it succeeded"; else
  expect_contains "refuses a capture with no Gaussians" "$log" "error: no-gaussians: the capture has no Gaussians; $SPLATS_CLEAN_DIR/no-gaussians.ply is unchanged"
  expect "  and writes no output" "$(ls "$SPLATS_CLEAN_DIR"/no-gaussians.* 2> /dev/null | wc -l | tr -d ' ')" 0
fi
rm -rf "$SPLATS_ORIGINAL_DIR/no-gaussians"
rm -f "$SPLATS_CLEAN_DIR"/footprint.* "$SPLATS_CLEAN_DIR"/tie.* "$SPLATS_CLEAN_DIR"/tie8.*

case_ "the output"
process scene > /dev/null
expect "is a binary little-endian PLY" "$(head -c 200 "$out" | LC_ALL=C sed -n 2p)" "format binary_little_endian 1.0"
expect "  with every property the mosaic reads, as floats" "$(node --input-type=module -e '
  import { layout } from "./scripts/ply-header.mjs";
  const L = await layout(process.argv[1], "out");
  const want = ["x","y","z","f_dc_0","f_dc_1","f_dc_2","opacity","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3"];
  console.log(want.every((p) => L.props.get(p)?.type === "float"), L.count);' -- "$out")" "true 1395"
expect "leaves the original as it was" "$(sum "$SPLATS_ORIGINAL_DIR/scene/point_cloud.sog")" "$before"
process scene > /dev/null
expect "a re-run starts from the original" "$(count "$out")" 1395
# The working directory is gone by exit, so a shim in front of splat-transform
# lists clean/ while the script runs.
mkdir -p "$work/shim"
cat > "$work/shim/splat-transform" <<EOF
#!/usr/bin/env bash
ls -A "\$SPLATS_CLEAN_DIR" >> "$work/seen"
exec $(command -v splat-transform) "\$@"
EOF
chmod +x "$work/shim/splat-transform"
PATH=$work/shim:$PATH ./scripts/process-splat.sh scene > /dev/null 2>&1
if grep -q '^\.process-' "$work/seen"; then ok "works in clean/.process-*"; else bad "works in clean/.process-*" "saw: $(sort -u "$work/seen" | tr '\n' ' ')"; fi

case_ "refusals"
kept=$(sum "$out")
if log=$(process scene --min-density 2); then bad "fails when nothing is left" "it succeeded"; else ok "fails when nothing is left"; fi
expect_contains "  says so"                     "$log" "remove every Gaussian"
expect "  leaves the previous output"           "$(sum "$out")" "$kept"
expect "  leaves no temporary file"             "$(ls -A "$SPLATS_CLEAN_DIR" | tr '\n' ' ')" "scene.align.json scene.ply "
if log=$(process absent); then bad "refuses a missing scan" "it succeeded"; else expect_contains "refuses a missing scan" "$log" "'absent' is not a scan folder in"; fi
if log=$(process empty); then bad "refuses a scan with no splat" "it succeeded"; else expect_contains "refuses a scan with no splat" "$log" "'empty' has no point_cloud.<ext>"; fi
if log=$(process both); then bad "refuses two splats" "it succeeded"; else expect_contains "refuses two splats, naming both" "$log" "more than one splat: point_cloud.ply point_cloud.sog"; fi
if log=$(process code); then bad "refuses a point_cloud.mjs" "it succeeded"; else expect_contains "refuses a point_cloud.mjs, never running it" "$log" "'code' has no point_cloud.<ext>"; fi
if log=$(process ../original/scene); then bad "refuses a path" "it succeeded"; else expect_contains "refuses a path" "$log" "must be a bare scan folder name"; fi
if log=$(process scene --cell 0); then bad "refuses a zero cell" "it succeeded"; else expect_contains "refuses a zero cell" "$log" "--cell must be a positive number"; fi
if log=$(process scene --min-density -1); then bad "refuses a negative density" "it succeeded"; else expect_contains "refuses a negative density" "$log" "--min-density must be a positive fraction"; fi
if log=$(process scene --max-scale 0); then bad "refuses a zero size" "it succeeded"; else expect_contains "refuses a zero size" "$log" "--max-scale must be a positive number"; fi
if log=$(process scene --scale-ratio 0); then bad "refuses a zero ratio" "it succeeded"; else expect_contains "refuses a zero ratio" "$log" "--scale-ratio must be a positive number"; fi
if log=$(process scene --scale-ratio -2); then bad "refuses a negative ratio" "it succeeded"; else expect_contains "refuses a negative ratio" "$log" "--scale-ratio must be a positive number"; fi
for f in 0.05,0.1 0.05,-0.1,0.004 a,b,c; do
  if log=$(process scene --floaters "$f"); then bad "refuses --floaters $f" "it succeeded"; else expect_contains "refuses --floaters $f" "$log" "--floaters must be three non-negative numbers size,opacity,min, got '$f'"; fi
done
# The density step is written against 3.10's library, so another version is
# refused before anything runs.
mkdir -p "$work/old"
printf '#!/usr/bin/env bash\necho "splat-transform v3.4.0"\n' > "$work/old/splat-transform"
chmod +x "$work/old/splat-transform"
if log=$(PATH=$work/old:$PATH process scene); then bad "refuses another splat-transform version" "it succeeded"; else expect_contains "refuses another splat-transform version" "$log" "needs splat-transform 3.10.x, found 'splat-transform v3.4.0'"; fi

# Scans with everything the align step reads, from splat-align-scene.mjs (its
# own suite, test/splat-align.sh, tests the step itself). nomap is unreliable
# without its map_config.json: the same point_cloud.ply, byte for byte.
case_ "the align step"
node test/splat-align-scene.mjs -- "$SPLATS_ORIGINAL_DIR/aligned" '{"shift":[0.4,0.3,0],"turnDeg":0.3}'
node test/splat-align-scene.mjs -- "$SPLATS_ORIGINAL_DIR/unreliable" '{"lidar":"random"}'
node test/splat-align-scene.mjs -- "$SPLATS_ORIGINAL_DIR/nomap" '{"lidar":"random","omit":["map_config.json","gnss.csv"]}'
node test/splat-align-scene.mjs -- "$SPLATS_ORIGINAL_DIR/nometa" '{"omit":["metadata.json"]}'
node test/splat-align-scene.mjs -- "$SPLATS_ORIGINAL_DIR/drone" '{"source":"Drone","omit":["gnss.csv","poses.csv","octree.bin","metadata.json","map_config.json"]}'
node test/splat-align-scene.mjs -- "$SPLATS_ORIGINAL_DIR/l3" '{"l3":true,"shift":[0.4,0.3,0],"turnDeg":0.3}'
status_of() { node -e 'console.log(require(process.argv[1]).status)' -- "$SPLATS_CLEAN_DIR/$1.align.json"; }
if log=$(plain aligned); then
  expect_contains "aligns a scan with every file" "$log" "align corrected: moved up to"
  expect "  and records it beside the .ply" "$(status_of aligned)" corrected
  # The cuts read the aligned file. The scene's end walls are at x = ±20 m;
  # misplaced, one sits at 20.4 m, so ~10,000 Gaussians lie past 20.2 m on
  # one side or the other. Put back, only the haze (which was never
  # misplaced, so the correction moves it) is past. Both sides are counted:
  # which sign -V sees is the trap the CLAUDE.md notes, and does not matter.
  beyond() {
    local n total=0 side
    for side in x,gt,20.2 x,lt,-20.2; do
      n=$(splat-transform -q --no-tty "$1" -V "$side" --info json null 2> /dev/null | node -e '
        let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => console.log(s ? JSON.parse(s).numGaussians : 0));')
      total=$((total + n))
    done
    echo "$total"
  }
  expect "  the misplaced original has its wall past 20.2 m" "$(( $(beyond "$SPLATS_ORIGINAL_DIR/aligned/point_cloud.ply") > 9000 ))" 1
  expect "  the cleaned capture has it back at 20 m" "$(( $(beyond "$SPLATS_CLEAN_DIR/aligned.ply") < 200 ))" 1
else
  bad "aligns a scan with every file" "$log"
fi
if log=$(plain unreliable); then
  ok "a failed validation does not fail the run"
  expect_contains "  prints the error, naming the scan and the reason" "$log" "error: unreliable: align failed (ICP inliers"
  expect_contains "  and carries on unaligned" "$log" "continuing unaligned"
  expect "  records the failure" "$(status_of unreliable)" fail
else
  bad "a failed validation does not fail the run" "$log"
fi
log=$(plain nomap)
expect_contains "skips a scan missing files, naming them" "$log" "align skipped: no gnss.csv, map_config.json"
expect "  and records it" "$(status_of nomap)" skipped
log=$(plain nometa)
expect_contains "skips an L2 Pro scan without metadata.json" "$log" "align skipped: no metadata.json"
if log=$(plain drone); then
  expect_contains "cleans a Drone scan, skipping align" "$log" "align skipped: no scanner module for source 'Drone'"
  expect_contains "  and cuts it as any capture" "$log" "kept by density"
  expect "  and records it" "$(status_of drone)" skipped
else
  bad "cleans a Drone scan, skipping align" "$log"
fi
if log=$(plain l3); then
  expect_contains "aligns an L3 scan (metadata.oct)" "$log" "align corrected: moved up to"
else
  bad "aligns an L3 scan (metadata.oct)" "$log"
fi
expect "a failed align serves what a skipped one does" "$(sum "$SPLATS_CLEAN_DIR/unreliable.ply")" "$(sum "$SPLATS_CLEAN_DIR/nomap.ply")"

case_ "run from outside infra/"
# Without the overrides, the default folders are found from the script's own
# location, not the working directory. A missing scan is refused before
# anything is written, so data/ is only read.
if log=$(here=$PWD; cd "$work" && env -u SPLATS_ORIGINAL_DIR -u SPLATS_CLEAN_DIR "$here/scripts/process-splat.sh" no-such-scan 2>&1); then bad "finds infra/data from elsewhere" "it succeeded"; else expect_contains "finds infra/data from elsewhere" "$log" "not a scan folder in $PWD/data/3dgs/original"; fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
