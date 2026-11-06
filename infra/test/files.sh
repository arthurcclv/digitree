#!/usr/bin/env bash
# The files service's test: the image docker-compose.yml pins, given the real
# files.conf, serves the splat tiles and LoD trees to a browser on another
# origin (specs/network-access.md, CORS on `files`).
#
# It starts a throwaway nginx over a scratch directory holding a small stand-in
# .rad and .radc, on a port Docker picks on 127.0.0.1, so the stack's own
# `files` and FILES_PORT are left alone, and data/ is never read. Needs Docker
# and curl; no database.
#
#   ./test/files.sh   # from infra/; test/run.sh also runs it
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail + 1)); }
case_() { printf '\n%s\n' "$1"; }

NAME=infra-files-test
ORIGIN=http://frontend.example:8080

image=$(docker compose config --format json | node test/compose-config.mjs files image)

scratch=$(mktemp -d)
cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
mkdir -p "$scratch/tiles" "$scratch/lod"
head -c 4096 /dev/urandom > "$scratch/lod/t-lod.rad"
head -c 8192 /dev/urandom > "$scratch/lod/t-lod-0.radc"
head -c 1024 /dev/urandom > "$scratch/tiles/t.ply"
chmod -R a+rX "$scratch"

docker rm -f "$NAME" > /dev/null 2>&1 || true
docker run -d --name "$NAME" -p 127.0.0.1::80 \
  -v "$scratch/tiles:/srv/3dgs:ro" -v "$scratch/lod:/srv/3dgs-lod:ro" \
  -v "$PWD/files.conf:/etc/nginx/conf.d/default.conf:ro" \
  "$image" > /dev/null
port=$(docker port "$NAME" 80/tcp | head -1 | sed 's/.*://')
base=http://127.0.0.1:$port
for _ in $(seq 30); do
  curl -s -o /dev/null "$base/3dgs-lod/t-lod.rad" && break
  sleep 0.2
done

# headers <curl args…>: the response's status line and headers, lower-cased
# names, no CRs.
headers() { curl -s -D - -o /dev/null "$@" | tr -d '\r' | sed 's/^\([^:]*\):/\L\1:/'; }
status_of() { printf '%s\n' "$1" | head -1 | cut -d' ' -f2; }
header_of() { printf '%s\n' "$1" | sed -n "s/^$2: //p" | head -1; }

expect() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want [$3], got [$2]"; fi
}
expect_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "[$3] not in [$2]" ;; esac
}
# cors <label> <headers>: the whole CORS set, which every response from the
# two locations carries (rules 6 and 7), whatever its status.
cors() {
  local label=$1 h=$2
  expect "$label: allows any origin" "$(header_of "$h" access-control-allow-origin)" "*"
  local exposed; exposed=$(header_of "$h" access-control-expose-headers)
  for name in Content-Length Content-Range Accept-Ranges ETag; do
    expect_has "$label: exposes $name" "$exposed" "$name"
  done
  local methods; methods=$(header_of "$h" access-control-allow-methods)
  for m in GET HEAD OPTIONS; do expect_has "$label: allows $m" "$methods" "$m"; done
  local allowed; allowed=$(header_of "$h" access-control-allow-headers)
  for name in Range If-None-Match If-Modified-Since; do
    expect_has "$label: allows the $name header" "$allowed" "$name"
  done
  expect "$label: caches the preflight a day" "$(header_of "$h" access-control-max-age)" 86400
}

for path in /3dgs-lod/t-lod.rad /3dgs/t.ply; do
  case_ "GET $path from another origin"
  h=$(headers -H "Origin: $ORIGIN" "$base$path")
  expect "status 200" "$(status_of "$h")" 200
  cors "$path" "$h"
  expect "Cache-Control is unchanged" "$(header_of "$h" cache-control)" "no-cache"
  [ -n "$(header_of "$h" etag)" ] && ok "has an ETag" || bad "has an ETag" "none"
done

case_ "a ranged GET, as Spark reads a .rad header"
h=$(headers -H "Origin: $ORIGIN" -H 'Range: bytes=0-15' "$base/3dgs-lod/t-lod.rad")
expect "status 206" "$(status_of "$h")" 206
expect "Content-Range" "$(header_of "$h" content-range)" "bytes 0-15/4096"
cors "206" "$h"

case_ "a chunk, fetched whole"
h=$(headers -H "Origin: $ORIGIN" "$base/3dgs-lod/t-lod-0.radc")
expect "status 200" "$(status_of "$h")" 200
expect "Content-Length" "$(header_of "$h" content-length)" 8192
cors "chunk" "$h"

case_ "a preflight for a Range request"
for path in /3dgs-lod/t-lod.rad /3dgs/t.ply; do
  preflight=(-X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: GET'
             -H 'Access-Control-Request-Headers: range' "$base$path")
  h=$(headers "${preflight[@]}")
  expect "$path: status 204" "$(status_of "$h")" 204
  expect "$path: no body" "$(curl -s -o /dev/null -w '%{size_download}' "${preflight[@]}")" 0
  cors "$path preflight" "$h"
done

case_ "a revalidation"
etag=$(header_of "$(headers "$base/3dgs-lod/t-lod.rad")" etag)
h=$(headers -H "Origin: $ORIGIN" -H "If-None-Match: $etag" "$base/3dgs-lod/t-lod.rad")
expect "status 304" "$(status_of "$h")" 304
cors "304" "$h"

case_ "what is not served"
h=$(headers -H "Origin: $ORIGIN" "$base/3dgs-lod/missing-lod.rad")
expect "a missing file is 404" "$(status_of "$h")" 404
cors "404" "$h"
expect "outside the two locations is 404" "$(status_of "$(headers "$base/etc/passwd")")" 404
expect "no directory listing" "$(status_of "$(headers "$base/3dgs-lod/")")" 403

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
