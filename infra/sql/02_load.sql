-- Load every extract into `trees`. Idempotent: truncates and reloads.
--
-- The files do not share a column order, so each gets its own staging table.
-- Everything lands as text first: the raw data carries values that are not
-- valid in their nominal type (see the cleaning rules below), and a failed COPY
-- tells you far less than a failed transform.
--
-- Three inputs, all overridable with `psql -v`, which is how infra/test/run.sh
-- points this same file at fixture CSVs in a scratch database instead of at the
-- real extracts. Defaults are the paths docker-compose mounts.
\if :{?street_csv}
\else
  \set street_csv '/data/TaipeiTree.csv'
\endif
\if :{?park_csv}
\else
  \set park_csv '/data/TaipeiParkTree.csv'
\endif
\if :{?custom_dir}
\else
  \set custom_dir '/data/custom'
\endif

BEGIN;

TRUNCATE trees;

DROP TABLE IF EXISTS stg_street, stg_park, stg_custom, stg_custom_norm;

CREATE UNLOGGED TABLE stg_street (
  tree_id text, dist text, region text, region_remark text, tree_type text,
  diameter text, tree_height text, survey_date text,
  twd97x text, twd97y text, upd_date text
);
COPY stg_street FROM :'street_csv' WITH (FORMAT csv, HEADER true);

CREATE UNLOGGED TABLE stg_park (
  tree_id text, dist text, park_name text, tree_type text,
  diameter text, tree_height text,
  twd97x text, twd97y text, survey_date text, upd_date text
);
COPY stg_park FROM :'park_csv' WITH (FORMAT csv, HEADER true);

-- Custom drop-ins: every *.csv in data/custom/, an optional directory holding
-- data that is not the city's open data. Columns are quoted so they match the
-- CSV header *exactly* — COPY ... HEADER MATCH compares against the stored
-- (case-sensitive) column name, so `tree_id` would reject a `TreeID` header.
-- That strictness is the point: a file with LON and LAT the other way round is
-- rejected instead of loading longitude into the latitude column.
CREATE UNLOGGED TABLE stg_custom (
  "TreeID" text, "TreeType" text, "Diameter" text, "TreeHeight" text,
  "LAT" text, "LON" text,
  src_file text   -- filled in after each COPY, so the reports can name the file
);

SET LOCAL trees.custom_dir TO :'custom_dir';

-- The file list is discovered here rather than passed in by load.sh: the
-- loader stays the single place that knows how drop-ins are found, and adding
-- a dataset is dropping a file in, not editing a script.
DO $$
DECLARE
  dir   text := current_setting('trees.custom_dir');
  f     text;
  n     bigint;
  files int := 0;
BEGIN
  -- missing_ok: no directory at all is the normal case, not an error.
  IF (pg_stat_file(dir, true)).isdir IS NOT TRUE THEN
    RAISE NOTICE 'custom: % is absent — loading the city extracts only', dir;
    RETURN;
  END IF;

  FOR f IN SELECT * FROM pg_ls_dir(dir) AS name ORDER BY 1 LOOP
    CONTINUE WHEN f !~* '\.csv$';
    BEGIN
      EXECUTE format(
        'COPY stg_custom ("TreeID","TreeType","Diameter","TreeHeight","LAT","LON")
           FROM %L WITH (FORMAT csv, HEADER MATCH)', dir || '/' || f);
    EXCEPTION WHEN OTHERS THEN
      -- COPY's own error names the staging table, not the file, which is
      -- useless when several files are loaded in one pass.
      RAISE EXCEPTION 'custom: % could not be loaded: %', f, SQLERRM
        USING HINT = 'The header must be exactly: TreeID,TreeType,Diameter,TreeHeight,LAT,LON';
    END;
    UPDATE stg_custom SET src_file = f WHERE src_file IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    files := files + 1;
    RAISE NOTICE 'custom: % — % rows', f, n;
  END LOOP;

  IF files = 0 THEN
    RAISE NOTICE 'custom: no *.csv in % — loading the city extracts only', dir;
  END IF;
END $$;

-- Custom columns are arbitrary text from an arbitrary supplier, so every number
-- is guarded by a regex before it is cast: CASE is short-circuit, a bare cast in
-- a WHERE clause is not, and one 'N/A' in a height column would otherwise abort
-- a load of 163,000 good rows. Unparseable becomes NULL, which the cleaning
-- rules below then treat exactly like an out-of-range value.
CREATE UNLOGGED TABLE stg_custom_norm AS
SELECT src_file,
       "TreeID"                AS tree_id,
       nullif("TreeType", '')  AS species,
       CASE WHEN "TreeHeight" ~ '^\s*-?\d+(\.\d+)?\s*$'
            THEN "TreeHeight"::real END AS height_m,
       CASE WHEN "Diameter"   ~ '^\s*-?\d+(\.\d+)?\s*$'
            THEN "Diameter"::real   END AS diameter_cm,
       CASE WHEN "LAT"        ~ '^\s*-?\d+(\.\d+)?\s*$'
            THEN "LAT"::double precision  END AS lat,
       CASE WHEN "LON"        ~ '^\s*-?\d+(\.\d+)?\s*$'
            THEN "LON"::double precision  END AS lon
FROM stg_custom;

-- `tree_id` is UNIQUE, so a drop-in that reuses an id would abort the insert
-- anyway — with Postgres's own message, naming neither the file nor the other
-- row. Fail first instead, and say where the collision is. Shadowing a surveyed
-- city tree with a custom row is worse than refusing to load.
DO $$
DECLARE report text;
BEGIN
  WITH extract_ids AS (
    SELECT tree_id FROM stg_street
    UNION ALL
    SELECT tree_id FROM stg_park
  ),
  repeated AS (
    SELECT tree_id,
           string_agg(DISTINCT src_file, ', ') AS files,
           count(*)                            AS copies
    FROM stg_custom_norm
    GROUP BY tree_id
  )
  SELECT string_agg(
           format('  %s — %s (%s)', r.tree_id, r.files,
                  CASE WHEN e.tree_id IS NOT NULL THEN 'already in the city extracts'
                       ELSE format('%s copies', r.copies) END),
           E'\n' ORDER BY r.tree_id)
    INTO report
  FROM repeated r
  LEFT JOIN extract_ids e ON e.tree_id = r.tree_id
  WHERE r.copies > 1 OR e.tree_id IS NOT NULL;

  IF report IS NOT NULL THEN
    RAISE EXCEPTION E'custom: duplicate TreeID:\n%', report
      USING HINT = 'TreeID must be unique across every file, the two extracts included.';
  END IF;
END $$;

-- The three sources normalise onto one shape, then the cleaning rules are
-- applied once to the union rather than three times in parallel:
--
--   geometry  the extracts are TWD97 / TM2 zone 121 (EPSG:3826) and are
--             transformed to WGS84; every row in both files parses, so there
--             are no malformed coordinates to guard. Custom rows are WGS84
--             already and are stored as given — `srid` below carries the
--             difference, and 4326 skips the transform rather than relying on
--             ST_Transform to notice it has nothing to do.
--   height_m  kept whenever it is positive; there is no upper bound. The
--             column does carry keying damage — the street file's maximum is
--             2023.0, a survey year typed into the height field, and the park
--             file's is 797.0 — and those 22 rows (of 162,930; p99 is 18.9 /
--             20.8) now load, and render, at that height. That is the accepted
--             cost of not having to decide, per row, which tall tree is a typo.
--   diameter  kept only in (0, 400] cm. The park file's maximum is 2637 cm and
--             9,266 of its rows record 0.
--
-- Out-of-range values become NULL rather than being clamped: a tree of unknown
-- diameter must not render as a 400 cm one. The same rules apply to custom rows
-- — they describe what the app can render, not who supplied the file.
--
-- Coordinates are the exception, because `geom` is NOT NULL: there is no "null
-- it and keep the row" option. A custom row whose LAT/LON is missing,
-- unparseable or off the globe is dropped, and counted in the report below.
WITH raw AS (
  SELECT tree_id,
         'street'                        AS kind,
         dist                            AS district,
         nullif(region, '')              AS place,
         nullif(region_remark, '')       AS place_note,
         nullif(tree_type, '')           AS species,
         nullif(tree_height, '')::real   AS height_m,
         nullif(diameter, '')::real      AS diameter_cm,
         nullif(survey_date, '')::date   AS survey_date,
         twd97x::double precision        AS x,
         twd97y::double precision        AS y,
         3826                            AS srid
  FROM stg_street
  UNION ALL
  SELECT tree_id,
         'park',
         dist,
         nullif(park_name, ''),
         NULL,
         nullif(tree_type, ''),
         nullif(tree_height, '')::real,
         nullif(diameter, '')::real,
         nullif(survey_date, '')::date,
         twd97x::double precision,
         twd97y::double precision,
         3826
  FROM stg_park
  UNION ALL
  -- district, place, place_note and survey_date have no column in the drop-in
  -- schema. NULL district is how a custom row is recognised downstream.
  SELECT tree_id,
         'custom',
         NULL,
         NULL,
         NULL,
         species,
         height_m,
         diameter_cm,
         NULL::date,
         lon,
         lat,
         4326
  FROM stg_custom_norm
  WHERE lat BETWEEN -90 AND 90
    AND lon BETWEEN -180 AND 180
)
INSERT INTO trees (
  id, tree_id, kind, district, place, place_note,
  species, height_m, diameter_cm, survey_date, geom
)
SELECT row_number() OVER (ORDER BY tree_id),
       tree_id, kind, district, place, place_note, species,
       CASE WHEN height_m    > 0                        THEN height_m    END,
       CASE WHEN diameter_cm > 0 AND diameter_cm <= 400 THEN diameter_cm END,
       survey_date,
       CASE WHEN srid = 4326 THEN ST_SetSRID(ST_MakePoint(x, y), 4326)
            ELSE ST_Transform(ST_SetSRID(ST_MakePoint(x, y), srid), 4326) END
FROM raw;

\echo ''
\echo '--- custom drop-ins: rows dropped for unusable coordinates ---'
SELECT src_file,
       count(*) FILTER (WHERE lat IS NULL OR lon IS NULL)        AS unparseable,
       count(*) FILTER (WHERE lat IS NOT NULL AND lon IS NOT NULL
                          AND (lat NOT BETWEEN -90 AND 90
                            OR lon NOT BETWEEN -180 AND 180))    AS off_globe
FROM stg_custom_norm
GROUP BY src_file
HAVING count(*) FILTER (WHERE lat IS NULL OR lon IS NULL
                          OR lat NOT BETWEEN -90 AND 90
                          OR lon NOT BETWEEN -180 AND 180) > 0
ORDER BY src_file;

DROP TABLE stg_street, stg_park, stg_custom, stg_custom_norm;

ANALYZE trees;

COMMIT;

\echo ''
\echo '--- loaded ---'
SELECT kind,
       count(*)           AS trees,
       count(height_m)    AS with_height,
       count(diameter_cm) AS with_diameter,
       count(species)     AS with_species
FROM trees GROUP BY kind ORDER BY kind;

SELECT count(*) AS total FROM trees;

-- Per kind, because the app declares the source's `bounds` as a constant
-- (TREES_BOUNDS in app/src/layers/tree/constants.ts) and MapLibre requests no
-- tile outside it. A drop-in landing off that box renders nothing, and this is
-- where you see it: the street/park extents must straddle 121.4-121.7 E,
-- 24.9-25.3 N, and a custom extent far from them is the explanation.
\echo ''
\echo '--- extent per kind (street/park must straddle 121.4-121.7 E, 24.9-25.3 N) ---'
SELECT kind,
       round(ST_XMin(e)::numeric, 4) AS min_lng,
       round(ST_YMin(e)::numeric, 4) AS min_lat,
       round(ST_XMax(e)::numeric, 4) AS max_lng,
       round(ST_YMax(e)::numeric, 4) AS max_lat
FROM (SELECT kind, ST_Extent(geom) AS e FROM trees GROUP BY kind) s
ORDER BY kind;
