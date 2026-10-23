-- Load the Gaussian splat captures into `splats`. Idempotent: truncates and
-- reloads. Run by load.sh after 03_checks.sql, so a bad capture never blocks
-- the trees: they are already committed when this starts.
--
-- A capture file carries no georeference, so each one is placed from control
-- points: features recognisable both in the capture and on a map, each given
-- in the capture's own coordinates (as stored, z-up, see below) and in
-- WGS84. This file solves the placement
-- from them. The app's contract for the result is
-- app/src/layers/splat/specs/spec.md, *Control points CSV → `splats` table*.
--
-- Four inputs, all overridable with `psql -v`, which is how infra/test/run.sh
-- points this same file at fixtures. Defaults are the paths docker-compose
-- mounts.
\if :{?splats_csv}
\else
  \set splats_csv '/data/3dgs/control_points.csv'
\endif
\if :{?splats_dir}
\else
  \set splats_dir '/data/3dgs/source'
\endif
\if :{?splats_lod_dir}
\else
  \set splats_lod_dir '/data/3dgs/lod'
\endif
\if :{?splats_max_rms_m}
\else
  \set splats_max_rms_m 1.0
\endif

BEGIN;

-- RESTART IDENTITY, and the insert below orders by splat_id: the same CSV
-- always produces the same MVT feature ids.
TRUNCATE splats RESTART IDENTITY;

DROP TABLE IF EXISTS stg_splat_csv, stg_splat_points, stg_splat_en, stg_splat_fit, stg_splat_resid;

-- Columns are quoted so they match the CSV header *exactly*: COPY … HEADER
-- MATCH compares against the stored, case-sensitive names, so a file with LON
-- and LAT the other way round is rejected instead of placing every capture on
-- the far side of the globe. `line` is not in the file: the identity numbers
-- the rows in file order, so an error can name the CSV line (line + 1, after
-- the header).
CREATE UNLOGGED TABLE stg_splat_csv (
  "SplatID" text, "File" text, "Point" text,
  "X" text, "Y" text, "Z" text, "LAT" text, "LON" text, "H" text, "Note" text,
  line bigint GENERATED ALWAYS AS IDENTITY
);

SET LOCAL splats.csv TO :'splats_csv';
SET LOCAL splats.dir TO :'splats_dir';
SET LOCAL splats.lod_dir TO :'splats_lod_dir';
SET LOCAL splats.max_rms_m TO :'splats_max_rms_m';

DO $$
DECLARE
  csv  text := current_setting('splats.csv');
  head text[] := ARRAY['SplatID','File','Point','X','Y','Z','LAT','LON','H','Note'];
BEGIN
  -- missing_ok: no control points at all is the normal state of a fresh
  -- checkout, not an error. The table stays empty and the map shows no splats.
  IF (pg_stat_file(csv, true)).size IS NULL THEN
    RAISE NOTICE 'splats: % is absent — no captures loaded', csv;
    RETURN;
  END IF;
  BEGIN
    EXECUTE format(
      'COPY stg_splat_csv (%s) FROM %L WITH (FORMAT csv, HEADER MATCH)',
      (SELECT string_agg(quote_ident(c), ',') FROM unnest(head) AS c), csv);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'splats: % could not be loaded: %', csv, SQLERRM
      USING HINT = 'The header must be exactly: ' || array_to_string(head, ',');
  END;
END $$;

-- Every field is trimmed: a hand-filled CSV picks up stray spaces after commas
-- (" 121.538950"), and those are typing, not data. Numbers are guarded by a
-- regex before the cast, so one 'N/A' becomes a named problem below instead of
-- an anonymous cast error. Note is never read.
CREATE UNLOGGED TABLE stg_splat_points AS
SELECT line + 1                         AS csv_line,
       nullif(btrim("SplatID"), '')     AS splat_id,
       nullif(btrim("File"), '')        AS file,
       nullif(btrim("Point"), '')       AS point,
       btrim("X") AS x_raw, btrim("Y") AS y_raw, btrim("Z") AS z_raw,
       btrim("LAT") AS lat_raw, btrim("LON") AS lon_raw, btrim("H") AS h_raw
FROM stg_splat_csv;

ALTER TABLE stg_splat_points
  ADD COLUMN x double precision, ADD COLUMN y double precision,
  ADD COLUMN z double precision, ADD COLUMN lat double precision,
  ADD COLUMN lon double precision, ADD COLUMN h double precision;

UPDATE stg_splat_points SET
  x   = CASE WHEN x_raw   ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN x_raw::double precision END,
  y   = CASE WHEN y_raw   ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN y_raw::double precision END,
  z   = CASE WHEN z_raw   ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN z_raw::double precision END,
  lat = CASE WHEN lat_raw ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN lat_raw::double precision END,
  lon = CASE WHEN lon_raw ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN lon_raw::double precision END,
  -- A blank H is a point on the ground, which is what most control points are.
  h   = CASE WHEN coalesce(h_raw, '') = '' THEN 0
             WHEN h_raw ~ '^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$' THEN h_raw::double precision END;

-- The CSV's frame is the file's. A capture's file and its control points
-- share one frame: the file's coordinates as stored, z-up, the ground on x/y
-- (app/src/layers/splat/specs/spec.md, *One frame, no conversion*). A scan's
-- poses.csv is in a frame of its own and is never read. So X, Y, Z are file coordinates as they are; file_x, file_y,
-- file_z name them for everything after this, which never reads X, Y, Z. The
-- app draws the file as stored, so the fit runs on the same coordinates.
--
-- A reading turned about up cannot be caught by the fit below: turning every
-- point about up is itself a rotation, so the similarity absorbs it and the
-- capture lands turned around its points with a good RMS (found by eye on
-- KY0917A, at heading 179°); test/run.sh keeps a case that shows it. A
-- reading mirrored, or tilted (read y-up in a viewer, ground on X/Z), cannot be
-- fitted by any rotation of the ground, and the fit checks below reject it.
ALTER TABLE stg_splat_points
  ADD COLUMN file_x double precision, ADD COLUMN file_y double precision,
  ADD COLUMN file_z double precision;

UPDATE stg_splat_points SET file_x = x, file_y = y, file_z = z;

-- The row rules. Every problem is collected before anything is raised: a
-- hand-filled file with three mistakes should report three, not one per run.
--
--   SplatID, File, Point   required. File is a bare name inside the captures
--             directory: a '/' would let a row point anywhere the database
--             can read, and the files service serves only that one directory.
--   extension .spz, and only that: build-lod.sh reads <scan>.spz alone, and
--             the app draws the LoD tree, never the file. A .ply row would pass
--             here and then always fail the LoD check, which names the wrong
--             cause.
--   the file  must exist. pg_stat_file is the database's own view of the
--             mounted directory, the same one the files service serves.
--   X Y Z LAT LON   numbers; LAT in [-90, 90], LON in [-180, 180]. A LAT/LON
--             pair the other way round is a header error above, not a range
--             error here.
--   H         a number, or blank for 0.
DO $$
DECLARE
  dir      text := current_setting('splats.dir');
  problems text[];
BEGIN
  SELECT array_agg(msg ORDER BY csv_line, msg) INTO problems FROM (
    SELECT csv_line, format('line %s: SplatID is empty', csv_line) AS msg
      FROM stg_splat_points WHERE splat_id IS NULL
    UNION ALL
    SELECT csv_line, format('line %s (%s): File is empty', csv_line, splat_id)
      FROM stg_splat_points WHERE file IS NULL
    UNION ALL
    SELECT csv_line, format('line %s (%s): Point is empty', csv_line, splat_id)
      FROM stg_splat_points WHERE point IS NULL
    UNION ALL
    SELECT csv_line, format('line %s (%s): File %L must be a bare file name, without "/"', csv_line, splat_id, file)
      FROM stg_splat_points WHERE file ~ '/'
    UNION ALL
    SELECT csv_line, format('line %s (%s): File %L is not .spz', csv_line, splat_id, file)
      FROM stg_splat_points WHERE file !~ '\.spz$'
    UNION ALL
    SELECT csv_line, format('line %s (%s): File %L is not in %s', csv_line, splat_id, file, dir)
      FROM stg_splat_points
      WHERE file IS NOT NULL AND file !~ '/'
        AND (pg_stat_file(dir || '/' || file, true)).isdir IS DISTINCT FROM false
    UNION ALL
    SELECT csv_line, format('line %s (%s): %s %L is not a number', csv_line, splat_id, col, raw)
      FROM stg_splat_points,
           LATERAL (VALUES ('X', x_raw, x), ('Y', y_raw, y), ('Z', z_raw, z),
                           ('LAT', lat_raw, lat), ('LON', lon_raw, lon), ('H', h_raw, h)) AS v(col, raw, val)
      WHERE val IS NULL
    UNION ALL
    SELECT csv_line, format('line %s (%s): LAT %s is outside [-90, 90]', csv_line, splat_id, lat)
      FROM stg_splat_points WHERE lat NOT BETWEEN -90 AND 90
    UNION ALL
    SELECT csv_line, format('line %s (%s): LON %s is outside [-180, 180]', csv_line, splat_id, lon)
      FROM stg_splat_points WHERE lon NOT BETWEEN -180 AND 180
  ) p;

  IF problems IS NOT NULL THEN
    RAISE EXCEPTION E'splats: % problem(s) in the control points:\n  %',
      cardinality(problems), array_to_string(problems, E'\n  ')
      USING HINT = 'Each row is one control point: SplatID,File,Point,X,Y,Z,LAT,LON,H,Note.';
  END IF;
END $$;

-- The capture rules, over the rows of one SplatID:
--
--   one File   every row of a capture names the same file, and no file
--              belongs to two captures. Either mistake would place the same
--              splats twice, or one capture from another's points.
--   Point      unique within the capture, so a row pasted twice is caught
--              rather than silently weighting the fit.
--   >= 3 points   the similarity has four unknowns; three points give six
--              equations, which leaves a residual to check. Two points fit
--              exactly whatever they are, so they prove nothing.
--   >= 2 m apart  two points closer than that, in file x/y, carry the
--              clicking error of one point twice and the shape of none.
--   not in a line   the smallest singular value of the centred file x/y must
--              be at least 2 m. Points along one line fix the rotation and the
--              scale along it, and nothing across it.
--   its LoD    <stem>-lod.rad (File less its extension) is in the LoD
--              directory. The app draws that tree, not File, and derives its
--              name this way (app/src/layers/splat/schema.ts, lodUrlOf). A
--              capture without one would load here and never draw; build it
--              with ./scripts/build-lod.sh <stem>. Only the header is checked: its
--              chunk files (<stem>-lod-<n>.radc) are named inside it, and
--              build-lod.sh checks every one before it writes the header.
DO $$
DECLARE
  lod_dir  text := current_setting('splats.lod_dir');
  problems text[];
BEGIN
  SELECT array_agg(msg ORDER BY msg) INTO problems FROM (
    SELECT format('%s: its rows name %s files (%s)', splat_id, count(DISTINCT file),
                  string_agg(DISTINCT file, ', ')) AS msg
      FROM stg_splat_points GROUP BY splat_id HAVING count(DISTINCT file) > 1
    UNION ALL
    SELECT format('%s is used by %s captures (%s)', file, count(DISTINCT splat_id),
                  string_agg(DISTINCT splat_id, ', '))
      FROM stg_splat_points GROUP BY file HAVING count(DISTINCT splat_id) > 1
    UNION ALL
    SELECT format('%s: Point %s appears %s times (lines %s)', splat_id, point, count(*),
                  string_agg(csv_line::text, ', ' ORDER BY csv_line))
      FROM stg_splat_points GROUP BY splat_id, point HAVING count(*) > 1
    UNION ALL
    SELECT format('%s: %s control point(s); at least 3 are needed', splat_id, count(*))
      FROM stg_splat_points GROUP BY splat_id HAVING count(*) < 3
    UNION ALL
    SELECT format('%s: Points %s and %s are %s m apart on the ground (X/Y); at least 2 m is needed',
                  a.splat_id, a.point, b.point,
                  round(sqrt((a.file_x - b.file_x)^2 + (a.file_y - b.file_y)^2)::numeric, 3))
      FROM stg_splat_points a
      JOIN stg_splat_points b ON a.splat_id = b.splat_id AND a.csv_line < b.csv_line
      WHERE sqrt((a.file_x - b.file_x)^2 + (a.file_y - b.file_y)^2) < 2
    UNION ALL
    -- The singular values of the centred n×2 matrix are the square roots of
    -- the eigenvalues of its 2×2 scatter matrix [[sxx, sxy], [sxy, syy]].
    SELECT format('%s: the points are too close to a line (spread across it is %s m; at least 2 m is needed)',
                  splat_id, round(sigma_min::numeric, 3))
      FROM (
        SELECT splat_id,
               sqrt(greatest(0, (sxx + syy) / 2 - sqrt(((sxx - syy) / 2)^2 + sxy^2))) AS sigma_min
        FROM (
          SELECT splat_id,
                 sum((file_x - mx)^2) AS sxx, sum((file_y - my)^2) AS syy,
                 sum((file_x - mx) * (file_y - my)) AS sxy
          FROM (SELECT p.*, avg(file_x) OVER w AS mx, avg(file_y) OVER w AS my
                FROM stg_splat_points p WINDOW w AS (PARTITION BY splat_id)) c
          GROUP BY splat_id
          HAVING count(*) >= 3
        ) s
      ) t
      WHERE sigma_min < 2
    UNION ALL
    SELECT format('%s: its LoD %s is not in %s (run ./scripts/build-lod.sh %s)', splat_id, lod, lod_dir, stem)
      FROM (SELECT DISTINCT splat_id, stem, stem || '-lod.rad' AS lod
            FROM (SELECT splat_id, regexp_replace(file, '\.[^.]*$', '') AS stem
                  FROM stg_splat_points WHERE file IS NOT NULL) f) l
      WHERE (pg_stat_file(lod_dir || '/' || lod, true)).isdir IS DISTINCT FROM false
  ) p;

  IF problems IS NOT NULL THEN
    RAISE EXCEPTION E'splats: % problem(s) with the captures:\n  %',
      cardinality(problems), array_to_string(problems, E'\n  ');
  END IF;
END $$;

-- The solve, per capture. Set-based rather than a loop: each step is one
-- aggregate over the capture's points.
--
-- 1. Project LAT/LON to true metres east and north of the points' centroid,
--    equirectangular on the WGS 84 ellipsoid with the radii at the centroid's
--    latitude φ0: east = N(φ0)·cos(φ0)·Δλ and north = M(φ0)·Δφ (radians), N
--    the prime-vertical radius and M the meridian radius. A capture is metric,
--    in true metres, so the fit is too. The map is spherical Web Mercator and
--    stretches true metres unevenly (~0.4% more north–south than east–west
--    here); no uniform scale absorbs that, so the app draws each axis with its
--    own map-metres-per-true-metre instead (app/src/layers/splat/specs/spec.md,
--    *The frame*). Over ~300 m the equirectangular step is exact to under 5 mm.
-- 2. Fit the 2D similarity  E = a·x − b·y + tE,  N = b·x + a·y + tN  (file x, y) by least
--    squares — the closed-form Helmert solution on centred coordinates. The
--    scale is sqrt(a² + b²), and the file's +y axis points along (−b, a),
--    so its heading clockwise from north is atan2(−b, a).
-- 3. The vertical offset is mean(H − scale·file z): the capture's ground is set on
--    the map's ground through the points' heights.
-- 4. The origin is (tE, tN), where file (0, 0) lands, projected back through
--    the same radii.
--
-- Each point's east/north is computed once, here, and read by both the fit and
-- the residuals, so the projection is written in one place.
CREATE UNLOGGED TABLE stg_splat_en AS
WITH proj AS (
  SELECT p.*,
         avg(lat) OVER w AS lat0,
         avg(lon) OVER w AS lon0
  FROM stg_splat_points p
  WINDOW w AS (PARTITION BY splat_id)
),
radii AS (
  -- WGS 84: a = 6378137 m, f = 1/298.257223563, e² = f·(2 − f). Written only
  -- here: rn and rm travel with the fit to the inverse in the insert below.
  SELECT proj.*,
         6378137.0 / sqrt(1 - w.e2 * sin(radians(lat0))^2)                     AS rn,
         6378137.0 * (1 - w.e2) / power(1 - w.e2 * sin(radians(lat0))^2, 1.5) AS rm
  FROM proj, (SELECT f * (2 - f) AS e2 FROM (SELECT 1 / 298.257223563::double precision AS f) f) w
)
SELECT radii.*,
       rn * cos(radians(lat0)) * radians(lon - lon0) AS e,
       rm * radians(lat - lat0)                      AS n
FROM radii;

CREATE UNLOGGED TABLE stg_splat_fit AS
WITH centred AS (
  SELECT stg_splat_en.*,
         file_x - avg(file_x) OVER w AS dx, file_y - avg(file_y) OVER w AS dy,
         e - avg(e) OVER w AS de, n - avg(n) OVER w AS dn
  FROM stg_splat_en
  WINDOW w AS (PARTITION BY splat_id)
),
coef AS (
  SELECT splat_id, min(file) AS file, count(*) AS points,
         min(lat0) AS lat0, min(lon0) AS lon0, min(rn) AS rn, min(rm) AS rm,
         sum(dx * de + dy * dn) / sum(dx * dx + dy * dy) AS a,
         sum(dx * dn - dy * de) / sum(dx * dx + dy * dy) AS b,
         avg(file_x) AS mx, avg(file_y) AS my, avg(e) AS me, avg(n) AS mn
  FROM centred
  GROUP BY splat_id
)
SELECT c.*,
       sqrt(a * a + b * b)                               AS scale,
       me - a * mx + b * my                              AS te,
       mn - b * mx - a * my                              AS tn,
       mod(degrees(atan2(-b, a))::numeric + 360, 360)::double precision AS heading_deg
FROM coef c;

ALTER TABLE stg_splat_fit ADD COLUMN rms_m double precision, ADD COLUMN altitude_m double precision;

-- Per-point residuals, kept so the report can name the point that does not fit.
CREATE UNLOGGED TABLE stg_splat_resid AS
SELECT p.splat_id, p.point, p.csv_line,
       sqrt((f.a * p.file_x - f.b * p.file_y + f.te - p.e)^2
          + (f.b * p.file_x + f.a * p.file_y + f.tn - p.n)^2) AS resid_m,
       p.h - f.scale * p.file_z AS dz_m
FROM stg_splat_en p JOIN stg_splat_fit f USING (splat_id);

UPDATE stg_splat_fit f SET
  rms_m      = r.rms,
  altitude_m = r.alt
FROM (SELECT splat_id, sqrt(avg(resid_m ^ 2)) AS rms, avg(dz_m) AS alt
      FROM stg_splat_resid GROUP BY splat_id) r
WHERE r.splat_id = f.splat_id;

-- The fit rules. They fail the load rather than load a capture somewhere
-- plausible and wrong:
--
--   rms_m <= splats_max_rms_m (default 1 m)   a typo in one coordinate, two
--             points swapped between rows, or X/Y/Z read in a frame other
--             than the file's (a y-up viewer's) all show up here: a
--             similarity cannot bend to fit them. A mirrored frame is the
--             same: no rotation fits a reflection. (y-up points that all lie
--             on the ground are caught even earlier: their X/Y collapse onto
--             a line.)
--   scale in [0.8, 1.25]   the captures are metric, so a scale far from 1
--             means the points are wrong, not that the capture is.
\echo ''
\echo '--- splats: control point residuals (m) ---'
SELECT splat_id, point, csv_line AS line, round(resid_m::numeric, 3) AS horizontal,
       round((dz_m - f.altitude_m)::numeric, 3) AS vertical
FROM stg_splat_resid JOIN stg_splat_fit f USING (splat_id)
ORDER BY splat_id, csv_line;

DO $$
DECLARE
  max_rms  double precision := current_setting('splats.max_rms_m')::double precision;
  problems text[];
BEGIN
  SELECT array_agg(msg ORDER BY msg) INTO problems FROM (
    SELECT format('%s: the control points fit with an RMS of %s m; at most %s m is accepted (worst: Point %s, %s m off)',
                  f.splat_id, round(f.rms_m::numeric, 3), max_rms, w.point, round(w.resid_m::numeric, 3)) AS msg
      FROM stg_splat_fit f
      JOIN LATERAL (SELECT point, resid_m FROM stg_splat_resid r
                    WHERE r.splat_id = f.splat_id ORDER BY resid_m DESC LIMIT 1) w ON true
      WHERE f.rms_m > max_rms
    UNION ALL
    SELECT format('%s: the fit''s scale is %s; it must be within [0.8, 1.25], since the captures are metric',
                  splat_id, round(scale::numeric, 4))
      FROM stg_splat_fit WHERE scale NOT BETWEEN 0.8 AND 1.25
  ) p;

  IF problems IS NOT NULL THEN
    RAISE EXCEPTION E'splats: % capture(s) do not fit their control points:\n  %',
      cardinality(problems), array_to_string(problems, E'\n  ')
      USING HINT = 'Check the points named, and that X/Y/Z are the capture''s own coordinates as stored (z-up, as in its PLY''s georeference, not its poses.csv), not a y-up viewer''s.';
  END IF;
END $$;

INSERT INTO splats (splat_id, file, bytes, altitude_m, heading_deg, scale, rms_m, points, geom)
SELECT splat_id, file,
       (pg_stat_file(current_setting('splats.dir') || '/' || file)).size,
       altitude_m, heading_deg, scale, rms_m, points,
       ST_SetSRID(ST_MakePoint(lon0 + degrees(te / (rn * cos(radians(lat0)))),
                               lat0 + degrees(tn / rm)), 4326)
FROM stg_splat_fit
ORDER BY splat_id;

DROP TABLE stg_splat_csv, stg_splat_points, stg_splat_en, stg_splat_fit, stg_splat_resid;

ANALYZE splats;

COMMIT;

\echo ''
\echo '--- splats: loaded ---'
SELECT splat_id, file, points,
       round(rms_m::numeric, 3)        AS rms_m,
       round(scale::numeric, 4)        AS scale,
       round(heading_deg::numeric, 2)  AS heading_deg,
       round(altitude_m::numeric, 2)   AS altitude_m,
       round(ST_Y(geom)::numeric, 7)   AS origin_lat,
       round(ST_X(geom)::numeric, 7)   AS origin_lon,
       pg_size_pretty(bytes)           AS size
FROM splats ORDER BY splat_id;
