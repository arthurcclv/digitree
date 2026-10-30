#!/usr/bin/env bash
# The LoD builder's test suite.
#
# Runs the real build-lod.sh against tiles generated here — written with
# splat-transform's .mjs generator input and saved as <tile>.ply, as the
# mosaic writes them — in a scratch directory, so no binary fixture is checked
# in and data/ is never touched. Needs Docker, as the script does, and
# splat-transform to make the tiles; no database. The first run builds Spark's
# build-lod (about a minute).
#
#   ./test/build-lod.sh   # from infra/; test/run.sh also runs it
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

for tool in splat-transform docker node; do
  command -v "$tool" > /dev/null || { echo "error: $tool is not on PATH" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export SPLATS_TILES_DIR=$work/tiles SPLATS_LOD_DIR=$work/lod
mkdir -p "$SPLATS_TILES_DIR" "$work/gen"

sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
build() { ./scripts/build-lod.sh "$@" 2>&1; }

# A 60 × 60 × 30 grid of 108,000 small Gaussians, 0.5 m apart: a tree with
# levels above its leaves, in more than one 64K-splat chunk.
cat > "$work/gen/grid.mjs" <<'EOF'
const rows = [];
for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) for (let k = 0; k < 30; k++) {
  rows.push({
    x: i * 0.5, y: j * 0.5, z: k * 0.5,
    scale_0: Math.log(0.1), scale_1: Math.log(0.1), scale_2: Math.log(0.1),
    rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
    f_dc_0: 0.5, f_dc_1: 0.5, f_dc_2: 0.5, opacity: 5,
  });
}
export class Generator {
  static create() {
    return { count: rows.length, columnNames: Object.keys(rows[0]), getRow: (i, row) => Object.assign(row, rows[i]) };
  }
}
EOF
splat-transform -q --no-tty -w "$work/gen/grid.mjs" "$SPLATS_TILES_DIR/grid.ply"
before=$(sum "$SPLATS_TILES_DIR/grid.ply")
out=$SPLATS_LOD_DIR/grid-lod.rad

# Reads the header: RAD0, a little-endian u32 length, then that much JSON.
meta() { node -e '
  const b = require("fs").readFileSync(process.argv[1]);
  const m = JSON.parse(b.toString("utf8", 8, 8 + b.readUInt32LE(4)));
  console.log(eval(process.argv[2]));' -- "$1" "$2"; }
# The header's chunk files, one per line.
chunks() { meta "$out" 'm.chunks.map((c) => c.filename).join("\n")'; }
# Everything in lod/ but the dot-free names of other tiles planted below.
listing() { ls -A "$SPLATS_LOD_DIR" | grep -v -e '^other' -e '^grid-lod-1-lod' | sort; }

# Another tile's tree, and one whose name starts with this one's: a rebuild of
# grid must touch neither. Neither has a tile in tiles/, so --all removes both.
for f in other-lod.rad other-lod-0.radc grid-lod-1-lod.rad grid-lod-1-lod-0.radc; do
  mkdir -p "$SPLATS_LOD_DIR" && echo "another tile's" > "$SPLATS_LOD_DIR/$f"
done

case_ "the tree"
log=$(build grid) || { echo "$log"; echo "build-lod.sh failed unexpectedly" >&2; exit 1; }
expect "reads tiles/<tile>.ply, and writes lod/<tile>-lod.rad"              "$([ -s "$out" ] && echo yes)" yes
expect "  a RAD header"                         "$(head -c 4 "$out")" RAD0
expect "  of an LoD tree, at least the input's splats" "$(meta "$out" 'm.lodTree === true && m.count >= 108000')" true
expect "  in more than one chunk"               "$(meta "$out" 'm.chunks.length > 1')" true
expect "  each a file, <tile>-lod-<n>.radc"     "$(meta "$out" 'm.chunks.every((c, i) => c.filename === `grid-lod-${i}.radc`)')" true
missing=""
while IFS= read -r c; do [ -s "$SPLATS_LOD_DIR/$c" ] || missing="$missing $c"; done < <(chunks)
expect "  every chunk it names is in lod/, non-empty" "$missing" ""
expect_contains "reports the counts"            "$log" "108000 splats → "
expect_contains "  and the chunks"              "$log" "$(chunks | wc -l | tr -d ' ') chunks"
expect "leaves the tile as it was"              "$(sum "$SPLATS_TILES_DIR/grid.ply")" "$before"
expect "leaves nothing in lod/ but the header and its chunks" "$(listing)" "$( (echo grid-lod.rad; chunks) | sort)"
expect "leaves other tiles' trees alone"        "$(cat "$SPLATS_LOD_DIR"/other-lod-0.radc "$SPLATS_LOD_DIR"/grid-lod-1-lod-0.radc | sort -u)" "another tile's"

# The header records how long the build took, so a re-run is not byte for byte
# the same file; the tree is.
first=$(meta "$out" m.count)
echo stale > "$SPLATS_LOD_DIR/grid-lod-99.radc"
build grid > /dev/null
expect "a re-run replaces the tree with the same one" "$(meta "$out" m.count)" "$first"
expect "  and removes a stale chunk past the new count" "$([ -e "$SPLATS_LOD_DIR/grid-lod-99.radc" ] && echo kept || echo removed)" removed
expect "  leaving the header and its chunks"    "$(listing)" "$( (echo grid-lod.rad; chunks) | sort)"
expect "  and other tiles' trees"               "$(ls "$SPLATS_LOD_DIR" | grep -c -e '^other' -e '^grid-lod-1-lod')" 4

case_ "several tiles, and --all"
# A second, smaller tile: one chunk.
sed 's/i < 60; i++) for (let j = 0; j < 60/i < 10; i++) for (let j = 0; j < 10/' "$work/gen/grid.mjs" > "$work/gen/small.mjs"
splat-transform -q --no-tty -w "$work/gen/small.mjs" "$SPLATS_TILES_DIR/small.ply"
log=$(build grid small) || { echo "$log"; echo "build-lod.sh failed unexpectedly" >&2; exit 1; }
expect "builds every tile it is given"          "$([ -s "$SPLATS_LOD_DIR/grid-lod.rad" ] && [ -s "$SPLATS_LOD_DIR/small-lod.rad" ] && echo yes)" yes
expect "  and still leaves other tiles' trees"  "$(ls "$SPLATS_LOD_DIR" | grep -c -e '^other' -e '^grid-lod-1-lod')" 4
log=$(build --all) || { echo "$log"; echo "build-lod.sh --all failed unexpectedly" >&2; exit 1; }
expect_contains "--all builds every tile in tiles/" "$log" "2 tiles built"
expect "  and removes the trees of tiles not in tiles/" "$(ls "$SPLATS_LOD_DIR" | grep -c -e '^other' -e '^grid-lod-1-lod')" 0
expect_contains "  saying how many files"       "$log" "4 files of tiles no longer in"
small_chunks=$(meta "$SPLATS_LOD_DIR/small-lod.rad" 'm.chunks.map((c) => c.filename).join("\n")')
expect "  leaving only the tiles' headers and chunks" "$(ls -A "$SPLATS_LOD_DIR" | sort)" "$( (echo grid-lod.rad; chunks; echo small-lod.rad; echo "$small_chunks") | sort)"
rm "$SPLATS_TILES_DIR/small.ply" "$SPLATS_LOD_DIR"/small-lod*

case_ "refusals"
if log=$(build absent); then bad "refuses a missing tile" "it succeeded"; else expect_contains "refuses a missing tile" "$log" "'absent' has no absent.ply in"; fi
if log=$(build grid absent); then bad "refuses a missing tile among others" "it succeeded"; else expect_contains "refuses a missing tile among others, before building any" "$log" "'absent' has no absent.ply in"; fi
if log=$(build ../tiles/grid); then bad "refuses a path" "it succeeded"; else expect_contains "refuses a path" "$log" "must be a bare tile name"; fi
if log=$(build -x); then bad "refuses an option for a tile" "it succeeded"; else expect_contains "refuses an option for a tile" "$log" "must be a bare tile name"; fi
if log=$(build); then bad "refuses no tile" "it succeeded"; else expect_contains "refuses no tile" "$log" "usage:"; fi
if log=$(build --all grid); then bad "refuses --all with a tile" "it succeeded"; else expect_contains "refuses --all with a tile" "$log" "usage:"; fi
if log=$(SPLATS_TILES_DIR=$work/none build --all); then bad "refuses --all with no tiles" "it succeeded"; else expect_contains "refuses --all with no tiles" "$log" "no tiles in $work/none"; fi
# Without the overrides, the default folders are found from the script's own
# location, not the working directory. A missing tile is refused before
# anything is written, so data/ is only read.
if log=$(here=$PWD; cd "$work" && env -u SPLATS_TILES_DIR -u SPLATS_LOD_DIR "$here/scripts/build-lod.sh" no-such-tile 2>&1); then bad "finds infra/data from elsewhere" "it succeeded"; else expect_contains "finds infra/data from elsewhere" "$log" "no no-such-tile.ply in $PWD/data/3dgs/tiles"; fi
echo "not a splat" > "$SPLATS_TILES_DIR/junk.ply"
if log=$(build junk); then bad "fails on a file build-lod cannot read" "it succeeded"; else expect_contains "fails on a file build-lod cannot read" "$log" "junk: build-lod wrote no junk-lod.rad"; fi
expect "  leaves no output or temporary"        "$(listing)" "$( (echo grid-lod.rad; chunks) | sort)"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
