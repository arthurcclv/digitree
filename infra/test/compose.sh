#!/usr/bin/env bash
# The published addresses' test (specs/network-access.md, Publishing address):
# Martin and files are published on PUBLISH_ADDR, 127.0.0.1 by default, and
# db never leaves 127.0.0.1. files publishes two ports, plain HTTP and HTTPS
# (specs/files-http2.md rule 6). Reads `docker compose config` only; no container
# starts.
#
#   ./test/compose.sh   # from infra/; test/run.sh also runs it
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail + 1)); }
case_() { printf '\n%s\n' "$1"; }

# published <service> [VAR=value…]: the service's published ports, from the
# config Compose resolves with only the given settings, so the caller's own
# PUBLISH_ADDR, MARTIN_PORT, FILES_PORT and FILES_TLS_PORT never leak in.
published() {
  local service=$1; shift
  env -u PUBLISH_ADDR -u MARTIN_PORT -u FILES_PORT -u FILES_TLS_PORT "$@" \
    docker compose config --format json | node test/compose-config.mjs "$service" ports
}

expect() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want [$3], got [$2]"; fi
}

# run_case <label> <address> <martin port> [VAR=value…]
run_case() {
  local label=$1 want=$2 martin_port=$3; shift 3
  case_ "$label"
  expect "martin on $want" "$(published martin "$@")" "$want:$martin_port:3000"
  expect "files on $want, HTTP and HTTPS" "$(published files "$@" | tr '\n' ' ')" \
    "$want:3080:80 $want:3443:443 "
  expect "db on 127.0.0.1 only" "$(published db "$@")" "127.0.0.1:5432:5432"
}

run_case "PUBLISH_ADDR unset" 127.0.0.1 3000
run_case "PUBLISH_ADDR empty" 127.0.0.1 3000 PUBLISH_ADDR=
run_case "PUBLISH_ADDR=0.0.0.0" 0.0.0.0 3000 PUBLISH_ADDR=0.0.0.0
run_case "PUBLISH_ADDR=192.168.81.32, MARTIN_PORT=3001" 192.168.81.32 3001 \
  PUBLISH_ADDR=192.168.81.32 MARTIN_PORT=3001

case_ "FILES_TLS_PORT=4443"
expect "moves only the HTTPS port" "$(published files FILES_TLS_PORT=4443 | tr '\n' ' ')" \
  "127.0.0.1:3080:80 127.0.0.1:4443:443 "
expect "martin stays" "$(published martin FILES_TLS_PORT=4443)" "127.0.0.1:3000:3000"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
