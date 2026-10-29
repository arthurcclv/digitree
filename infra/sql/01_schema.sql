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

-- Gaussian splat captures (3DGS): one row per capture file in data/3dgs/source/,
-- placed on the map by its PLY header's georeference (data/3dgs/georef.csv,
-- the default) or by the control points in data/3dgs/control_points.csv.
-- Loaded by 04_splats.sql, which computes each placement; nothing here is
-- typed in by hand. The app's spec for these columns is
-- app/src/layers/splat/specs/spec.md, *Placement* and the two sections after it.
DROP TABLE IF EXISTS splats;

CREATE TABLE splats (
  -- The MVT feature id, which must be an integer (see trees.id); splat_id is
  -- the real key.
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  splat_id    text NOT NULL UNIQUE,
  -- A bare file name inside data/3dgs/source/, which the files service serves at
  -- /3dgs/<file>. One capture per file.
  file        text NOT NULL UNIQUE CHECK (file !~ '/'),
  -- From pg_stat_file at load, so the app can show how much a capture costs
  -- before fetching it.
  bytes       bigint NOT NULL CHECK (bytes > 0),
  -- Vertical offset of local z = 0 above the map's ground plane, in metres:
  -- placed by the header, OFFSETZ less its datum group's median OFFSETZ
  -- (04_splats_header.sql); fitted, mean(H − scale·Z) over its points.
  altitude_m  real NOT NULL,
  -- The capture's local +y axis, degrees clockwise from north.
  heading_deg real NOT NULL CHECK (heading_deg >= 0 AND heading_deg < 360),
  -- Local units -> metres. The fit rejects anything outside [0.8, 1.25].
  scale       real NOT NULL CHECK (scale > 0),
  -- The fit's horizontal RMS residual over the control points, in metres,
  -- and how many it used. NULL for a capture placed by its header: nothing
  -- is fitted.
  rms_m       real CHECK (rms_m >= 0),
  points      integer CHECK (points >= 3),
  -- Where local (0, 0) lands.
  geom        geometry(Point, 4326) NOT NULL,
  -- geom's longitude and latitude, exactly, for the app to read as the
  -- capture's origin. Martin publishes them as MVT doubles; the point itself
  -- is snapped to the tile's grid (~0.54 m at z14), so it only says which
  -- tiles hold the capture. Generated, so they can never disagree with geom.
  lng         double precision GENERATED ALWAYS AS (ST_X(geom)) STORED,
  lat         double precision GENERATED ALWAYS AS (ST_Y(geom)) STORED
);

CREATE INDEX splats_geom_idx ON splats USING GIST (geom);
