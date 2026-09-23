-- Schema for the Taipei tree inventory.
--
-- Dropped and recreated rather than patched: the CSVs in data/ are the only
-- source of truth for this table, 02_load.sql reloads all of it every time, and
-- recreating guarantees the live schema matches this file instead of drifting
-- from it one forgotten ALTER at a time.
CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS trees;

CREATE TABLE trees (
  -- MVT feature ids must be integers, and `tree_id` is text ('BT0614021096'),
  -- so the tile id is a surrogate. Assigned by row_number() over tree_id in
  -- 02_load.sql, which makes it deterministic: the same CSVs always produce the
  -- same ids, so MapLibre feature-state survives a reload.
  id          bigint PRIMARY KEY,
  -- The real key. Unique across *both* source files — verified, zero overlap —
  -- which is why one table with a `kind` discriminator beats two tables.
  tree_id     text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('street', 'park')),
  district    text NOT NULL,              -- Dist
  place       text,                       -- Region (road name) or ParkName
  place_note  text,                       -- RegionRemark; street rows only
  -- Nullable: 18 rows across the two files carry no species at all.
  species     text,                       -- TreeType
  -- NULL means "not credibly recorded", not "zero". See 02_load.sql.
  height_m    real CHECK (height_m > 0 AND height_m <= 40),
  diameter_cm real CHECK (diameter_cm > 0 AND diameter_cm <= 400),
  survey_date date,
  geom        geometry(Point, 4326) NOT NULL
);

-- Mandatory: without it Martin sequentially scans 163k rows for every tile.
CREATE INDEX trees_geom_idx ON trees USING GIST (geom);
CREATE INDEX trees_kind_idx ON trees (kind);
