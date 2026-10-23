#!/usr/bin/env bash
# Clean one Gaussian splat capture for serving: drop the Gaussians outside the
# capture's own distribution, the oversized ones and the floaters, and write it
# as SPZ v3.
#
#   ./scripts/clean-splat.sh KZ0918-075047                        # 2 m voxels, 1%, 0.25 m
#   ./scripts/clean-splat.sh KZ0918-075047 --min-density 0.02 --max-scale 0.5
#
# Reads the one data/3dgs/original/<scan>/point_cloud.<ext>, which it never
# writes, and writes data/3dgs/source/<scan>.spz, which the files service
# serves. Nothing else in the scan folder is read. It always starts from the original, so
# re-running never compounds the cuts. The spec is specs/clean-splat.md.
set -euo pipefail

infra=$(cd "$(dirname "$0")/.." && pwd)
original_dir=${SPLATS_ORIGINAL_DIR:-$infra/data/3dgs/original}
source_dir=${SPLATS_SOURCE_DIR:-$infra/data/3dgs/source}

cell=2
min_density=0.01
max_scale=0.25
# splat-transform's own defaults for -F, spelled out so a change in its
# defaults does not silently change what this script does.
floaters=0.05,0.1,0.004

die() { echo "error: $*" >&2; exit 1; }
usage() { echo "usage: $0 <scan> [--cell <m>] [--min-density <f>] [--max-scale <m>] [--floaters <size,op,min>]" >&2; exit 2; }
is_positive() { [[ $1 =~ ^([0-9]+\.?[0-9]*|\.[0-9]+)$ ]] && [[ ! $1 =~ ^0*\.?0*$ ]]; }

[ $# -ge 1 ] || usage
scan=$1; shift
while [ $# -gt 0 ]; do
  case $1 in
    --cell)        [ $# -ge 2 ] || usage; cell=$2; shift 2 ;;
    --min-density) [ $# -ge 2 ] || usage; min_density=$2; shift 2 ;;
    --max-scale)   [ $# -ge 2 ] || usage; max_scale=$2; shift 2 ;;
    --floaters)    [ $# -ge 2 ] || usage; floaters=$2; shift 2 ;;
    *) usage ;;
  esac
done

is_positive "$cell"        || die "--cell must be a positive number of metres, got '$cell'"
is_positive "$min_density" || die "--min-density must be a positive fraction, got '$min_density'"
is_positive "$max_scale"   || die "--max-scale must be a positive number of metres, got '$max_scale'"
case $scan in
  */*|.|..|"") die "'$scan' must be a bare scan folder name in $original_dir" ;;
esac
[ -d "$original_dir/$scan" ] || die "'$scan' is not a scan folder in $original_dir"

# The single-file formats splat-transform reads. Not .mjs: a generator is code,
# and the scan folder is delivered data, never executed. Not meta.json,
# lod-meta.json, .lcc or .lcc2: multi-file or multi-LOD containers.
exts=(ply compressed.ply sog spz splat ksplat)
found=()
for ext in "${exts[@]}"; do
  [ -f "$original_dir/$scan/point_cloud.$ext" ] && found+=("point_cloud.$ext")
done
[ ${#found[@]} -gt 0 ] || die "'$scan' has no point_cloud.<ext> in $original_dir/$scan (looked for: ${exts[*]/#/point_cloud.})"
# Two exports of one scan may differ in loss; which is served is the
# operator's call, not a guess.
[ ${#found[@]} -eq 1 ] || die "'$scan' has more than one splat: ${found[*]}; keep one of them in $original_dir/$scan"
for tool in splat-transform node npm; do
  command -v "$tool" > /dev/null || die "$tool is not on PATH (npm install -g @playcanvas/splat-transform)"
done

# The density step uses splat-transform's library API, not just its CLI, so
# the version is held to the one it was written against.
version=$(splat-transform --version 2>&1)
case $version in
  "splat-transform v3.4."*) ;;
  *) die "clean-splat.sh needs splat-transform 3.4.x, found '$version'" ;;
esac
lib=$(npm root -g)/@playcanvas/splat-transform/dist/index.mjs
[ -f "$lib" ] || die "splat-transform's library is not at $lib; install it globally with npm"

in=$original_dir/$scan/${found[0]}
out=$source_dir/$scan.spz
# Both temporaries sit in source/, so the final rename is atomic. The .spz one
# must end in .spz: splat-transform picks the format from the extension.
mkdir -p "$source_dir"
work=$(mktemp -d "$source_dir/.clean-XXXXXX")
tmp=$source_dir/.$scan.tmp.spz
trap 'rm -rf "$work" "$tmp"' EXIT

# Every node argument goes after `--`: without it node reads a negative number
# as one of its own options.
#
# Reads one JSON object on stdin and prints the fields asked for.
json() { node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const j = JSON.parse(s);
    console.log(process.argv.slice(1).map(k => j[k]).join(" "));
  });' -- "$@"; }

echo "==> $scan (${found[0]}): density in ${cell} m voxels >= ${min_density} x typical, every axis <= ${max_scale} m, floaters $floaters"

# 1. The density cut, which splat-transform's CLI cannot express.
rc=0
report=$(node "$infra/scripts/splat-density-cut.mjs" -- "$lib" "$in" "$work/dense.ply" "$cell" "$min_density") || rc=$?
[ "$rc" = 3 ] && die "$scan: these settings remove every Gaussian; $out is unchanged"
[ "$rc" = 0 ] || die "$scan: the density step failed; $out is unchanged"
read -r before typical dense < <(echo "$report" | json before typical kept)
echo "    $before gaussians; typical voxel holds $typical; $dense kept by density"

# One splat-transform run, failing the script with the reason if it fails.
transform() {
  local log
  if ! log=$(splat-transform --no-tty -w "$@" 2>&1); then
    echo "$log" >&2
    case $log in
      *"No Gaussians to write"*) die "$scan: these settings remove every Gaussian; $out is unchanged" ;;
      *) die "$scan: splat-transform failed; $out is unchanged" ;;
    esac
  fi
}
gaussians() { splat-transform -q --no-tty "$1" --info json null | json numGaussians; }

# 2. Size cut, to a second lossless .ply so its own count can be reported.
# -V on scale_* compares in metres, though the file stores log scale:
# scale_0,lte,0 keeps nothing.
transform "$work/dense.ply" \
  -V "scale_0,lte,$max_scale" -V "scale_1,lte,$max_scale" -V "scale_2,lte,$max_scale" \
  "$work/sized.ply"
sized=$(gaussians "$work/sized.ply")
echo "    $sized kept by size"

# 3-4. Floaters, SPZ v3. --spz-version 3 because v4 is not gzipped, and Spark
# 2.3.1 recognises an SPZ by its gzip magic alone.
transform "$work/sized.ply" -F "$floaters" --spz-version 3 "$tmp"

after=$(gaussians "$tmp")
mv "$tmp" "$out"

removed=$((before - after))
pct=$(node -e 'console.log((100 * process.argv[1] / process.argv[2]).toFixed(1))' -- "$removed" "$before")
echo "    $after kept after floaters; $removed removed in all ($pct%)"
echo "    wrote $out"
