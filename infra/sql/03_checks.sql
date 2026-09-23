-- Assertions over the loaded table. Run by load.sh as the last step, and by
-- infra/test/run.sh against fixture data.
--
-- Neither package has a unit-test runner, so this is where a load is tested:
-- the checks below are the ones the schema's own constraints cannot make —
-- relationships between columns, and between rows and the file they came from.
-- A constraint already covers `kind`'s domain, the height and diameter ranges,
-- and `tree_id` uniqueness, so none of those are repeated here.
--
-- Every check runs before anything is raised: a load with three problems should
-- report three, not the first one and then a second run to find the next.
DO $$
DECLARE
  problems text[] := '{}';
  n        bigint;
BEGIN
  -- The surrogate id is row_number() over the whole insert, so it must be a
  -- gapless 1..count(*). A gap means rows were inserted outside that window —
  -- the way a second INSERT for a new source would, restarting at 1 and
  -- colliding on the primary key or, worse, not colliding and renumbering the
  -- feature ids MapLibre keeps feature-state against.
  SELECT count(*) INTO n FROM trees;
  IF n = 0 THEN
    problems := problems || 'trees is empty';
  ELSIF (SELECT max(id) FROM trees) <> n THEN
    problems := problems || format('id is not a gapless 1..%s (max is %s)',
                                   n, (SELECT max(id) FROM trees));
  END IF;

  -- Each extract must actually have arrived. A CSV truncated to its header
  -- loads without error and leaves the map convincingly half-empty.
  IF NOT EXISTS (SELECT 1 FROM trees WHERE kind = 'street') THEN
    problems := problems || 'no street trees loaded';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trees WHERE kind = 'park') THEN
    problems := problems || 'no park trees loaded';
  END IF;

  -- district is the discriminator the app's spec promises: NULL means custom.
  -- Both halves of that promise are checked, because either one breaking makes
  -- a custom row indistinguishable from a city one.
  SELECT count(*) INTO n FROM trees WHERE kind IN ('street', 'park') AND district IS NULL;
  IF n > 0 THEN
    problems := problems || format('%s city trees have no district', n);
  END IF;
  SELECT count(*) INTO n FROM trees
   WHERE kind = 'custom'
     AND (district IS NOT NULL OR place IS NOT NULL
          OR place_note IS NOT NULL OR survey_date IS NOT NULL);
  IF n > 0 THEN
    problems := problems ||
      format('%s custom trees carry a district/place/survey_date the drop-in schema has no column for', n);
  END IF;

  -- place_note comes from RegionRemark, which only the street file has.
  SELECT count(*) INTO n FROM trees WHERE kind <> 'street' AND place_note IS NOT NULL;
  IF n > 0 THEN
    problems := problems || format('%s non-street trees carry a place_note', n);
  END IF;

  SELECT count(*) INTO n FROM trees WHERE coalesce(tree_id, '') = '';
  IF n > 0 THEN
    problems := problems || format('%s trees have an empty tree_id', n);
  END IF;

  -- Coordinates: the transform is the one step that can silently produce
  -- plausible-looking nonsense (a wrong source SRID puts all of Taipei in the
  -- Gulf of Guinea without erroring). Checked globally, not against Taipei's
  -- box: custom data is allowed to be somewhere else.
  SELECT count(*) INTO n FROM trees
   WHERE ST_X(geom) NOT BETWEEN -180 AND 180
      OR ST_Y(geom) NOT BETWEEN -90 AND 90
      OR ST_IsEmpty(geom);
  IF n > 0 THEN
    problems := problems || format('%s trees are not at a valid WGS84 point', n);
  END IF;

  SELECT count(*) INTO n FROM trees WHERE ST_SRID(geom) <> 4326;
  IF n > 0 THEN
    problems := problems || format('%s trees are not in SRID 4326', n);
  END IF;

  IF array_length(problems, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'load checks failed:\n  %', array_to_string(problems, E'\n  ');
  END IF;
END $$;

\echo 'checks passed'
