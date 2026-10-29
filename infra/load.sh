#!/usr/bin/env bash
# Bring up Postgres, create the schema, load the extracts and any custom
# drop-ins, check the result, load the splat captures, then start Martin and
# the files service.
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

# psql_run <file> [psql args…]: the extra arguments go before -f, e.g. -v name=value.
psql_run() {
  local file=$1; shift
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U taipei -d taipei "$@" -f "$file"
}

echo "==> schema"
psql_run /sql/01_schema.sql

# The two extracts are ~163,000 rows; data/custom/ is optional and usually
# small. The loader discovers the drop-ins itself — see sql/02_load.sql.
if compgen -G "data/custom/*.csv" > /dev/null; then
  echo "==> loading the extracts and $(ls data/custom/*.csv | wc -l | tr -d ' ') custom drop-in(s) (this takes a few seconds)"
else
  echo "==> loading the extracts (this takes a few seconds)"
fi
psql_run /sql/02_load.sql

echo "==> checks"
psql_run /sql/03_checks.sql

# The splat captures load after the trees are committed and checked, in their
# own transaction: a bad row fails this step and leaves the trees, and the rest
# of the bring-up, alone. SPLATS_PLACEMENT picks how they are placed: `header`
# (the default) from data/3dgs/georef.csv, or `control_points` from
# data/3dgs/control_points.csv, whose report prints each capture's fit
# (rms_m, scale, heading_deg) and every point's residual.
placement=${SPLATS_PLACEMENT:-header}
echo "==> splat captures (placed by $placement)"
splats_ok=1
psql_run /sql/04_splats.sql -v splats_placement="$placement" || splats_ok=0

# Martin reads each table's columns and types once, at startup, so it must be
# restarted after a load — otherwise a schema change leaves it serving HTTP 500
# from a stale plan while /catalog still looks healthy.
echo "==> starting martin"
docker compose up -d martin
docker compose restart martin

echo "==> starting the files service (splat captures)"
docker compose up -d files

echo
echo "done. verify with:"
echo "  curl -s localhost:${MARTIN_PORT:-3000}/catalog | jq"
echo "  curl -s localhost:${MARTIN_PORT:-3000}/trees | jq"
echo "  curl -sI localhost:${FILES_PORT:-3080}/3dgs/<file>.spz"
echo "  curl -sI localhost:${FILES_PORT:-3080}/3dgs-lod/<scan>-lod.rad"
if [ "${MARTIN_PORT:-3000}" != "3000" ]; then
  echo "and start the app with TILES_PROXY_TARGET=http://localhost:${MARTIN_PORT}"
fi
if [ "${FILES_PORT:-3080}" != "3080" ]; then
  echo "and start the app with FILES_PROXY_TARGET=http://localhost:${FILES_PORT}"
fi

if [ "$splats_ok" = 0 ]; then
  echo
  echo "error: the splat captures did not load (see above); the trees did." >&2
  if [ "$placement" = control_points ]; then
    echo "Fix data/3dgs/control_points.csv and re-run ./load.sh." >&2
  else
    echo "Fix data/3dgs/georef.csv (node scripts/georef.mjs writes it) and re-run ./load.sh." >&2
  fi
  exit 1
fi
