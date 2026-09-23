-- Load both extracts into `trees`. Idempotent: truncates and reloads.
--
-- The two files do not share a column order, so each gets its own staging
-- table. Everything lands as text first: the raw data carries values that are
-- not valid in their nominal type (see the cleaning rules below), and a failed
-- COPY tells you far less than a failed transform.
BEGIN;

DROP TABLE IF EXISTS stg_street, stg_park;

CREATE UNLOGGED TABLE stg_street (
  tree_id text, dist text, region text, region_remark text, tree_type text,
  diameter text, tree_height text, survey_date text,
  twd97x text, twd97y text, upd_date text
);
COPY stg_street FROM '/data/TaipeiTree.csv' WITH (FORMAT csv, HEADER true);

CREATE UNLOGGED TABLE stg_park (
  tree_id text, dist text, park_name text, tree_type text,
  diameter text, tree_height text,
  twd97x text, twd97y text, survey_date text, upd_date text
);
COPY stg_park FROM '/data/TaipeiParkTree.csv' WITH (FORMAT csv, HEADER true);

-- The two files normalise onto one shape, then the cleaning rules are applied
-- once to the union rather than twice in parallel:
--
--   geometry  TWD97 / TM2 zone 121 (EPSG:3826) -> WGS84. Every row in both
--             files parses; there are no malformed coordinates to guard.
--   height_m  kept only in (0, 40]. The street file's maximum is 2023.0 — a
--             survey year keyed into the height column — and the park file's
--             is 797.0. p99 is 18.9 / 20.8, so 40 m discards the nonsense
--             without touching a real tree.
--   diameter  kept only in (0, 400] cm. The park file's maximum is 2637 cm and
--             9,266 of its rows record 0.
--
-- Out-of-range values become NULL rather than being clamped: a tree of unknown
-- height must not render as a 40 m one.
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
         twd97y::double precision        AS y
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
         twd97y::double precision
  FROM stg_park
)
INSERT INTO trees (
  id, tree_id, kind, district, place, place_note,
  species, height_m, diameter_cm, survey_date, geom
)
SELECT row_number() OVER (ORDER BY tree_id),
       tree_id, kind, district, place, place_note, species,
       CASE WHEN height_m    > 0 AND height_m    <=  40 THEN height_m    END,
       CASE WHEN diameter_cm > 0 AND diameter_cm <= 400 THEN diameter_cm END,
       survey_date,
       ST_Transform(ST_SetSRID(ST_MakePoint(x, y), 3826), 4326)
FROM raw;

DROP TABLE stg_street, stg_park;

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

\echo '--- extent (must straddle 121.4-121.7 E, 24.9-25.3 N) ---'
SELECT round(ST_XMin(e)::numeric, 4) AS min_lng,
       round(ST_YMin(e)::numeric, 4) AS min_lat,
       round(ST_XMax(e)::numeric, 4) AS max_lng,
       round(ST_YMax(e)::numeric, 4) AS max_lat
FROM (SELECT ST_Extent(geom) AS e FROM trees) s;
