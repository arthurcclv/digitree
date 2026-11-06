#!/usr/bin/env bash
# The files service's test: the image docker-compose.yml pins, given the real
# files.conf, files-locations.conf, files-tls.conf and files-tls.sh, serves the
# splat tiles and LoD trees to a browser on another origin
# (specs/network-access.md, CORS on `files`), over plain HTTP/1.1 and over
# HTTPS with HTTP/2 (specs/files-http2.md).
#
# It starts throwaway nginx containers over a scratch directory holding a
# small stand-in .rad and .radc and a throwaway self-signed certificate, on
# ports Docker picks on 127.0.0.1, so the stack's own `files`, FILES_PORT and
# FILES_TLS_PORT are left alone, and data/ and tls/ are never read. Needs
# Docker, curl (with HTTP/2) and openssl; no database.
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
names=("$NAME" "$NAME-nocert" "$NAME-halfcert" "$NAME-badpair")
cleanup() {
  for n in "${names[@]}"; do docker rm -f "$n" > /dev/null 2>&1 || true; done
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p "$scratch/tiles" "$scratch/lod" "$scratch/tls" "$scratch/notls" \
  "$scratch/cert-only" "$scratch/key-only" "$scratch/mismatched" "$scratch/not-pem"
head -c 4096 /dev/urandom > "$scratch/lod/t-lod.rad"
head -c 8192 /dev/urandom > "$scratch/lod/t-lod-0.radc"
head -c 1024 /dev/urandom > "$scratch/tiles/t.ply"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 \
  -addext subjectAltName=IP:127.0.0.1 \
  -keyout "$scratch/tls/key.pem" -out "$scratch/tls/cert.pem" 2> /dev/null
cp "$scratch/tls/cert.pem" "$scratch/cert-only/"
cp "$scratch/tls/key.pem" "$scratch/key-only/"
# Pairs nginx itself must refuse (rule 4): the certificate with another
# pair's key, and two files that are not PEM.
cp "$scratch/tls/cert.pem" "$scratch/mismatched/"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$scratch/mismatched/key.pem" 2> /dev/null
echo "not a certificate" > "$scratch/not-pem/cert.pem"
echo "not a key" > "$scratch/not-pem/key.pem"
chmod -R a+rX "$scratch"

# start <name> <tls dir> [docker run args…]: the files service as Compose
# runs it, both ports published on random ports, with <tls dir> as its
# FILES_TLS_DIR.
start() {
  local name=$1 tls=$2; shift 2
  docker rm -f "$name" > /dev/null 2>&1 || true
  docker run -d --name "$name" -p 127.0.0.1::80 -p 127.0.0.1::443 \
    -v "$scratch/tiles:/srv/3dgs:ro" -v "$scratch/lod:/srv/3dgs-lod:ro" \
    -v "$PWD/files.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "$PWD/files-locations.conf:/etc/nginx/files-locations.conf:ro" \
    -v "$PWD/files-tls.conf:/etc/nginx/files-tls.conf:ro" \
    -v "$PWD/files-tls.sh:/docker-entrypoint.d/40-files-tls.sh:ro" \
    -v "$tls:/etc/nginx/tls:ro" \
    "$@" "$image" > /dev/null
}
port_of() { docker port "$1" "$2/tcp" | head -1 | sed 's/.*://'; }
# wait_for <container> <base>: until <base> answers. A listener that never
# comes up fails the suite here, once, with the container's log, rather than
# as every case after it.
wait_for() {
  for _ in $(seq 30); do
    curl -sk -o /dev/null "$2/3dgs-lod/t-lod.rad" && return 0
    sleep 0.2
  done
  printf '  \033[31mFAIL\033[0m %s never answered on %s\n' "$1" "$2" >&2
  docker logs "$1" >&2 2>&1 || true
  exit 1
}
# refuses <container> <label>: the container stops on its own, non-zero.
refuses() {
  local name=$1 label=$2 code
  for _ in $(seq 30); do
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = false ] && break
    sleep 0.2
  done
  expect "$label: the container has stopped" "$(docker inspect -f '{{.State.Running}}' "$name")" false
  code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
  [ "$code" != 0 ] && ok "$label: exits non-zero ($code)" || bad "$label: exits non-zero" "exit 0"
}

start "$NAME" "$scratch/tls"
http_base=http://127.0.0.1:$(port_of "$NAME" 80)
https_base=https://127.0.0.1:$(port_of "$NAME" 443)
wait_for "$NAME" "$http_base"
wait_for "$NAME" "$https_base"

# headers <curl args…>: the response's status line and headers, lower-cased
# names, no CRs. CURL is the listener's own curl options, which serves sets.
headers() { curl -s "${CURL[@]}" -D - -o /dev/null "$@" | tr -d '\r' | sed 's/^\([^:]*\):/\L\1:/'; }
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

# serves <proto> <base> [curl options…]: every case of
# specs/network-access.md's test, on one listener, with that listener's own
# curl options (-k for the self-signed certificate). Both listeners must pass
# all of them (specs/files-http2.md rule 7).
serves() {
  local proto=$1 base=$2 h path etag preflight
  shift 2
  CURL=("$@")
  for path in /3dgs-lod/t-lod.rad /3dgs/t.ply; do
    case_ "$proto: GET $path from another origin"
    h=$(headers -H "Origin: $ORIGIN" "$base$path")
    expect "status 200" "$(status_of "$h")" 200
    cors "$path" "$h"
    expect "Cache-Control is unchanged" "$(header_of "$h" cache-control)" "no-cache"
    [ -n "$(header_of "$h" etag)" ] && ok "has an ETag" || bad "has an ETag" "none"
  done

  case_ "$proto: a ranged GET, as Spark reads a .rad header"
  h=$(headers -H "Origin: $ORIGIN" -H 'Range: bytes=0-15' "$base/3dgs-lod/t-lod.rad")
  expect "status 206" "$(status_of "$h")" 206
  expect "Content-Range" "$(header_of "$h" content-range)" "bytes 0-15/4096"
  cors "206" "$h"

  case_ "$proto: a chunk, fetched whole"
  h=$(headers -H "Origin: $ORIGIN" "$base/3dgs-lod/t-lod-0.radc")
  expect "status 200" "$(status_of "$h")" 200
  expect "Content-Length" "$(header_of "$h" content-length)" 8192
  cors "chunk" "$h"

  case_ "$proto: a preflight for a Range request"
  for path in /3dgs-lod/t-lod.rad /3dgs/t.ply; do
    preflight=(-X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: GET'
               -H 'Access-Control-Request-Headers: range' "$base$path")
    h=$(headers "${preflight[@]}")
    expect "$path: status 204" "$(status_of "$h")" 204
    expect "$path: no body" "$(curl -s "${CURL[@]}" -o /dev/null -w '%{size_download}' "${preflight[@]}")" 0
    cors "$path preflight" "$h"
  done

  case_ "$proto: a revalidation"
  etag=$(header_of "$(headers "$base/3dgs-lod/t-lod.rad")" etag)
  h=$(headers -H "Origin: $ORIGIN" -H "If-None-Match: $etag" "$base/3dgs-lod/t-lod.rad")
  expect "status 304" "$(status_of "$h")" 304
  cors "304" "$h"

  case_ "$proto: what is not served"
  h=$(headers -H "Origin: $ORIGIN" "$base/3dgs-lod/missing-lod.rad")
  expect "a missing file is 404" "$(status_of "$h")" 404
  cors "404" "$h"
  expect "outside the two locations is 404" "$(status_of "$(headers "$base/etc/passwd")")" 404
  expect "no directory listing" "$(status_of "$(headers "$base/3dgs-lod/")")" 403
}

serves HTTP "$http_base"
serves HTTPS "$https_base" -k

case_ "the protocol each listener speaks"
expect "HTTPS negotiates HTTP/2" \
  "$(curl -sk --http2 -o /dev/null -w '%{http_version}' "$https_base/3dgs-lod/t-lod.rad")" 2
expect "HTTPS still serves HTTP/1.1 to a client that asks for it" \
  "$(curl -sk --http1.1 -o /dev/null -w '%{http_version} %{http_code}' "$https_base/3dgs-lod/t-lod.rad")" "1.1 200"
expect "plain HTTP stays HTTP/1.1, no h2c upgrade" \
  "$(curl -s --http2 -o /dev/null -w '%{http_version}' "$http_base/3dgs-lod/t-lod.rad")" 1.1
expect "a ranged GET over HTTP/2 is 206" \
  "$(curl -sk --http2 -H 'Range: bytes=0-15' -o /dev/null -w '%{http_version} %{http_code}' "$https_base/3dgs-lod/t-lod.rad")" "2 206"

case_ "no certificate: plain HTTP only"
start "$NAME-nocert" "$scratch/notls"
nocert_http=http://127.0.0.1:$(port_of "$NAME-nocert" 80)
nocert_https=https://127.0.0.1:$(port_of "$NAME-nocert" 443)
wait_for "$NAME-nocert" "$nocert_http"
expect "HTTP serves 200" "$(curl -s -o /dev/null -w '%{http_code}' "$nocert_http/3dgs-lod/t-lod.rad")" 200
# Rule 6: the port is published with nothing behind it, so Docker accepts the
# connection and then resets it. curl's exit 7 would mean refused instead.
rc=0
curl -sk -o /dev/null "$nocert_https/3dgs-lod/t-lod.rad" || rc=$?
case $rc in
  0) bad "443 is reset, not refused" "curl succeeded" ;;
  7) bad "443 is reset, not refused" "curl exit 7: refused" ;;
  *) ok "443 is reset, not refused (curl exit $rc)" ;;
esac
expect_has "the log says plain HTTP only" "$(docker logs "$NAME-nocert" 2>&1)" "plain HTTP only"

case_ "half a certificate: refuses to start"
for half in cert-only:key.pem key-only:cert.pem; do
  dir=${half%%:*} missing=${half#*:}
  name=$NAME-halfcert
  start "$name" "$scratch/$dir"
  refuses "$name" "$dir"
  expect_has "$dir: the log names $missing" "$(docker logs "$name" 2>&1)" "$missing is missing"
done

case_ "a pair nginx rejects: refuses to start (rule 4)"
for dir in mismatched not-pem; do
  name=$NAME-badpair
  start "$name" "$scratch/$dir"
  refuses "$name" "$dir"
  expect_has "$dir: nginx says why" "$(docker logs "$name" 2>&1)" "[emerg]"
done

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
