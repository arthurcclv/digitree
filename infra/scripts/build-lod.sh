#!/usr/bin/env bash
# Build the mosaic's tiles' level-of-detail trees, as the chunked .rad the app
# streams: a header and one .radc file per chunk, per tile.
#
#   ./scripts/build-lod.sh 32651-352600-2770000   # tiles/<tile>.ply → lod/<tile>-lod.rad + -lod-<n>.radc
#   ./scripts/build-lod.sh --all                  # every tile, then lod/ pruned to them
#
# Reads data/3dgs/tiles/<tile>.ply, which it never writes, and writes
# data/3dgs/lod/<tile>-lod.rad and <tile>-lod-<n>.radc, which the files service
# serves at /3dgs-lod/. Spark's build-lod reads the .ply itself: nothing
# converts it first.
# The tool is Spark's own build-lod, at the version the app's Spark reads,
# built and run in a pinned Rust image: nothing but Docker is needed on the
# host. The spec is specs/build-lod.md.
set -euo pipefail

infra=$(cd "$(dirname "$0")/.." && pwd)
tiles_dir=${SPLATS_TILES_DIR:-$infra/data/3dgs/tiles}
lod_dir=${SPLATS_LOD_DIR:-$infra/data/3dgs/lod}

# The .rad format is read by the app's Spark, so the writer is held to the same
# version: app/package.json pins @sparkjsdev/spark at exactly this.
spark_tag=v2.3.1
rust_image=rust:1.88-bookworm
# The compiled tool and cargo's downloads persist here between runs, so only
# the first run builds (about a minute).
cache_volume=splat-build-lod-$spark_tag

die() { echo "error: $*" >&2; exit 1; }
usage() { echo "usage: $0 <tile>... | --all" >&2; exit 2; }

[ $# -ge 1 ] || usage
all=0
tiles=()
if [ "$1" = --all ]; then
  [ $# -eq 1 ] || usage
  all=1
  if [ -d "$tiles_dir" ]; then
    for f in "$tiles_dir"/*.ply; do
      [ -f "$f" ] && tiles+=("$(basename "$f" .ply)")
    done
  fi
  [ ${#tiles[@]} -gt 0 ] || die "no tiles in $tiles_dir (run node scripts/splat-mosaic.mjs first)"
else
  tiles=("$@")
fi
for tile in "${tiles[@]}"; do
  case $tile in
    */*|.|..|""|-*) die "'$tile' must be a bare tile name in $tiles_dir" ;;
  esac
  [ -f "$tiles_dir/$tile.ply" ] || die "'$tile' has no $tile.ply in $tiles_dir (run node scripts/splat-mosaic.mjs first)"
done
for tool in docker node; do
  command -v "$tool" > /dev/null || die "$tool is not on PATH"
done

# Whether file name $2 is one of tile $1's chunks, <tile>-lod-<n>.radc. The
# tile is compared as a string, not a pattern, so neither a tile whose name
# starts with this one's nor a "." in a name can match.
is_chunk() {
  local rest=${2#"$1-lod-"}
  [ "$rest" != "$2" ] && [[ $rest =~ ^[0-9]+\.radc$ ]]
}

work=
trap '[ -z "$work" ] || rm -rf "$work"' EXIT
mkdir -p "$lod_dir"

# Builds one tile's tree and swaps it in, or fails the script and leaves the
# tile's previous tree in place.
build_one() {
  local tile=$1
  local in=$tiles_dir/$tile.ply
  local out=$lod_dir/$tile-lod.rad
  # The work directory sits in lod/, so each final rename is atomic. build-lod
  # writes its output beside its input, so the input is mounted, read-only,
  # into the work directory; Docker leaves an empty file there for the mount
  # point, which goes with the directory.
  work=$(mktemp -d "$lod_dir/.build-XXXXXX")

  echo "==> $tile: build-lod --quality --rad-chunked (Spark $spark_tag)"
  # --no-default-features: the default `gpu` feature only clusters spherical
  # harmonics, which needs a GPU the container does not have. --quality is
  # bhatt-lod, Spark's recommendation for a tree built offline and streamed.
  # --rad-chunked writes each 64K-splat chunk as its own file, named in the
  # header, which Spark fetches whole: cached and revalidated chunk by chunk.
  docker run --rm \
    -v "$cache_volume:/cache" \
    -v "$work:/w" \
    -v "$in:/w/$tile.ply:ro" \
    "$rust_image" bash -euo pipefail -c '
      if [ ! -x /cache/bin/build-lod ]; then
        echo "    building Spark '"$spark_tag"' build-lod (first run only)"
        rm -rf /cache/spark
        git clone -q --depth 1 --branch '"$spark_tag"' https://github.com/sparkjsdev/spark /cache/spark 2> /dev/null
        CARGO_HOME=/cache/cargo cargo build -q --release --manifest-path /cache/spark/rust/Cargo.toml \
          -p build-lod --no-default-features
        mkdir -p /cache/bin
        cp /cache/spark/rust/target/release/build-lod /cache/bin/build-lod
      fi
      /cache/bin/build-lod --quality --rad-chunked "/w/'"$tile"'.ply" > /w/log 2>&1 || { cat /w/log >&2; exit 1; }
    ' || die "$tile: build-lod failed; $out is unchanged"

  local built=$work/$tile-lod.rad
  # build-lod reports an input it cannot read and still exits 0, writing nothing.
  if [ ! -s "$built" ]; then
    tail -n 5 "$work/log" >&2
    die "$tile: build-lod wrote no $tile-lod.rad; $out is unchanged"
  fi
  # A .rad starts with the magic RAD0; anything else would fail in the browser.
  [ "$(head -c 4 "$built")" = RAD0 ] || die "$tile: $tile-lod.rad is not a RAD file; $out is unchanged"

  # The chunk files the header names, which must all have been written. The
  # header is RAD0, a little-endian u32 length, then that much JSON.
  local chunks
  chunks=$(node -e '
    const b = require("fs").readFileSync(process.argv[1]);
    const meta = JSON.parse(b.toString("utf8", 8, 8 + b.readUInt32LE(4)));
    console.log(meta.chunks.map((c) => c.filename ?? "").join("\n"));' -- "$built") \
    || die "$tile: cannot read $tile-lod.rad's header; $out is unchanged"
  local n=0 chunk
  local bytes
  bytes=$(wc -c < "$built")
  while IFS= read -r chunk; do
    is_chunk "$tile" "$chunk" || die "$tile: the header names a chunk '$chunk', not $tile-lod-<n>.radc; $out is unchanged"
    [ -s "$work/$chunk" ] || die "$tile: chunk $chunk was not written; $out is unchanged"
    n=$((n + 1))
    bytes=$((bytes + $(wc -c < "$work/$chunk")))
  done <<< "$chunks"

  # Swap: the old chunks out, the new ones in, the header last. A set of files
  # cannot be swapped at once; between the steps a reader sees the old header
  # with chunks missing (a failed fetch), never a new header with old chunks.
  local f
  for f in "$lod_dir"/*.radc; do
    [ -e "$f" ] || continue
    if is_chunk "$tile" "$(basename "$f")"; then rm -f "$f"; fi
  done
  while IFS= read -r chunk; do mv "$work/$chunk" "$lod_dir/$chunk"; done <<< "$chunks"
  mv "$built" "$out"

  # build-lod reports the counts in its log as JSON fields.
  field() { grep -m1 "\"$1\"" "$work/log" | tr -dc '0-9'; }
  local size
  size=$(awk -v b="$bytes" 'BEGIN { printf "%.0fM", b / 1048576 }')
  echo "    $(field input_splat_count) splats → $(field final_splat_count) tree nodes, $n chunks, $size"
  echo "    wrote $out and its $n chunks"
  rm -rf "$work"
  work=
}

for tile in "${tiles[@]}"; do build_one "$tile"; done

# --all owns lod/: the trees of tiles that are no longer in tiles/ go. A
# tree's tile is its file name less -lod.rad, or less -lod-<n>.radc.
if [ "$all" = 1 ]; then
  pruned=0
  for f in "$lod_dir"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [[ $name =~ ^(.+)-lod\.rad$ ]] || [[ $name =~ ^(.+)-lod-[0-9]+\.radc$ ]]; then
      [ -f "$tiles_dir/${BASH_REMATCH[1]}.ply" ] || { rm -f "$f"; pruned=$((pruned + 1)); }
    fi
  done
  echo "==> ${#tiles[@]} tiles built; $pruned files of tiles no longer in $tiles_dir removed from $lod_dir"
fi
