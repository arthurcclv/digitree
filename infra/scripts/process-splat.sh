#!/usr/bin/env bash
# Process one Gaussian splat capture for serving: correct its placement
# against the scanner's RTK and lidar, keep only its largest connected body
# (footprint pruning), drop the Gaussians outside the capture's own
# distribution, the oversized ones and the floaters, and write it as a
# lossless .ply for splat-mosaic.mjs. A scan's config may skip any of
# footprint pruning, the density cut, the size cut and the floater pass.
#
#   ./scripts/process-splat.sh KZ0918-075047                        # 1 m footprint, 2 m voxels, 1%, max(0.25 m, 4 × typical size)
#   ./scripts/process-splat.sh KZ0918-075047 --min-density 0.02 --max-scale 0.5 --scale-ratio 6
#
# Reads data/3dgs/original/<scan>/ — the one point_cloud.<ext>, for the
# align step the files its scanner module reads (specs/scanners.md), and the
# optional process_splat_config.json, the scan's own cut settings, which a
# flag still overrides, and the steps it skips — and never writes it. Writes
# data/3dgs/clean/<scan>.ply, which the mosaic reads, and <scan>.align.json
# beside it. It always starts from the original, so re-running never
# compounds the cuts. The specs are specs/process-splat.md and
# specs/splat-align.md.
set -euo pipefail

infra=$(cd "$(dirname "$0")/.." && pwd)
original_dir=${SPLATS_ORIGINAL_DIR:-$infra/data/3dgs/original}
clean_dir=${SPLATS_CLEAN_DIR:-$infra/data/3dgs/clean}

# Footprint pruning joins occupied voxels of this edge that touch into groups
# and keeps the one with the most voxels.
footprint_cell=1
cell=2
min_density=0.01
# The size cut's limit is max(max_scale, scale_ratio × the capture's typical
# size): a drone capture's Gaussians are ~10× a ground scan's, and the floor
# keeps every ground scan at 0.25 m.
max_scale=0.25
scale_ratio=4
# splat-transform's own defaults for -F, spelled out so a change in its
# defaults does not silently change what this script does.
floaters=0.05,0.1,0.004

die() { echo "error: $*" >&2; exit 1; }
usage() { echo "usage: $0 <scan> [--footprint-cell <m>] [--cell <m>] [--min-density <f>] [--max-scale <m>] [--scale-ratio <k>] [--floaters <size,op,min>]" >&2; exit 2; }

# The cut settings, each a variable above, a flag (--min-density for
# min_density) and a key of the scan's config. Each one's rule, which its flag
# and the config share, so the file can never pass a value the command line
# would refuse:
settings=(footprint_cell cell min_density max_scale scale_ratio floaters)
declare -A rule=(
  [footprint_cell]="a positive number of metres"
  [cell]="a positive number of metres"
  [min_density]="a positive fraction"
  [max_scale]="a positive number of metres"
  [scale_ratio]="a positive number"
  [floaters]="three non-negative numbers size,opacity,min"
)
decimal='([0-9]+\.?[0-9]*|\.[0-9]+)'
valid() {
  case $1 in
    floaters) [[ $2 =~ ^$decimal,$decimal,$decimal$ ]] ;;
    *) [[ $2 =~ ^$decimal$ ]] && [[ ! $2 =~ ^0*\.?0*$ ]] ;;
  esac
}
# Where each setting came from: flags, config or defaults. A flag wins over
# the scan's config.
declare -A origin=()
# The step each setting belongs to, and the steps the config skips (a set,
# and the config's list in the order the steps run). A skipped step's
# settings are still checked, but unused.
declare -A step_of=([footprint_cell]=footprint [cell]=density [min_density]=density [max_scale]=size [scale_ratio]=size [floaters]=floaters)
declare -A skipped=()
skips=
is_skipped() { [ -n "${skipped[$1]:-}" ]; }

[ $# -ge 1 ] || usage
scan=$1; shift
while [ $# -gt 0 ]; do
  case $1 in
    --footprint-cell|--cell|--min-density|--max-scale|--scale-ratio|--floaters)
      [ $# -ge 2 ] || usage
      key=${1#--}; key=${key//-/_}
      printf -v "$key" '%s' "$2"; origin[$key]=flags; shift 2 ;;
    *) usage ;;
  esac
done

for key in "${settings[@]}"; do
  valid "$key" "${!key}" || die "--${key//_/-} must be ${rule[$key]}, got '${!key}'"
done
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

# The scan's own settings, if an operator recorded any beside it. The file is
# checked whole, and strictly, before anything runs: a misspelt key would
# otherwise be ignored and the scan cut with the default, and a bad key is
# refused even when a flag overrides it, so it is found on the first run.
# Each setting comes from its flag, else the config, else the default.
config_name=process_splat_config.json
config=$original_dir/$scan/$config_name
if [ -e "$config" ]; then
  # `<key> <value> <raw>` per setting the file has, its shape and types
  # checked; or the reason it is refused, exiting 1. Fields are split on the
  # unit separator, not a space: a skip's value is empty when its array is,
  # and a run of spaces or tabs would collapse into one separator.
  config_lines=$(node --input-type=module -e '
    const { readConfig } = await import(process.argv[1]);
    try { for (const fields of readConfig(process.argv[2])) console.log(fields.join("\x1f")); }
    catch (e) { console.log(e.message); process.exit(1); }' -- "$infra/scripts/process-splat-config.mjs" "$config") || die "$config_lines"
  while IFS=$'\x1f' read -r key value raw; do
    [ -n "$key" ] || continue
    # The skips are checked whole by readConfig; no flag shares their rule.
    if [ "$key" = skip ]; then
      skips=$value
      for step in ${value//,/ }; do skipped[$step]=1; done
      continue
    fi
    # Checked before a flag can override it: the file is checked whole.
    valid "$key" "$value" || die "$config: \"$key\" must be ${rule[$key]}, got $raw"
    [ "${origin[$key]:-}" = flags ] && continue
    # Safe to assign by name: readConfig returns only keys of $settings.
    printf -v "$key" '%s' "$value"
    origin[$key]=config
  done <<< "$config_lines"
fi
for key in "${settings[@]}"; do : "${origin[$key]:=defaults}"; done
# `settings: config <file> (…); flags (…); defaults (…)`, each group only when
# it has a setting; `settings: defaults` when nothing came from either. A
# skipped step's settings are left out of the groups, and those a config or
# flag set follow as `unused, skipped (…)`; the config's skips end the line.
settings_line() {
  local key line= unused=
  local -A group=([config]= [flags]= [defaults]=)
  for key in "${settings[@]}"; do
    if is_skipped "${step_of[$key]}"; then
      [ "${origin[$key]}" = defaults ] || unused+=", $key"
    else
      group[${origin[$key]}]+=", $key"
    fi
  done
  [ -z "${group[config]}" ] || line+="; config $config_name (${group[config]#, })"
  [ -z "${group[flags]}" ] || line+="; flags (${group[flags]#, })"
  if [ -z "$line" ]; then
    # Every step skipped, and nothing set: there is no default in use either.
    [ -z "${group[defaults]}" ] && [ -n "$skips" ] || line=defaults
  else
    [ -z "${group[defaults]}" ] || line+="; defaults (${group[defaults]#, })"
  fi
  [ -z "$unused" ] || line+="; unused, skipped (${unused#, })"
  [ -z "$skips" ] || line+="; skip (${skips//,/, })"
  echo "    settings: ${line#; }"
}

# The density step uses splat-transform's library API, not just its CLI, so
# the version is held to the one it was written against.
version=$(splat-transform --version 2>&1)
case $version in
  "splat-transform v3.10."*) ;;
  *) die "process-splat.sh needs splat-transform 3.10.x, found '$version'" ;;
esac
lib=$(npm root -g)/@playcanvas/splat-transform/dist/index.mjs
[ -f "$lib" ] || die "splat-transform's library is not at $lib; install it globally with npm"

in=$original_dir/$scan/${found[0]}
out=$clean_dir/$scan.ply
# Both temporaries sit in clean/, so the final rename is atomic. The .ply one
# must end in .ply: splat-transform picks the format from the extension. Its
# leading '.' keeps it out of the mosaic's scans.
mkdir -p "$clean_dir"
work=$(mktemp -d "$clean_dir/.process-XXXXXX")
tmp=$clean_dir/.$scan.tmp.ply
align_out=$clean_dir/$scan.align.json
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

# The first line: every step that runs, with the values it uses, and every
# skipped one by name.
plan=align
if is_skipped footprint; then plan+=", no footprint pruning (skip)"; else plan+=", footprint in ${footprint_cell} m voxels (largest 26-connected group)"; fi
if is_skipped density; then plan+=", no density cut (skip)"; else plan+=", density in ${cell} m voxels >= ${min_density} x typical"; fi
if is_skipped size; then plan+=", no size cut (skip)"; else plan+=", every axis <= max(${max_scale} m, ${scale_ratio} x typical size)"; fi
if is_skipped floaters; then plan+=", no floater pass (skip)"; else plan+=", floaters $floaters"; fi
echo "==> $scan (${found[0]}): $plan"
settings_line

# 0. Align: correct the capture's placement in its own frame. splat-align.mjs
# picks the scanner module by the PLY's `comment source` and skips (exit 5)
# when there is none or a file it reads is missing; the cuts then run on the
# original, as they do when validation fails. A file that is there but wrong
# fails the scan.
if [ "${found[0]}" != point_cloud.ply ]; then
  node -e 'console.log(JSON.stringify({ scan: process.argv[1], scanner: null, status: "skipped", reason: process.argv[2] }, null, 2))' \
    -- "$scan" "${found[0]} is not a point_cloud.ply" > "$work/align.json"
  echo "    align skipped: ${found[0]} is not a point_cloud.ply"
else
  rc=0
  report=$(node "$infra/scripts/splat-align.mjs" -- "$original_dir/$scan" "$work/aligned.ply" "$work/align.json") || rc=$?
  case $rc in
    0)
      in=$work/aligned.ply
      read -r status moved turned < <(echo "$report" | json status correction_max_m correction_rot_deg)
      echo "    align $status: moved up to $moved m, turned $turned deg" ;;
    4)
      reason=$(echo "$report" | json reason)
      echo "error: $scan: align failed ($reason); continuing unaligned" >&2 ;;
    5) echo "    align skipped: $(echo "$report" | json reason)" ;;
    *) die "$scan: the align step failed; $out is unchanged" ;;
  esac
fi

# 1. Footprint pruning: keep the largest 26-connected group of occupied
# voxels. It never removes every Gaussian, so it never fails for its setting.
if is_skipped footprint; then
  before=$(gaussians "$in")
  echo "    $before gaussians; footprint pruning skipped: $config_name"
else
  rc=0
  report=$(node "$infra/scripts/splat-footprint.mjs" -- "$lib" "$in" "$work/footprint.ply" "$footprint_cell") || rc=$?
  [ "$rc" = 3 ] && die "$scan: the capture has no Gaussians; $out is unchanged"
  [ "$rc" = 0 ] || die "$scan: the footprint step failed; $out is unchanged"
  read -r before groups voxels kept < <(echo "$report" | json before groups voxels kept)
  rm -f "$work/aligned.ply" # ~1 GB per 13M Gaussians; footprint.ply holds the rest
  in=$work/footprint.ply
  echo "    $before gaussians; $groups groups in ${footprint_cell} m voxels, largest $voxels voxels; $kept kept by footprint"
fi

if is_skipped density; then
  # 2–3 skipped (the config cannot skip density alone): the floater pass
  # reads what step 1 kept, or the original, or the aligned file.
  echo "    density and size cuts skipped: $config_name"
  floater_input=$in
else
  # 2. The density cut, which splat-transform's CLI cannot express.
  rc=0
  report=$(node "$infra/scripts/splat-density-cut.mjs" -- "$lib" "$in" "$work/dense.ply" "$cell" "$min_density") || rc=$?
  [ "$rc" = 3 ] && die "$scan: these settings remove every Gaussian; $out is unchanged"
  [ "$rc" = 0 ] || die "$scan: the density step failed; $out is unchanged"
  read -r typical dense typical_scale < <(echo "$report" | json typical kept typical_scale)
  rm -f "$work/aligned.ply" "$work/footprint.ply" # dense.ply holds the rest
  echo "    typical voxel holds $typical; $dense kept by density"
  # The limit goes to -V exact; only the log rounds it, so a Gaussian at the
  # limit is never cut by the rounding.
  read -r limit typical_shown limit_shown < <(node -e '
    const [f, k, t] = process.argv.slice(1).map(Number), limit = Math.max(f, k * t);
    console.log(limit, +t.toPrecision(3), +limit.toPrecision(4));' -- "$max_scale" "$scale_ratio" "$typical_scale")
  if is_skipped size; then
    echo "    typical size $typical_shown m"
    echo "    size cut skipped: $config_name"
    floater_input=$work/dense.ply
  else
    echo "    typical size $typical_shown m; size limit $limit_shown m"

    # 3. Size cut, to a second lossless .ply so its own count can be reported.
    # -V on scale_* compares in metres, though the file stores log scale:
    # scale_0,lte,0 keeps nothing.
    transform "$work/dense.ply" \
      -V "scale_0,lte,$limit" -V "scale_1,lte,$limit" -V "scale_2,lte,$limit" \
      "$work/sized.ply"
    echo "    $(gaussians "$work/sized.ply") kept by size"
    floater_input=$work/sized.ply
  fi
fi

# 4. Floaters, to the lossless .ply the mosaic reads. No SPZ: nothing fetches
# the file itself any more, and build-lod reads the tiles' .ply. Skipped, the
# same run writes the same .ply with no filter, so the output's format never
# depends on the skips.
if is_skipped floaters; then
  transform "$floater_input" "$tmp"
else
  transform "$floater_input" -F "$floaters" "$tmp"
fi

after=$(gaussians "$tmp")
mv "$work/align.json" "$align_out"
mv "$tmp" "$out"

removed=$((before - after))
pct=$(node -e 'console.log((100 * process.argv[1] / process.argv[2]).toFixed(1))' -- "$removed" "$before")
if is_skipped floaters; then
  echo "    $after kept, floater pass skipped: $config_name; $removed removed in all ($pct%)"
else
  echo "    $after kept after floaters; $removed removed in all ($pct%)"
fi
echo "    wrote $out and $align_out"
