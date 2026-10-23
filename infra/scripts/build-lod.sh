#!/usr/bin/env bash
# Build one cleaned Gaussian splat capture's level-of-detail tree, as the
# chunked .rad the app streams: a header and one .radc file per chunk.
#
#   ./scripts/build-lod.sh KZ0918-075047      # source/KZ0918-075047.spz → lod/KZ0918-075047-lod.rad + -lod-<n>.radc
#
# Reads data/3dgs/source/<scan>.spz, which it never writes, and writes
# data/3dgs/lod/<scan>-lod.rad and <scan>-lod-<n>.radc, which the files service
# serves at /3dgs-lod/.
# The tool is Spark's own build-lod, at the version the app's Spark reads,
# built and run in a pinned Rust image: nothing but Docker is needed on the
# host. The spec is specs/build-lod.md.
set -euo pipefail

infra=$(cd "$(dirname "$0")/.." && pwd)
source_dir=${SPLATS_SOURCE_DIR:-$infra/data/3dgs/source}
lod_dir=${SPLATS_LOD_DIR:-$infra/data/3dgs/lod}

# The .rad format is read by the app's Spark, so the writer is held to the same
# version: app/package.json pins @sparkjsdev/spark at exactly this.
spark_tag=v2.3.1
rust_image=rust:1.88-bookworm
# The compiled tool and cargo's downloads persist here between runs, so only
# the first run builds (about a minute).
cache_volume=splat-build-lod-$spark_tag

die() { echo "error: $*" >&2; exit 1; }
usage() { echo "usage: $0 <scan>" >&2; exit 2; }

[ $# -eq 1 ] || usage
scan=$1
case $scan in
  */*|.|..|""|-*) die "'$scan' must be a bare scan name in $source_dir" ;;
esac
in=$source_dir/$scan.spz
[ -f "$in" ] || die "'$scan' has no $scan.spz in $source_dir (run ./scripts/clean-splat.sh $scan first)"
for tool in docker node; do
  command -v "$tool" > /dev/null || die "$tool is not on PATH"
done

# Whether a file name is one of this scan's chunks, <scan>-lod-<n>.radc. The
# scan is compared as a string, not a pattern, so neither a scan whose name
# starts with this one's nor a "." in a name can match.
is_chunk() {
  local rest=${1#"$scan-lod-"}
  [ "$rest" != "$1" ] && [[ $rest =~ ^[0-9]+\.radc$ ]]
}

out=$lod_dir/$scan-lod.rad
# The work directory sits in lod/, so each final rename is atomic. build-lod
# writes its output beside its input, so the input is mounted, read-only, into
# the work directory; Docker leaves an empty file there for the mount point,
# which goes with the directory.
mkdir -p "$lod_dir"
work=$(mktemp -d "$lod_dir/.build-XXXXXX")
trap 'rm -rf "$work"' EXIT

echo "==> $scan: build-lod --quality --rad-chunked (Spark $spark_tag)"
# --no-default-features: the default `gpu` feature only clusters spherical
# harmonics, which needs a GPU the container does not have. --quality is
# bhatt-lod, Spark's recommendation for a tree built offline and streamed.
# --rad-chunked writes each 64K-splat chunk as its own file, named in the
# header, which Spark fetches whole: cached and revalidated chunk by chunk.
docker run --rm \
  -v "$cache_volume:/cache" \
  -v "$work:/w" \
  -v "$in:/w/$scan.spz:ro" \
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
    /cache/bin/build-lod --quality --rad-chunked "/w/'"$scan"'.spz" > /w/log 2>&1 || { cat /w/log >&2; exit 1; }
  ' || die "$scan: build-lod failed; $out is unchanged"

built=$work/$scan-lod.rad
# build-lod reports an input it cannot read and still exits 0, writing nothing.
if [ ! -s "$built" ]; then
  tail -n 5 "$work/log" >&2
  die "$scan: build-lod wrote no $scan-lod.rad; $out is unchanged"
fi
# A .rad starts with the magic RAD0; anything else would fail in the browser.
[ "$(head -c 4 "$built")" = RAD0 ] || die "$scan: $scan-lod.rad is not a RAD file; $out is unchanged"

# The chunk files the header names, which must all have been written. The
# header is RAD0, a little-endian u32 length, then that much JSON.
chunks=$(node -e '
  const b = require("fs").readFileSync(process.argv[1]);
  const meta = JSON.parse(b.toString("utf8", 8, 8 + b.readUInt32LE(4)));
  console.log(meta.chunks.map((c) => c.filename ?? "").join("\n"));' -- "$built") \
  || die "$scan: cannot read $scan-lod.rad's header; $out is unchanged"
n=0
bytes=$(wc -c < "$built")
while IFS= read -r chunk; do
  is_chunk "$chunk" || die "$scan: the header names a chunk '$chunk', not $scan-lod-<n>.radc; $out is unchanged"
  [ -s "$work/$chunk" ] || die "$scan: chunk $chunk was not written; $out is unchanged"
  n=$((n + 1))
  bytes=$((bytes + $(wc -c < "$work/$chunk")))
done <<< "$chunks"

# Swap: the old chunks out, the new ones in, the header last. A set of files
# cannot be swapped at once; between the steps a reader sees the old header
# with chunks missing (a failed fetch), never a new header with old chunks.
for f in "$lod_dir"/*.radc; do
  [ -e "$f" ] || continue
  if is_chunk "$(basename "$f")"; then rm -f "$f"; fi
done
while IFS= read -r chunk; do mv "$work/$chunk" "$lod_dir/$chunk"; done <<< "$chunks"
mv "$built" "$out"

# build-lod reports the counts in its log as JSON fields.
field() { grep -m1 "\"$1\"" "$work/log" | tr -dc '0-9'; }
size=$(awk -v b="$bytes" 'BEGIN { printf "%.0fM", b / 1048576 }')
echo "    $(field input_splat_count) splats → $(field final_splat_count) tree nodes, $n chunks, $size"
echo "    wrote $out and its $n chunks"
