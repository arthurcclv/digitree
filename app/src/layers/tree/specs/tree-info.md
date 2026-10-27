# Tree info on click — feature spec

Status: **approved 2026-10-27.** The contract parts below are folded into
`specs/spec.md` (this layer: *Data source*, *Picking and marks*),
`src/lib/mount/specs/spec.md` (the factory table and invariant 8) and
`infra/CLAUDE.md` (the published properties). This file stays the feature's
full record. Revision 2 (after the browser check, see *Highlight*): the mesh
mark carries a gain, and the card sits beside the tree's base.

## Purpose

Clicking a tree on the map opens a small card anchored to that tree, showing
what the inventory knows about it: the row of the source CSV as the app
receives it. One tree at a time. Clicking elsewhere, or the card's close
button, closes it.

Two trees are marked on the map while this happens (see *Highlight*):

- the **hovered** tree, the one a click would pick right now, under the
  pointer;
- the **selected** tree, the one whose card is open.

## Definition

**A tree is clicked** when the click lands on what the tree layer is drawing
for it at that moment:

| what is drawn | a click picks the tree when |
| --- | --- |
| meshes (`meshVisible`, zoom ≥ `TREE_MESH_MIN_ZOOM`) | the ray through the click hits one of its mesh instances, bark or canopy, either mesh source |
| circles only (`pointsVisible`, below the mesh zoom or meshes off) | the click is within **6 px** of its circle's rendered edge |
| nothing (both halves off, or its `kind` filtered out) | never |

- Meshes take precedence: at mesh zoom with meshes on, only a mesh hit picks,
  even if a circle is also drawn under the tree. A tall canopy under pitch sits
  far from its base point on screen; the circle test would pick the wrong tree.
- Several hits: the **nearest to the camera** (meshes) or the **nearest centre
  to the click** (circles) wins. Ties break on `tree_id`, so the choice is
  deterministic.
- The `kind` filter needs no extra rule: the meshes only hold instances of the
  selected kind, and the circle record already filters on it.
- A tree hidden behind a building **can** be picked through it. The mesh ray
  does not read MapLibre's depth buffer. Accepted for now; see *Out of scope*.

## Inputs — what the card can show

The card shows the tree's MVT properties. Today the tiles carry only part of
the CSV, so this feature **publishes two more columns the table already
holds**:

| property | CSV column | today | change |
| --- | --- | --- | --- |
| `tree_id` | `TreeID` | published | — |
| `kind` | (which file) | published | — |
| `district` | `Dist` | published | — |
| `place` | `Region` / `ParkName` | published | — |
| `place_note` | `RegionRemark` (street only) | in the table, not published | **published, `text`** |
| `species` | `TreeType` | published | — |
| `height_m` | `TreeHeight` | published | — |
| `diameter_cm` | `Diameter` | published | — |
| `canopy_width_m` | `CanopyWidth` (custom only) | published | — |
| `survey_date` | `SurveyDate` | in the table, not published | **published, as an ISO `YYYY-MM-DD` string** |
| — | `UpdDate`, `TWD97X`, `TWD97Y` | dropped at load | **not shown** (see *Out of scope*) |

The infra change is `martin.yaml` only: two more entries under `trees.properties`.
No schema, loader or check changes. Both new properties are nullable, on the
same terms the table already states (`place_note` is `NULL` off street rows,
`survey_date` on custom rows).

Values are shown as cleaned by the loader, not as raw CSV text: a height of
`0` in the CSV is `NULL` in the table, and the card says "not recorded", which
is what the load decided it means.

### One reading

`treeOf` in `schema.ts` stays the one reading of a tree (portability rule 5).
`TreeFeature` gains the display fields, each `string | null` or
`number | null`, read with the same "positive number, else `null`" rule for
`diameter_cm` as for height:

```ts
district: string | null;
place: string | null;
placeNote: string | null;
diameterCm: number | null;
surveyDate: string | null;
```

`TREE_PROPS` gains their property names. No consumer outside the card reads
them.

`survey_date` is a `date` column; Martin's `ST_AsMVT` writes it as its text
form, `YYYY-MM-DD` (checked on a live tile). Cost, measured 2026-10-27 on a
block of central tiles, uncompressed: +9.0% at z14, +8.3% at z16 (the numbers
are in `martin.yaml`).

## Output contract

### The mount: `pick` and `select`

`TreeMount` gains two members:

```ts
/** The tree drawn under a screen point (CSS px, map container), or null. */
pick(point: { x: number; y: number }): TreeFeature | null;
/** Mark one tree as selected, by `tree_id`, or clear the mark. */
select(treeId: string | null): void;
```

- Synchronous: the mesh test is a three.js raycast over the instances the
  layer already holds, the circle test is `map.queryRenderedFeatures` on the
  points record's circle style layer.
- The mesh ray is the click unprojected through the inverse of the layer's
  last projection (`mainMatrix × modelMatrix`), so it is in the instances'
  local metre frame and needs no Mercator maths of its own.
- To map a hit's `instanceId` back to a tree, the layer keeps, per form
  bucket, the `TreeFeature` written at each instance index, rebuilt with the
  instance matrices on every refresh.
- `pick` only reads. It changes no setting, draws nothing and triggers no
  repaint. Marking is `select`'s job, and the hover's (below).
- `select` is called by the host when a card opens (the picked tree's id) and
  when it closes (`null`). It is the only way the selection changes; the
  layer never selects on its own.

These are new mount members, so the factory table in
`src/lib/mount/specs/spec.md` and its invariant 8 change with them (tree:
`exportUsd`, `pick`, `select`).

### Highlight

**Hover is the mount's own.** The mount registers a `mousemove` listener on
the map (and removes it in `dispose`), runs the same test as `pick` at the
pointer, and marks the result as hovered. The host is not involved: hover is
layer behaviour, and rule 1 keeps that out of the host. Specifically:

- at most one test per animation frame; a burst of moves runs the last one;
- no test while the map is being dragged, rotated or pitched (the hover is
  cleared when the gesture starts), nor while the pointer is off the map
  (`mouseout` clears it);
- over a tree the map's cursor is `pointer`; elsewhere it is restored to
  what it was;
- touch input has no hover. A tap is a click, and only selects.

**How a tree is marked**, in each half:

| | hovered | selected |
| --- | --- | --- |
| meshes, every part of the instance | multiplied by `#b9d4ec` × 3 | multiplied by `#7fb8e6` × 3 |
| circles | colour `#b9d4ec` | colour `#7fb8e6` |

- Selected wins over hovered on the same tree.
- Meshes: a per-instance colour (`instanceColor`, white for every other
  instance), shared by every part of a form like the instance matrix is. It
  multiplies the material colour, under both mesh sources. The **gain**
  (`MARK_GAIN`, 3 for both) is load-bearing: both colours are below white in
  every channel, so multiplied as they are they only darken a dark-green
  crown, and in the browser the marked tree was indistinguishable from its
  neighbours. With the gain the hovered crown turns a light seafoam and the
  selected one teal. Revision 1 of this spec had no gain. A refresh
  re-applies the marks to wherever the marked trees landed; a mark change
  rewrites only the instances concerned and asks for one repaint.
- Circles: MapLibre feature-state (`hover`, `selected`) on the points
  source, keyed by the MVT feature `id`. The points record's colour
  expression gains a `case` on those two states ahead of the `kind` match.
  GeoLibre passes that expression to `circle-color` verbatim, so the record
  stays a plain description. The layer therefore keeps each tree's feature
  `id` alongside its `TreeFeature`.
- The marks follow the tree, not the screen. A marked tree that leaves the
  loaded tiles is unmarked on screen and marked again when it returns.
- `#7fb8e6` is the existing accent text colour. `#b9d4ec` is new, a lighter
  step of it, and is added to `ai/VISUAL_DESIGN.md` with this feature.

### The host

`useMapEngine`'s click handler calls `mounts.tree.pick(e.point)` on every
click, alongside the overlay probes, then `mounts.tree.select(tree?.id ?? null)`,
and hands the result to a new `onTreePick(tree: TreeFeature | null)` callback.
Every path that closes the card also calls `select(null)`.

`select` marks the circles by MVT feature id, which only a pick knows. The
mount keeps its last pick for that; a `select` of any other id marks the
meshes only. The two are independent: one
click can both probe direct sun and open a tree card.

The host owns the card's anchor: one MapLibre `Popup`, created on the first
pick, placed at the tree's `lng`/`lat` (its base, not its canopy), removed on
`null`. The card sits **to the right of** the base (`anchor: "left"`), not
above it: above the base is where the tree's own crown is drawn, and in the
browser a card above it hid the tree it described. `App.tsx` renders the card's content into the popup's element through
a React portal. Nothing tree-specific enters the host beyond calling a mount
member and forwarding its result, which is what rule 1 allows.

### The card

Title: the species (or "Unknown species"), with the `kind` as a pill badge
(street / park / custom, in the circles' colours). Then `.stat-line` rows:

| label | value |
| --- | --- |
| Tree ID | `tree_id` |
| District | `district` |
| Location | `place`, then ` · place_note` when present |
| Height | `height_m` m; when `NULL`: "not recorded · drawn at {fallbackHeightM} m" |
| Trunk diameter | `diameter_cm` cm |
| Canopy width | `canopy_width_m` m |
| Surveyed | `survey_date` |
| Coordinates | `lat, lng`, 6 decimals |

- A `NULL` value shows "—". A row whose column the tree's source **has no
  column for** is omitted rather than dashed: District, Location and Surveyed
  on custom rows; Canopy width on street and park rows.
- Numbers keep one decimal; the inventory records no finer.
- The coordinates are the tile's, quantised to its grid (≈ 0.15 m at z16,
  ≈ 0.6 m at z14), not the survey's TWD97 values.
- The badge shows the kind in its circles' colour (`TREE_KIND_COLORS`). The card says nothing more
  precise than it has.
- The row formatting is a pure function, `treeInfoRows(tree, fallbackHeightM)`,
  in the tree folder and exported from its `index.ts`, so it is tested without
  React.
- Styling follows `ai/VISUAL_DESIGN.md`: the `.panel` card surface, radius,
  and `.stat-line`; the popup's own tip and chrome are restyled to match. The
  new component is added to that doc.

### When the card closes

- the close button;
- a click that picks no tree (including a click on empty map);
- a tree setting that makes the picked tree unpickable: both halves off, or
  the `kind` filter excluding its kind;
- a basemap swap (`style.load`).

Panning, zooming, a height-scale change and a mesh-source switch keep it open
and anchored. The card is not re-validated against the tiles: if the tree
scrolls out of the loaded tiles, the card still shows what was picked.

## Invariants

Each covered by vitest unless marked.

1. `treeOf` returns the five new fields from a feature's properties, `null`
   for each missing or wrongly typed one, and `null` for a non-positive
   `diameter_cm`. Existing `treeOf` behaviour is unchanged.
2. `treeInfoRows` omits the source-less rows per kind, dashes the `NULL` ones,
   joins `place` and `place_note`, and states the fallback height on a `NULL`
   height.
3. The tree mount exposes exactly `update`, `prepareSync`, `dispose`,
   `exportUsd`, `pick`, `select`.
3a. The points record's colour expression yields `#7fb8e6` for a feature
   with `selected` state, `#b9d4ec` for one with only `hover`, and the `kind`
   colour otherwise. This is evaluated with MapLibre's own expression
   evaluator.
3b. On placed fake instances, `setMarks` makes the selected tree's instance
   colour `#7fb8e6` × gain and the hovered one's `#b9d4ec` × gain, and leaves
   every other instance white. Clearing restores white. A hovered and selected
   tree carries the selected mark. A refresh that moves the tree to another
   instance index keeps it marked, and a tree marked out of view is marked
   when placed. Both marks exceed 1 in some channel, so they brighten.
3c. The mount registers its `mousemove`/`mouseout` listeners on mount and
   removes them on `dispose` (fake map's `on`/`off`).
4. `pick` on circles: with the fake map's `queryRenderedFeatures` returning
   several features, the nearest centre wins, ties on `tree_id`; with
   `pointsVisible: false` and no meshes, it returns `null` without querying.
5. `pick` on meshes: on instances placed from fake features (no GL context —
   raycasting is CPU-side), a ray through a known instance returns that tree,
   the nearer of two overlapping instances wins, and a ray through nothing
   returns `null`.
6. The host imports nothing new at runtime from the tree folder (the existing
   structure test).
7. *(Browser)* clicking a mesh at pitch opens the card for that tree; clicking
   empty ground closes it; toggling the kind filter away closes it.
8. *(Browser)* moving over trees tints the one under the pointer and shows
   the pointer cursor, at both mesh and circle zooms. The selected tree stays
   tinted while the card is open, and loses the tint when the card closes.
   Panning with no hover runs no pick (checked in the performance panel).

## Docs touched

- `specs/spec.md` (this layer): *Data source* schema table, a *Picking*
  section, the mount member.
- `src/lib/mount/specs/spec.md`: factory table, invariant 8, *The host*
  (click handler).
- `infra/martin.yaml`, `infra/CLAUDE.md`: the two published properties.
- `app/ai/VISUAL_DESIGN.md`: the tree card.
- `app/ai/DECISIONS.md`: picking by mesh ray, not by base point; publishing
  `place_note` and `survey_date`.

## Open decisions

1. **Picking through buildings.** Accept it (this draft), or test the hit's
   depth against MapLibre's depth buffer, which needs a GL readback per click.
   With hover, the readback would run on every mouse move.

## Out of scope

- `UpdDate` and the TWD97 coordinates: dropped at load today; showing them
  means a schema and loader change in `infra/`, and a separate spec.
- Hover tooltips (hover marks the tree, it does not show its info);
  picking more than one tree; editing a tree.
- An outline or ground ring as the mark; a tint is what this draft draws.
- Picking splats, buildings or the overlays' cells.
- The sunlight layer's own copy of the trees: it does not pick.
