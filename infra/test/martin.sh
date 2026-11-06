#!/usr/bin/env bash
# Martin's test: the image docker-compose.yml pins, given the real martin.yaml,
# connects to the database, publishes both sources, and allows other origins.
#
# It runs a throwaway Martin from the compose service (same image, same config,
# same network) with no host port, so the stack's own Martin and MARTIN_PORT
# are left alone, and asks it for /catalog from inside the db container, which
# has bash's /dev/tcp and so needs no extra image. Without `trees` and `splats`
# in the database Martin has nothing to publish, so the dev database must be
# loaded (./load.sh) first.
#
#   ./test/martin.sh       # from infra/
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail + 1)); }

NAME=infra-martin-test

image=$(docker compose config --format json | node test/compose-config.mjs martin image)
case "$image" in
  *:latest | *[!0-9.]) bad "the image is pinned to an exact version" "got [$image]" ;;
  *) ok "the image is pinned to an exact version ($image)" ;;
esac

docker compose up -d db > /dev/null
for _ in $(seq 60); do
  [ "$(docker compose ps db --format '{{.Health}}' 2>/dev/null || echo)" = "healthy" ] && break
  sleep 1
done

docker rm -f "$NAME" > /dev/null 2>&1 || true
trap 'docker rm -f "$NAME" > /dev/null 2>&1 || true' EXIT
# --pg-retry-timeout 0s: a Martin that cannot connect exits at once instead of
# retrying for 30 s, so the poll below fails fast.
docker compose run -d --no-deps --name "$NAME" martin \
  --config /config/martin.yaml --pg-retry-timeout 0s > /dev/null

catalog=
for _ in $(seq 30); do
  catalog=$(docker compose exec -T db bash -c "
    exec 3<>/dev/tcp/$NAME/3000 || exit 1
    printf 'GET /catalog HTTP/1.0\r\nHost: martin\r\n\r\n' >&3
    cat <&3" 2>/dev/null | tr -d '\r') && [ -n "$catalog" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || break
  sleep 1
done

case "$catalog" in
  "HTTP/1.1 200"* | "HTTP/1.0 200"*) ok "Martin connects to the database and serves /catalog" ;;
  *) bad "Martin connects to the database and serves /catalog" \
         "no answer; its log ends: $(docker logs --tail 3 "$NAME" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tr '\n' ' ')" ;;
esac
for source in trees splats; do
  case "$catalog" in
    *"\"$source\":{"*) ok "  publishes $source" ;;
    *) bad "  publishes $source" "not in the catalog" ;;
  esac
done

# Martin's default CORS lets a browser on any origin read it: what a frontend
# that talks to Martin directly relies on (specs/network-access.md, rule 10).
# A Martin upgrade that changes the default fails here.
cors=$(docker compose exec -T db bash -c "
  exec 3<>/dev/tcp/$NAME/3000 || exit 1
  printf 'GET /catalog HTTP/1.0\r\nHost: martin\r\nOrigin: http://frontend.example:8080\r\n\r\n' >&3
  cat <&3" 2>/dev/null | tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: //p')
case "$cors" in
  "*" | "http://frontend.example:8080") ok "allows a request from another origin (CORS)" ;;
  *) bad "allows a request from another origin (CORS)" "Access-Control-Allow-Origin: [$cors]" ;;
esac

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
