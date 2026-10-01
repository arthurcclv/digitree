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
  -- which is why one table with a `kind` discriminator beats two tables. A
  -- custom drop-in that reuses an existing TreeID aborts the load with a named
  -- error rather than shadowing a row; see 02_load.sql.
  tree_id     text NOT NULL UNIQUE,
  -- 'custom' rows come from the optional drop-in CSVs in data/custom/. They are
  -- the same kind of object — a surveyed tree — from a source that is not the
  -- city's open data, which is why they share this table rather than getting
  -- their own.
  kind        text NOT NULL CHECK (kind IN ('street', 'park', 'custom')),
  -- Nullable because the drop-in schema has no Dist column. Street and park
  -- rows always carry one; a NULL district means "custom row", not "unknown
  -- district of a city tree".
  district    text,                       -- Dist
  place       text,                       -- Region (road name) or ParkName
  place_note  text,                       -- RegionRemark; street rows only
  -- Nullable: 18 rows across the two files carry no species at all.
  species     text,                       -- TreeType
  -- NULL means "not credibly recorded", not "zero". Only a non-positive height
  -- is rejected — there is deliberately no ceiling. See 02_load.sql.
  height_m    real CHECK (height_m > 0),
  -- Same shape as height, and for the same reason. The floor is the load-bearing
  -- half here: 9,319 rows record a diameter of exactly 0, which is a blank field
  -- and not a measurement.
  diameter_cm real CHECK (diameter_cm > 0),
  -- The crown's diameter seen from above. The city does not survey it, so it
  -- is NULL on every street and park row; only a custom drop-in with the
  -- optional CanopyWidth column carries one. Same NULL-not-zero rule as above.
  canopy_width_m real CHECK (canopy_width_m > 0),
  survey_date date,
  geom        geometry(Point, 4326) NOT NULL
);

-- Mandatory: without it Martin sequentially scans 163k rows for every tile.
CREATE INDEX trees_geom_idx ON trees USING GIST (geom);
CREATE INDEX trees_kind_idx ON trees (kind);
