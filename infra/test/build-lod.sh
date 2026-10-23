#!/usr/bin/env bash
# The LoD builder's test suite.
#
# Runs the real build-lod.sh against a capture generated here — written with
# splat-transform's .mjs generator input and saved as <scan>.spz — in a scratch
# directory, so no binary fixture is checked in and data/ is never touched.
# Needs Docker, as the script does, and splat-transform to make the capture;
# no database. The first run builds Spark's build-lod (about a minute).
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
export SPLATS_SOURCE_DIR=$work/source SPLATS_LOD_DIR=$work/lod
mkdir -p "$SPLATS_SOURCE_DIR" "$work/gen"

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
splat-transform -q --no-tty -w "$work/gen/grid.mjs" --spz-version 3 "$SPLATS_SOURCE_DIR/grid.spz"
before=$(sum "$SPLATS_SOURCE_DIR/grid.spz")
out=$SPLATS_LOD_DIR/grid-lod.rad

# Reads the header: RAD0, a little-endian u32 length, then that much JSON.
meta() { node -e '
  const b = require("fs").readFileSync(process.argv[1]);
  const m = JSON.parse(b.toString("utf8", 8, 8 + b.readUInt32LE(4)));
  console.log(eval(process.argv[2]));' -- "$1" "$2"; }
# The header's chunk files, one per line.
chunks() { meta "$out" 'm.chunks.map((c) => c.filename).join("\n")'; }
# Everything in lod/ but the dot-free names of other scans planted below.
listing() { ls -A "$SPLATS_LOD_DIR" | grep -v -e '^other' -e '^grid-lod-1-lod' | sort; }

# Another scan's tree, and one whose name starts with this one's: a rebuild of
# grid must touch neither.
for f in other-lod.rad other-lod-0.radc grid-lod-1-lod.rad grid-lod-1-lod-0.radc; do
  mkdir -p "$SPLATS_LOD_DIR" && echo "another scan's" > "$SPLATS_LOD_DIR/$f"
done

case_ "the tree"
log=$(build grid) || { echo "$log"; echo "build-lod.sh failed unexpectedly" >&2; exit 1; }
expect "writes lod/<scan>-lod.rad"              "$([ -s "$out" ] && echo yes)" yes
expect "  a RAD header"                         "$(head -c 4 "$out")" RAD0
expect "  of an LoD tree, at least the input's splats" "$(meta "$out" 'm.lodTree === true && m.count >= 108000')" true
expect "  in more than one chunk"               "$(meta "$out" 'm.chunks.length > 1')" true
expect "  each a file, <scan>-lod-<n>.radc"     "$(meta "$out" 'm.chunks.every((c, i) => c.filename === `grid-lod-${i}.radc`)')" true
missing=""
while IFS= read -r c; do [ -s "$SPLATS_LOD_DIR/$c" ] || missing="$missing $c"; done < <(chunks)
expect "  every chunk it names is in lod/, non-empty" "$missing" ""
expect_contains "reports the counts"            "$log" "108000 splats → "
expect_contains "  and the chunks"              "$log" "$(chunks | wc -l | tr -d ' ') chunks"
expect "leaves the source as it was"            "$(sum "$SPLATS_SOURCE_DIR/grid.spz")" "$before"
expect "leaves nothing in lod/ but the header and its chunks" "$(listing)" "$( (echo grid-lod.rad; chunks) | sort)"
expect "leaves other scans' trees alone"        "$(cat "$SPLATS_LOD_DIR"/other-lod-0.radc "$SPLATS_LOD_DIR"/grid-lod-1-lod-0.radc | sort -u)" "another scan's"

# The header records how long the build took, so a re-run is not byte for byte
# the same file; the tree is.
first=$(meta "$out" m.count)
echo stale > "$SPLATS_LOD_DIR/grid-lod-99.radc"
build grid > /dev/null
expect "a re-run replaces the tree with the same one" "$(meta "$out" m.count)" "$first"
expect "  and removes a stale chunk past the new count" "$([ -e "$SPLATS_LOD_DIR/grid-lod-99.radc" ] && echo kept || echo removed)" removed
expect "  leaving the header and its chunks"    "$(listing)" "$( (echo grid-lod.rad; chunks) | sort)"
expect "  and other scans' trees"               "$(ls "$SPLATS_LOD_DIR" | grep -c -e '^other' -e '^grid-lod-1-lod')" 4

case_ "refusals"
if log=$(build absent); then bad "refuses a missing scan" "it succeeded"; else expect_contains "refuses a missing scan" "$log" "'absent' has no absent.spz in"; fi
if log=$(build ../source/grid); then bad "refuses a path" "it succeeded"; else expect_contains "refuses a path" "$log" "must be a bare scan name"; fi
if log=$(build -x); then bad "refuses an option for a scan" "it succeeded"; else expect_contains "refuses an option for a scan" "$log" "must be a bare scan name"; fi
if log=$(build); then bad "refuses no scan" "it succeeded"; else expect_contains "refuses no scan" "$log" "usage:"; fi
# Without the overrides, the default folders are found from the script's own
# location, not the working directory. A missing scan is refused before
# anything is written, so data/ is only read.
if log=$(here=$PWD; cd "$work" && env -u SPLATS_SOURCE_DIR -u SPLATS_LOD_DIR "$here/scripts/build-lod.sh" no-such-scan 2>&1); then bad "finds infra/data from elsewhere" "it succeeded"; else expect_contains "finds infra/data from elsewhere" "$log" "no no-such-scan.spz in $PWD/data/3dgs/source"; fi
echo "not a splat" > "$SPLATS_SOURCE_DIR/junk.spz"
if log=$(build junk); then bad "fails on a file build-lod cannot read" "it succeeded"; else expect_contains "fails on a file build-lod cannot read" "$log" "junk: build-lod wrote no junk-lod.rad"; fi
expect "  leaves no output or temporary"        "$(listing)" "$( (echo grid-lod.rad; chunks) | sort)"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
