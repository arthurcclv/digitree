-- The `header` way of placing the splat captures, included by 04_splats.sql
-- when splats_placement is `header` (its default). Never run on its own: the
-- psql variables it reads are set there.
--
-- Each capture is placed from its scan's PLY header alone, through
-- data/3dgs/georef.csv, which scripts/georef.mjs copies out of each header
-- (specs/georef.md). The PLY stores a point at UTM (E, N, h) in the zone EPSG
-- names as (E − OFFSETX, N − OFFSETY, h − OFFSETZ), so:
--
--   origin       (OFFSETX, OFFSETY) in EPSG, to WGS 84: where local (0, 0) lands.
--   heading_deg  the file's +y is grid north: the geodesic azimuth from the
--                origin to the point 100 m grid-north of it. That is 360° plus
--                the grid convergence, 359.38° in Taipei's UTM 51N.
--   scale        one file unit is a grid metre: the geodesic length of those
--                100 grid metres, over 100, which is 1/k, k UTM's point scale.
--   altitude_m   OFFSETZ − datum. OFFSETZ is the origin's RTK height (WGS 84
--                ellipsoidal), which the map, having no terrain, cannot draw as
--                it is. The datum is one height per group of captures (below),
--                so captures that may meet keep their heights relative to each
--                other exactly, and the group lands near the map's ground.
--
-- The datum (app/src/layers/splat/specs/spec.md, *The datum*). Sort the
-- captures by OFFSETZ; where two neighbours differ by more than
-- splats_datum_gap_m (default 5 m), a new group starts. A group's datum is its
-- median OFFSETZ. Only OFFSETZ is used: a capture's ground and its antenna
-- height are estimates, OFFSETZ is RTK's. So the origins, each the antenna at
-- its scan's first fix, land near 0, and the captures' ground some 1.5 m
-- below. Height alone decides a group, so a gap smaller than the default can
-- split captures that overlap (KZ0918-093638 and KZ0918-101007-1 share an
-- origin and differ by 1.24 m).
--
-- Over 100 m the azimuth is exact to under 1e-5° and the length to well under
-- a millimetre. control_points.csv is not read. The app's contract is
-- app/src/layers/splat/specs/spec.md, *Georeference CSV → `splats` table*.

BEGIN;

TRUNCATE splats RESTART IDENTITY;

DROP TABLE IF EXISTS stg_georef_csv, stg_georef;

-- Quoted columns and HEADER MATCH, as for the control points: OFFSETX and
-- OFFSETY the other way round is a header error, not a capture on the far side
-- of the zone.
CREATE UNLOGGED TABLE stg_georef_csv (
  "SplatID" text, "File" text, "EPSG" text, "OFFSETX" text, "OFFSETY" text, "OFFSETZ" text,
  line bigint GENERATED ALWAYS AS IDENTITY
);

SET LOCAL splats.georef TO :'splats_georef';
SET LOCAL splats.dir TO :'splats_dir';
SET LOCAL splats.lod_dir TO :'splats_lod_dir';
SET LOCAL splats.datum_gap_m TO :'splats_datum_gap_m';

DO $$
DECLARE
  gap text := current_setting('splats.datum_gap_m');
BEGIN
  -- Matched first: the cast must not run on a value the pattern refused, and
  -- SQL does not promise to evaluate an OR left to right.
  IF gap ~ '^\+?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN
    IF gap::double precision > 0 THEN
      RETURN;
    END IF;
  END IF;
  RAISE EXCEPTION 'splats: splats_datum_gap_m is %; it must be a positive number of metres',
    quote_literal(gap);
END $$;

DO $$
DECLARE
  csv  text := current_setting('splats.georef');
  head text[] := ARRAY['SplatID','File','EPSG','OFFSETX','OFFSETY','OFFSETZ'];
BEGIN
  -- missing_ok, as for control_points.csv: no georef.csv is a fresh checkout.
  IF (pg_stat_file(csv, true)).size IS NULL THEN
    RAISE NOTICE 'splats: % is absent — no captures loaded (write it with node scripts/georef.mjs)', csv;
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
       btrim("OFFSETY") AS oy_raw, btrim("OFFSETZ") AS oz_raw
FROM stg_georef_csv;

ALTER TABLE stg_georef
  ADD COLUMN epsg integer, ADD COLUMN ox double precision,
  ADD COLUMN oy double precision, ADD COLUMN oz double precision;

UPDATE stg_georef SET
  epsg = CASE WHEN epsg_raw ~ '^\d{1,9}$' THEN epsg_raw::integer END,
  ox   = CASE WHEN ox_raw ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN ox_raw::double precision END,
  oy   = CASE WHEN oy_raw ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN oy_raw::double precision END,
  oz   = CASE WHEN oz_raw ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN oz_raw::double precision END;

-- The rules, all collected before anything is raised:
--
--   SplatID, File   required, and each on one row only: a capture placed
--             twice, or one file under two ids, is a mistake either way.
--   File      04_splats.sql's File and LoD rules (splat_file_problems,
--             splat_lod_problems), the same for both placements.
--   EPSG      WGS 84 / UTM, 32601–32660 north or 32701–32760 south: the only
--             CRS whose grid north and point scale the placement assumes, and
--             the only one georef.mjs writes.
--   OFFSET*   numbers.
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
           LATERAL (VALUES ('OFFSETX', ox_raw, ox), ('OFFSETY', oy_raw, oy), ('OFFSETZ', oz_raw, oz)) AS v(col, raw, val)
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
      USING HINT = 'Each row is one capture: SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ, as scripts/georef.mjs writes it.';
  END IF;
END $$;

-- The groups and their datums: a running count of the gaps over the
-- threshold numbers each capture's group, in OFFSETZ order. Ties in OFFSETZ
-- are a gap of 0, never a split, so their order does not matter.
ALTER TABLE stg_georef ADD COLUMN grp integer, ADD COLUMN datum double precision;

UPDATE stg_georef g SET grp = n.grp
FROM (SELECT splat_id, 1 + count(*) FILTER (WHERE gap > current_setting('splats.datum_gap_m')::double precision)
                              OVER (ORDER BY oz, splat_id) AS grp
      FROM (SELECT splat_id, oz, oz - lag(oz) OVER (ORDER BY oz, splat_id) AS gap FROM stg_georef) s) n
WHERE n.splat_id = g.splat_id;

UPDATE stg_georef g SET datum = d.datum
FROM (SELECT grp, percentile_cont(0.5) WITHIN GROUP (ORDER BY oz) AS datum
      FROM stg_georef GROUP BY grp) d
WHERE d.grp = g.grp;

\echo ''
\echo '--- splats: datum groups (m) ---'
SELECT grp AS "group", splat_id, round(oz::numeric, 3) AS offsetz,
       round(datum::numeric, 3) AS datum, round((oz - datum)::numeric, 3) AS altitude_m
FROM stg_georef ORDER BY grp, oz, splat_id;

-- Ordered by splat_id, after RESTART IDENTITY: the same CSV always gives the
-- same MVT feature ids.
INSERT INTO splats (splat_id, file, bytes, altitude_m, heading_deg, scale, rms_m, points, geom)
SELECT splat_id, file,
       (pg_stat_file(current_setting('splats.dir') || '/' || file)).size,
       oz - datum,
       mod(degrees(ST_Azimuth(o::geography, p::geography))::numeric + 360, 360)::double precision,
       ST_Distance(o::geography, p::geography) / 100,
       NULL, NULL, o
FROM (SELECT splat_id, file, oz, datum,
             ST_Transform(ST_SetSRID(ST_MakePoint(ox, oy), epsg), 4326)       AS o,
             ST_Transform(ST_SetSRID(ST_MakePoint(ox, oy + 100), epsg), 4326) AS p
      FROM stg_georef) g
ORDER BY splat_id;

DROP TABLE stg_georef_csv, stg_georef;

ANALYZE splats;

COMMIT;
