#!/usr/bin/env bash
# voxel-quality.mjs's test suite: the cases in test/voxel-quality-cases.mjs,
# on hand-built voxels. Needs node only.
#
#   ./test/voxel-quality.sh   # from infra/; test/run.sh also runs it
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node > /dev/null || { echo "error: node is not on PATH" >&2; exit 1; }

pass=0
fail=0
while IFS= read -r line; do
  case $line in
    "ok "*)   printf '  \033[32mok\033[0m   %s\n' "${line#ok }"; pass=$((pass + 1)) ;;
    "FAIL "*) printf '  \033[31mFAIL\033[0m %s\n' "${line#FAIL }"; fail=$((fail + 1)) ;;
    *) echo "$line" ;;
  esac
done < <(node test/voxel-quality-cases.mjs)

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] && [ "$pass" -gt 0 ]
