#!/usr/bin/env bash
# Bring up Postgres, create the schema, load both extracts, then start Martin.
# Idempotent: re-running reloads the table from the CSVs.
set -euo pipefail
cd "$(dirname "$0")"

for f in TaipeiTree.csv TaipeiParkTree.csv; do
  if [ ! -f "data/$f" ]; then
    echo "error: infra/data/$f is missing." >&2
    echo "The raw extracts are gitignored — see infra/README.md for where they come from." >&2
    exit 1
  fi
done

echo "==> starting postgres"
docker compose up -d db

echo -n "==> waiting for postgres to be healthy"
for _ in $(seq 60); do
  status=$(docker compose ps db --format '{{.Health}}' 2>/dev/null || echo "")
  if [ "$status" = "healthy" ]; then echo " ok"; break; fi
  echo -n "."
  sleep 1
done
if [ "${status:-}" != "healthy" ]; then
  echo " failed"; echo "postgres did not become healthy; try: docker compose logs db" >&2; exit 1
fi

psql_run() {
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U taipei -d taipei -f "$1"
}

echo "==> schema"
psql_run /sql/01_schema.sql

echo "==> loading 162,930 trees (this takes a few seconds)"
psql_run /sql/02_load.sql

# Martin reads each table's columns and types once, at startup, so it must be
# restarted after a load — otherwise a schema change leaves it serving HTTP 500
# from a stale plan while /catalog still looks healthy.
echo "==> starting martin"
docker compose up -d martin
docker compose restart martin

echo
echo "done. verify with:"
echo "  curl -s localhost:3000/catalog | jq"
echo "  curl -s localhost:3000/trees | jq"
