-- Load the Gaussian splat captures into `splats`. Idempotent: truncates and
-- reloads. Run by load.sh after 03_checks.sql, so a bad capture never blocks
-- the trees: they are already committed when this starts.
--
-- A capture is a tile of the mosaic (scripts/splat-mosaic.mjs,
-- specs/splat-mosaic.md), placed from its row of data/3dgs/georef.csv, which
-- the mosaic writes: one 100 m tile, stored as (E, N, h) less its offset in
-- the UTM zone EPSG names, so:
--
--   origin       (OFFSETX, OFFSETY) in EPSG, to WGS 84: where local (0, 0)
--                lands, the tile's centre.
--   heading_deg  the file's +y is grid north: the geodesic azimuth from the
--                origin to the point 100 m grid-north of it. That is 360° plus
--                the grid convergence, 359.38° in Taipei's UTM 51N.
--   scale        one file unit is a grid metre: the geodesic length of those
--                100 grid metres, over 100, which is 1/k, k UTM's point scale.
--   ground_z     GROUNDZ − OFFSETZ: the capture's ground as a local z, which
--                the app draws at the map's ground. The map has no terrain, so
--                an ellipsoidal height cannot be drawn as it is; each capture
--                is grounded on its own instead, and nothing is computed
--                across captures (app/src/layers/splat/specs/spec.md, *The
--                ground*). A tile's OFFSETZ is 0 and its z the ellipsoidal
--                height, so its ground_z is GROUNDZ, the mosaic's estimate.
--
-- Over 100 m the azimuth is exact to under 1e-5° and the length to well under
-- a millimetre. The app's contract is app/src/layers/splat/specs/spec.md,
-- *Georeference CSV → `splats` table*.
--
-- The inputs are all overridable with `psql -v`, which is how
-- infra/test/run.sh points this same file at fixtures. Defaults are the paths
-- docker-compose mounts.
\if :{?splats_georef}
\else
  \set splats_georef '/data/3dgs/georef.csv'
\endif
\if :{?splats_dir}
\else
  \set splats_dir '/data/3dgs/tiles'
\endif
\if :{?splats_lod_dir}
\else
  \set splats_lod_dir '/data/3dgs/lod'
\endif

-- The rules on a capture's File, each returning its problems as messages
-- without the line (the caller adds it):
--
--   File      required, and a bare name inside the tiles directory: a '/'
--             would let a row point anywhere the database can read, and the
--             files service serves only that one directory.
--   extension .ply, and only that, in lower case: build-lod.sh reads
--             <tile>.ply alone, and the app draws the LoD tree, never the
--             file. Any other row would pass here and then always fail the
--             LoD check, which names the wrong cause.
--   the file  must exist. pg_stat_file is the database's own view of the
--             mounted directory, the same one the files service serves.
--   its LoD   <stem>-lod.rad (File less its extension) is in the LoD
--             directory. The app draws that tree, not File, and derives its
--             name this way (app/src/layers/splat/schema.ts, lodUrlOf). A
--             capture without one would load and never draw; build it with
--             ./scripts/build-lod.sh <stem>. Only the header is checked: its
--             chunk files (<stem>-lod-<n>.radc) are named inside it, and
--             build-lod.sh checks every one before it writes the header.
--
-- Temporary functions: they live as long as this session, and the schema
-- (01_schema.sql) stays the tables alone.
CREATE OR REPLACE FUNCTION pg_temp.splat_file_problems(file text, dir text) RETURNS SETOF text
LANGUAGE sql AS $$
  SELECT 'File is empty' WHERE file IS NULL
  UNION ALL
  SELECT format('File %L must be a bare file name, without "/"', file) WHERE file ~ '/'
  UNION ALL
  SELECT format('File %L is not .ply', file) WHERE file !~ '\.ply$'
  UNION ALL
  SELECT format('File %L is not in %s', file, dir)
  WHERE file IS NOT NULL AND file !~ '/'
    AND (pg_stat_file(dir || '/' || file, true)).isdir IS DISTINCT FROM false
$$;

-- A decimal number, optionally signed and with an exponent: the only text
-- a georef.csv number may be. NULL for anything else, so the rule below
-- reports it instead of the cast raising.
CREATE OR REPLACE FUNCTION pg_temp.splat_number(raw text) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN raw ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN raw::double precision END
$$;

CREATE OR REPLACE FUNCTION pg_temp.splat_lod_problems(splat_id text, file text, lod_dir text) RETURNS SETOF text
LANGUAGE sql AS $$
  SELECT format('%s: its LoD %s is not in %s (run ./scripts/build-lod.sh %s)', splat_id, lod, lod_dir, stem)
  FROM (SELECT stem, stem || '-lod.rad' AS lod
        FROM (SELECT regexp_replace(file, '\.[^.]*$', '') AS stem) s) l
  WHERE file IS NOT NULL AND file !~ '/'
    AND (pg_stat_file(lod_dir || '/' || lod, true)).isdir IS DISTINCT FROM false
$$;

\echo 'splats: the mosaic''s tiles, placed by georef.csv'

BEGIN;

TRUNCATE splats RESTART IDENTITY;

DROP TABLE IF EXISTS stg_georef_csv, stg_georef;

-- Columns are quoted so they match the CSV header *exactly*: COPY … HEADER
-- MATCH compares against the stored, case-sensitive names, so OFFSETX and
-- OFFSETY the other way round is a header error, not a capture on the far side
-- of the zone. `line` is not in the file: the identity numbers the rows in
-- file order, so an error can name the CSV line (line + 1, after the header).
CREATE UNLOGGED TABLE stg_georef_csv (
  "SplatID" text, "File" text, "EPSG" text, "OFFSETX" text, "OFFSETY" text, "OFFSETZ" text, "GROUNDZ" text,
  line bigint GENERATED ALWAYS AS IDENTITY
);

SET LOCAL splats.georef TO :'splats_georef';
SET LOCAL splats.dir TO :'splats_dir';
SET LOCAL splats.lod_dir TO :'splats_lod_dir';
DO $$
DECLARE
  csv  text := current_setting('splats.georef');
  head text[] := ARRAY['SplatID','File','EPSG','OFFSETX','OFFSETY','OFFSETZ','GROUNDZ'];
BEGIN
  -- missing_ok: no georef.csv is a fresh checkout, not an error. The table
  -- stays empty and the map shows no splats.
  IF (pg_stat_file(csv, true)).size IS NULL THEN
    RAISE NOTICE 'splats: % is absent — no captures loaded (write it with node scripts/splat-mosaic.mjs)', csv;
    RETURN;
  END IF;
  BEGIN
    EXECUTE format(
      'COPY stg_georef_csv (%s) FROM %L WITH (FORMAT csv, HEADER MATCH)',
      (SELECT string_agg(quote_ident(c), ',') FROM unnest(head) AS c), csv);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'splats: % could not be loaded: %', csv, SQLERRM
      USING HINT = 'The header must be exactly: ' || array_to_string(head, ',');
  END;
END $$;

CREATE UNLOGGED TABLE stg_georef AS
SELECT line + 1                     AS csv_line,
       nullif(btrim("SplatID"), '') AS splat_id,
       nullif(btrim("File"), '')    AS file,
       btrim("EPSG") AS epsg_raw, btrim("OFFSETX") AS ox_raw,
       btrim("OFFSETY") AS oy_raw, btrim("OFFSETZ") AS oz_raw,
       btrim("GROUNDZ") AS gz_raw
FROM stg_georef_csv;

ALTER TABLE stg_georef
  ADD COLUMN epsg integer, ADD COLUMN ox double precision,
  ADD COLUMN oy double precision, ADD COLUMN oz double precision,
  ADD COLUMN gz double precision;

UPDATE stg_georef SET
  epsg = CASE WHEN epsg_raw ~ '^\d{1,9}$' THEN epsg_raw::integer END,
  ox   = pg_temp.splat_number(ox_raw),
  oy   = pg_temp.splat_number(oy_raw),
  oz   = pg_temp.splat_number(oz_raw),
  gz   = pg_temp.splat_number(gz_raw);

-- The rules, all collected before anything is raised:
--
--   SplatID, File   required, and each on one row only: a capture placed
--             twice, or one file under two ids, is a mistake either way.
--   File      the File and LoD rules above (splat_file_problems,
--             splat_lod_problems).
--   EPSG      WGS 84 / UTM, 32601–32660 north or 32701–32760 south: the only
--             CRS whose grid north and point scale the placement assumes, and
--             the only one the mosaic writes.
--   OFFSET*, GROUNDZ  numbers.
DO $$
DECLARE
  dir      text := current_setting('splats.dir');
  lod_dir  text := current_setting('splats.lod_dir');
  problems text[];
BEGIN
  SELECT array_agg(msg ORDER BY ord, msg) INTO problems FROM (
    SELECT csv_line AS ord, format('line %s: SplatID is empty', csv_line) AS msg
      FROM stg_georef WHERE splat_id IS NULL
    UNION ALL
    SELECT csv_line, format('line %s (%s): %s', csv_line, splat_id, problem)
      FROM stg_georef, pg_temp.splat_file_problems(file, dir) AS problem
    UNION ALL
    SELECT csv_line, format('line %s (%s): EPSG %L is not WGS 84 / UTM (32601–32660, 32701–32760)', csv_line, splat_id, epsg_raw)
      FROM stg_georef WHERE epsg IS NULL OR NOT (epsg BETWEEN 32601 AND 32660 OR epsg BETWEEN 32701 AND 32760)
    UNION ALL
    SELECT csv_line, format('line %s (%s): %s %L is not a number', csv_line, splat_id, col, raw)
      FROM stg_georef,
           LATERAL (VALUES ('OFFSETX', ox_raw, ox), ('OFFSETY', oy_raw, oy), ('OFFSETZ', oz_raw, oz), ('GROUNDZ', gz_raw, gz)) AS v(col, raw, val)
      WHERE val IS NULL
    UNION ALL
    SELECT min(csv_line), format('%s appears on %s rows (lines %s)', splat_id, count(*),
                                 string_agg(csv_line::text, ', ' ORDER BY csv_line))
      FROM stg_georef WHERE splat_id IS NOT NULL GROUP BY splat_id HAVING count(*) > 1
    UNION ALL
    SELECT min(csv_line), format('%s is used by %s captures (%s)', file, count(*),
                                 string_agg(coalesce(splat_id, '?'), ', ' ORDER BY csv_line))
      FROM stg_georef WHERE file IS NOT NULL GROUP BY file HAVING count(*) > 1
    UNION ALL
    SELECT csv_line, problem
      FROM stg_georef, pg_temp.splat_lod_problems(splat_id, file, lod_dir) AS problem
  ) p;

  IF problems IS NOT NULL THEN
    RAISE EXCEPTION E'splats: % problem(s) in the georeferences:\n  %',
      cardinality(problems), array_to_string(problems, E'\n  ')
      USING HINT = 'Each row is one capture: SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ,GROUNDZ, as scripts/splat-mosaic.mjs writes it.';
  END IF;
END $$;

\echo ''
\echo '--- splats: grounds (m) ---'
SELECT splat_id, oz AS offsetz, gz AS groundz, round((gz - oz)::numeric, 3) AS ground_z
FROM stg_georef ORDER BY splat_id;

-- Ordered by splat_id, after RESTART IDENTITY: the same CSV always gives the
-- same MVT feature ids.
INSERT INTO splats (splat_id, file, bytes, ground_z, heading_deg, scale, geom)
SELECT splat_id, file,
       (pg_stat_file(current_setting('splats.dir') || '/' || file)).size,
       gz - oz,
       mod(degrees(ST_Azimuth(o::geography, p::geography))::numeric + 360, 360)::double precision,
       ST_Distance(o::geography, p::geography) / 100,
       o
FROM (SELECT splat_id, file, oz, gz,
             ST_Transform(ST_SetSRID(ST_MakePoint(ox, oy), epsg), 4326)       AS o,
             ST_Transform(ST_SetSRID(ST_MakePoint(ox, oy + 100), epsg), 4326) AS p
      FROM stg_georef) g
ORDER BY splat_id;

DROP TABLE stg_georef_csv, stg_georef;

ANALYZE splats;

COMMIT;

\echo ''
\echo '--- splats: loaded ---'
SELECT splat_id, file,
       round(scale::numeric, 4)        AS scale,
       round(heading_deg::numeric, 2)  AS heading_deg,
       round(ground_z::numeric, 3)     AS ground_z,
       round(ST_Y(geom)::numeric, 7)   AS origin_lat,
       round(ST_X(geom)::numeric, 7)   AS origin_lon,
       pg_size_pretty(bytes)           AS size
FROM splats ORDER BY splat_id;
