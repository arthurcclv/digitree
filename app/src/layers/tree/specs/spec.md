# Tree layer — spec

Source of truth for the tree layer. Behaviour changes here require this file to
change first.

Modules:
- `src/layers/tree/index.ts` — the two GeoLibre records (owns the description)
- `src/layers/tree/treeLayer.ts` — the MapLibre custom layer (owns the pixels)
- `src/layers/tree/models.ts` — the form → glTF table, the loader, and the
  normalisation that makes a downloaded model instanceable
- `src/layers/tree/placement.ts` — per-tree variation derived from `tree_id`
  (owns the fact that no tree is identical to its neighbour)

## Purpose

Renders Taipei's tree inventory — 162,930 surveyed street and park trees, served
from the local PostGIS + Martin stack in `infra/`, plus any custom trees dropped
into that stack — at two levels of detail:

- **points**, as MapLibre circles, from z14 across the whole city;
- **mesh**, as instanced three.js geometry, from z16 within the viewport, in
  one of **eight shapes** chosen from the tree's species (see *Form classes*).
  Each shape is drawn from one of **two sources** — built in code, or loaded
  from a glTF model — and the panel switches between them (see *Two mesh
  sources*).

The three.js half is registered **with** GeoLibre rather than bolted on beside
it: GeoLibre owns stacking order, visibility and opacity; three.js owns
rendering.

This layer replaces the single procedural tree at a fixed coordinate. That tree
existed to prove the external-native contract; the contract is unchanged, but it
now carries real data.

## Data source

One Martin source feeds both records.

| | |
| --- | --- |
| tile URL | `/tiles/trees/{z}/{x}/{y}` (relative — see below) |
| MVT layer (`sourceLayer`) | `trees` |
| zoom range | 14 – 20 |
| bounds | `[121.4619, 24.9771, 121.6268, 25.1606]` |
| feature id | integer `id` (MVT requires integers; `tree_id` is text) |
| properties | `tree_id`, `kind`, `district`, `place`, `species`, `height_m`, `diameter_cm` |
| open-data rows | 162,930, published as `TREES_TOTAL` (see *Panel readouts*) |

`kind` is `"street"`, `"park"` or `"custom"`. The first two are the city's open
data; `"custom"` is whatever a contributor dropped into `infra/data/custom/`,
and the layer treats it as a third peer — same source, same tiles, same
properties, no separate code path. `height_m` and `diameter_cm` are
**nullable**: `NULL` means the survey value was missing or implausible, not
zero. `species` is nullable too — 18 rows carry none. It is the key into
the form table below, so a `NULL` species means a `generic` shape, not a missing
tree. `district` and `place` are
**always `NULL` on `"custom"` rows**; the layer must not assume otherwise.

The bounds above are the *open data's* extent, and MapLibre requests no tile
outside them. Custom trees beyond that box therefore render nothing until this
constant is widened — `infra`'s load prints the loaded extent per kind so the
mismatch is visible rather than mysterious.

`infra/CLAUDE.md` holds the other side of this contract. The source id, the MVT
layer name and every property name above are a published interface: renaming one
makes this layer render nothing, silently.

### Why `source.tiles`, not `source.url`

GeoLibre accepts either a TileJSON `url` or an explicit `tiles` array
(`syncVectorTileLayer`). This layer MUST use `tiles`, with `minzoom`, `maxzoom`
and `bounds` stated alongside it.

Martin's TileJSON advertises an **absolute** tile URL
(`http://localhost:3000/trees/{z}/{x}/{y}`). Consuming it would send every tile
request straight past Vite's dev proxy to Martin's origin, reintroducing the
CORS problem the proxy exists to avoid. A relative `tiles` entry keeps every
request same-origin, and costs only the three fields the TileJSON would have
supplied.

The proxy is `/tiles` → `http://localhost:3000` in `vite.config.ts`, and is the
app's only knowledge that `infra/` exists.

### When the server is down

The layer renders nothing and the map keeps working. There is deliberately **no
fallback tree**: geometry that looks like data, but is not, is worse than an
empty map.

## The two records

`sync()` receives them in this order, both after the buildings:

```ts
sync.sync([buildingsLayer(...), treePointsLayer(...), treeMeshRecord(...)]);
```

Later entries stack higher, so the meshes sit above the circles and both above
the extrusions.

### `tree-points` — `treePointsLayer(settings)`

An ordinary `vector-tiles` record; GeoLibre materialises the circle style layer
and its paint. `style.extrusionEnabled` is `false`, so GeoLibre derives the
circle/line/fill triple and the circle is the one that matters.

- `style.minZoom` is **14**, matching the source floor. Below it a single tile
  carries most of the city: measured, z12 is 2.2 MB against z16's 21 KB.
- Radius interpolates on `height_m`, colour on `kind`, both as MapLibre
  expressions built the way `colorExpression` in `layers/buildings/index.ts`
  builds its ramp. Three colours — street, park, custom — plus the fallback for
  an unrecognised value. Custom trees are deliberately **not** styled to blend
  in with the surveyed ones: the segment exists so you can see which trees are
  yours.
- Trees with a `NULL` `height_m` still draw. GeoLibre's radius comes from
  `proportionalSize*`, whose `interpolate` falls a missing value back to the
  range minimum, so they draw as the **smallest** dot — visibly least-known
  rather than invisibly average. (The mesh half cannot do this: a zero-height
  tree would be no tree at all, so it uses the median fallback instead. The two
  halves treat a missing height differently *on purpose*.)

**This record must stay visible whenever either half is wanted.** The mesh layer
has no source of its own — it reads the tiles MapLibre parsed for this one — and
MapLibre stops keeping those the moment a layer is `visibility: none`. Hiding the
circles the obvious way therefore starves the meshes: `querySourceFeatures`
returns 0 and the 3D trees disappear with them, with no error anywhere.

So `visible` is `pointsVisible || meshVisible`, and "points off" is expressed as
**zero circle opacity** instead. This is the price of the one-source design and
the only place the two records are not independent.

The sunlight layer does **not** read these tiles: it fetches its own copy of
the same Martin source (see its spec, *Data*), using `TREES_TILES` and
`TREES_BOUNDS`, which `index.ts` exports for that purpose.

### `tree-mesh` — `treeMeshRecord(settings)`

Unchanged in shape from the record this layer had before: `metadata` opts into
GeoLibre's external-native path.

```ts
metadata: {
  customLayerType: "threejs",        // flag syncExternalNativeLayer branches on
  nativeLayerIds: [TREE_NATIVE_LAYER_ID],
  paintMode: "plugin",               // GeoLibre must not apply paint properties
}
```

On this path GeoLibre only **moves and shows** the named native layer. It does
not create it and does not paint it. That is what lets the meshes travel in the
same `sync([...])` call as the OSM buildings.

`type: "3d-tiles"` is inert — the external-native branch never reads `type`. It
is the closest `LayerType` for an externally rendered 3D mesh. `source` stays
`{}`: the mesh layer does not fetch anything (see below).

Opacity and visibility reach three.js through GeoLibre's paint bridge, registered
once per map with `setExternalNativePaintBridge(TREE_LAYER_ID, { setOpacity,
setVisibility })` and cleared on teardown. Those two controls MUST go through the
bridge, never straight to the class.

`setHeightScale` is deliberately **not** on the bridge: it is not a GeoLibre
concept, so the app drives it directly.

## How the mesh layer gets its data

**It does not fetch.** It reads the tiles MapLibre has already parsed for
`tree-points`:

```ts
map.querySourceFeatures(sourceId(TREE_POINTS_LAYER_ID), { sourceLayer: "trees" })
```

`sourceId` is imported from `@geolibre/map/style-layer-ids` — never hardcoded as
`"source-tree-points"`, which is an implementation detail of GeoLibre's naming.

This is the central design decision of the layer. One endpoint serves both
renderers, so the 2D and 3D views cannot disagree; the app makes no `fetch()`
call, gains no async state, and adds no CORS surface beyond the tile URL.

Four properties of `querySourceFeatures` follow from it, and all four are
load-bearing:

1. **It returns only features from currently loaded tiles.** The refresh
   therefore runs on `idle` — after tiles settle — not on `moveend`.
2. **A point near a tile edge appears in more than one tile**, via the tile
   buffer. Instances MUST be deduped by the `tree_id` property. This is why
   `tree_id` is published as a property and not merely used as a key in the
   database.
3. **It is synchronous.** The refresh is throttled and bounded (below).
4. **Geometry comes back as WGS84 GeoJSON**, already unprojected — so the layer
   works in lng/lat and never touches tile coordinates.

### Bounds on the work

| constant | value | why |
| --- | --- | --- |
| `TREE_MESH_MIN_ZOOM` | 16 | below it the meshes are sub-pixel and the instance count explodes |
| `MAX_INSTANCES` | 20,000 | measured: z16 peaks at 2,623 features per tile, so a viewport fits well inside this |

When more features are in view than `MAX_INSTANCES`, the **tallest** are kept.
Dropping the small ones is the least visible failure, and it is deterministic —
never "the first 20,000 the query happened to return".

The cull is **global, and runs before the survivors are bucketed by form**. This
ordering is load-bearing: culling within a form would make the shape of a tree
decide whether it survives, and a palm-lined street would evict the banyans
behind it.

## Rendering

`renderingMode: "3d"` shares MapLibre's depth buffer, so the OSM extrusions
occlude the meshes instead of them always drawing on top. Losing depth-buffer
sharing is a regression.

### The projection matrix

MapLibre v6 calls `render(gl, options)` — **not** the bare
`render(gl, matrix)` that v2/v3-era three.js recipes destructure.

The field to use is **`options.defaultProjectionData.mainMatrix`**. It is the
matrix taking unit Mercator coordinates (what `MercatorCoordinate` produces) to
clip space. `modelViewProjectionMatrix` is a different world space and puts the
mesh far outside the frustum **with no error of any kind** — a silent blank map.
The MapLibre d.ts says so directly: *"If you just need a projection matrix, use
`defaultProjectionData.mainMatrix`."*

### The model matrix and the instance frame

Mercator is X-east / Y-south / Z-up in fractions of the world; three.js is Y-up
and the mesh is modelled in metres. The model matrix composes, in order:
translate to the anchor → scale metres into Mercator units with **Y negated** for
the flipped axis → rotate three's Y-up frame onto Mercator's Z-up frame.

The anchor is no longer a module constant. It is **the viewport centre at the
moment of each refresh**, and instance positions are metres relative to it. Two
consequences:

- In that local frame `x` is **east**, `z` is **south**, `y` is **up**. This
  falls out of the composition above, and is the only frame instance positions
  may be expressed in.
- Re-anchoring per refresh keeps instance offsets small, which keeps them
  precise in the float32 instance matrices. A fixed city-wide anchor would not.

### Per-instance transform

Scale is uniform, `height_m / baseHeightM`, where the divisor belongs to the
tree's **form** rather than to the layer (see *Base height is per form*). A tree
with a `NULL` `height_m` uses `TREE_FALLBACK_HEIGHT_M` = **9.1** — the measured
median of the inventory — and the layer MUST NOT substitute anything else: not
zero, not a neighbouring tree's height, not a random value.

Rotation is a **yaw only** — about the local frame's `y`, which is up — by an
angle in `[0, 2π)` that belongs to the tree. Without it a street of 榕樹 is the
same mesh stamped forty times at forty spacings, and the repetition reads as a
rendering artefact rather than as a row of trees. There is no pitch and no roll:
a leaning tree is a thing the survey does not record, and inventing one would be
inventing data.

`diameter_cm` is carried as a property and used by the points record, but does
**not** drive mesh geometry. Nine thousand park rows record a diameter of zero,
and a trunk width derived from bad data reads as a rendering bug.

#### Rotation is hashed, not random

The angle is a **pure function of the tree's `tree_id`**, computed by
`rotationOf` in `placement.ts`, and the layer MUST NOT call `Math.random` to
produce it — or to produce anything else, anywhere.

This is the per-instance form of the rule the geometry builders already follow.
Their offsets are fixed constants so that a form yields the same shape on every
reload; an instance's yaw is hashed from its identity so that a *tree* keeps the
same orientation on every reload. A random angle would redecorate the whole city
on every refresh — and the refresh runs on `idle`, so trees would visibly spin
as you panned.

`tree_id` is the right seed because it is already the layer's notion of which
tree this is: it is the property instances are deduped by, it is published for
exactly that reason, and a custom drop-in carries one like any other row. Seeding
from the coordinate instead would tie a tree's orientation to its position, so
two trees planted at the same spot in different datasets would be
indistinguishable, and correcting a survey coordinate by a metre would spin the
tree.

Three consequences follow, and all three are wanted:

- **A tree's rotation is the same under both mesh sources.** The hash reads the
  tree, not the geometry, so switching source re-orients nothing. Invariant 13
  covers where a tree stands and how tall it is; rotation now joins that list.
- **It survives re-anchoring.** The anchor moves with the viewport on every
  refresh, and position is expressed relative to it — but the yaw is absolute,
  so panning cannot change it.
- **It is stable across reloads only as far as `tree_id` is.** If `infra`
  reloads the inventory and a row's `tree_id` changes, that tree gets a new
  orientation. That is the honest behaviour: the layer has been told it is a
  different tree.

The hash is FNV-1a over the id's UTF-16 code units in 32-bit integer
arithmetic, **followed by murmur3's `fmix32` finalizer**, scaled to `[0, 2π)`.

The finalizer is load-bearing, not polish. The inventory's ids are sequential —
`BT0015000001`, `BT0015000002`, … — and trees along one street carry consecutive
ones. Two ids differing by 1 in the last digit leave FNV-1a differing by exactly
one multiple of the prime, which is 0.39% of the circle: measured on the real
ids, consecutive trees came out **1.4° apart**. A boulevard would have drawn as
one mesh stamped forty times, all facing the same way — the artefact this
rotation exists to remove, reintroduced by the hash meant to remove it.

What plain FNV-1a got right was the *distribution*: 20,000 ids already spread
evenly over the circle. The defect was **local correlation** between neighbouring
ids, which a histogram cannot see. So the test for this measures the angular gap
between consecutive ids, not just the spread — a uniformity check alone passes
the broken version.

The whole function is written out rather than pulled from a dependency, because
the *exact* arithmetic is the contract: changing the constants, the traversal or
the finalizer is not a refactor, it is a reshuffle of every tree in Taipei.

### Meshes and materials

`buildForm(form)` produces two merged geometries — bark and canopy — drawn as two
`THREE.InstancedMesh`es sharing one instance list. Each of the eight forms owns
such a pair, so the procedural source holds sixteen meshes.

A **modelled** form holds one `InstancedMesh` per part instead — between one and
five of them, depending on how the asset was authored — all sharing that form's
single instance list. Whichever source is active the rule is the same: **a form
is a list of meshes over one instance list, and the whole list is written and
counted together.** The bark/canopy pair is simply the procedural case of it.

The meshes are per part rather than merged per form so that the layer keeps **one
material per geometry**, which is what `setOpacity` iterates over. Collapsing
them would break the GeoLibre paint bridge — and for a modelled form it could not
be done at all, because its parts do not share a material.

#### The material registry

The rule this replaces — *the sixteen meshes share exactly two material
instances* — cannot survive a source whose materials come out of a file. Sixteen
procedural meshes share two; eight modelled forms bring twenty-odd of their own,
authored by someone else.

So the constraint moves from **how many** materials there are to **where they
are**. The layer keeps a **registry** of every material it draws with: the two
procedural ones are in it from construction, and a model's materials are added
to it as that model loads. `setOpacity` iterates the registry; `dispose` disposes
it.

The invariant that replaces the count: **a material the layer draws with is a
material in the registry.** A mesh built against a material the registry does not
hold is invisible to the paint bridge — it stays at full opacity while the rest
of the canopy fades, which reads as a rendering bug and is a contract bug.
Per-form materials are no longer forbidden; unregistered ones are.

### Shared GL context

Two rules follow from three.js and MapLibre sharing one context:

1. Materials set `premultipliedAlpha: true` — MapLibre uses
   `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` and expects premultiplied colours, or
   the meshes wash out at partial opacity.
2. `renderer.resetState()` runs every frame, handing the context back in a known
   state. `autoClear` is `false` so three.js never clears MapLibre's buffer.

## Form classes

Every tree is no longer the same shape. The inventory names 471 species across
the two files, and modelling 471 is neither possible nor useful — but the number
of *silhouettes* those species resolve to is small. The layer models **seven**,
plus the generic shape it drew before.

| form | silhouette | trees | share | species |
| --- | --- | --- | --- | --- |
| `spreading` | crown wider than tall; dome or umbrella | 76,027 | 46.66% | 44 |
| `upright` | crown taller than wide; oval or vase | 46,056 | 28.27% | 30 |
| `tiered` | horizontal whorled layers, visible gaps between them | 15,401 | 9.45% | 5 |
| `columnar` | narrow, near-vertical sides, foliage to the ground | 6,832 | 4.19% | 10 |
| `palm-feather` | bare trunk, pinnate crown | 6,056 | 3.72% | 4 |
| `conic` | tapering spire | 2,471 | 1.52% | 5 |
| `palm-fan` | bare trunk, palmate crown | 1,966 | 1.21% | 2 |
| `generic` | the shape this layer drew before | 8,121 | 4.98% | the other 371 |

100 species carry 95.02% of the inventory, which is why a hand-written table is
the right instrument: the tail is 371 species averaging 22 trees each, and no
amount of work on it changes what the map looks like.

### The names are silhouettes, not taxonomy

A class is named for the shape it draws and MUST NOT be named for a taxon. This
is not a style preference — the data punishes taxonomic naming:

- 福木 *Garcinia subelliptica* (1,983) is a broadleaf that draws as `columnar`,
  next to 龍柏 and 側柏.
- 竹柏 (319) is *Nageia nagi*, a conifer, and 羅漢松 + 蘭嶼羅漢松 (1,572) are
  *Podocarpus* — none is a pine or a cypress, and all three draw as `columnar`.
- 楓香 (10,409) is *Liquidambar formosana*, not *Acer*, but draws `upright`
  alongside 青楓, which is.

A class named `cypress` would have to lie about three of those. A class named
`columnar` is simply true.

### What the classes rule out

`spreading` and `upright` together are 75% of the inventory, so the map's
character is set by two shapes. That is the intended trade: the silhouettes that
read as *Taipei* — 黑板樹's whorled pagoda, 小葉欖仁's flat tiers, the palms —
are the ones split out, and the rest of the broadleaf canopy is a dome or an
ovoid. Splitting `spreading` further (a vase 榔榆 against a dense 芒果) is the
next increment if one is wanted; it does not require this design to change.

## The species table

`src/layers/tree/forms.ts` holds `SPECIES_FORMS`, a `Record<string, TreeForm>`
keyed by the exact `species` string the tiles carry, and `formOf(species)`,
which returns `"generic"` for anything absent, for `null`, and for the 18 rows
that carry no species at all.

**The table is data; this spec owns the classes.** Adding a species to
`SPECIES_FORMS`, or moving one between classes, is a data correction and needs
no spec change. Adding, removing or renaming a **form** does — it changes what
the layer can draw, and the table above and `TreeForm` must move together.

Keys are matched **exactly**, with no normalisation. The inventory is internally
consistent on the variants that would otherwise need it: 臺 never appears as 台
for the same species, 溼 never as 濕, and no key carries stray whitespace. A
normalisation step would therefore be dead code today and a place for a silent
mismatch to hide tomorrow.

The table is **not** derived from the data and cannot be. It is a judgement about
what each species looks like, and a wrong row is a wrong shape on the map, not an
error anywhere. Assignments worth knowing are contested:

- **楓香 → `upright`** (10,409 trees, the single largest consequence in the
  table). Conical when young, broadly oval when mature; Taipei's street
  plantings are mostly the latter. `conic` is defensible.
- **木棉 → `tiered`** (2,142). The horizontal whorled branching is the reason,
  and it is most legible on a bare winter tree — which this layer does not model.
- **阿勃勒 → `spreading`** (2,537). Vase-shaped as often as domed.

### Custom trees

Drop-in rows go through the same table by the same rule. A supplier's species
string that is not a key draws `generic` — the honest outcome, and the same one
an unclassified city species gets. There is no separate path and no warning: the
layer cannot tell a typo from a species it has not classified yet.

## Two mesh sources

A form is a silhouette. *Drawing* that silhouette is a separate question, and the
layer now answers it two ways:

| source | `meshSource` | what it draws |
| --- | --- | --- |
| procedural | `"procedural"` (default) | the eight shapes `formGeometry.ts` builds out of icosahedra, cylinders and boxes |
| modelled | `"model"` | one authored glTF model per form, loaded from `public/models/trees/` |

The switch is per map, not per tree: every tree in view changes source together.
There is no per-form and no per-species override, because the reason to switch is
to compare two renderings of the same city — not to assemble a third one out of
both halves.

### Neither source is "real"

The control is labelled **Generated** and **Modelled**, and the setting's values
are `"procedural"` and `"model"`. It is tempting to call the second one *real*;
this spec forbids it, for the same reason the form classes are not named after
taxa. A modelled tree is a stock asset of a beech or a spruce, picked because its
silhouette matches a form. It is not a portrait of the 榕樹 standing at that
coordinate and is no more a likeness of it than the icosahedra are. What is real
under both sources is the position and the surveyed height; the shape is a
stand-in either way. Labelling one source *real* would claim otherwise, on every
tree, in the panel.

### What the two sources share

Everything except geometry and materials. Under either source, trees:

- are placed by the same instance list, in the same local metre frame;
- scale by `height_m / baseHeightM`, where `baseHeightM` is **measured from the
  built or loaded geometry, never hand-written** (see *Base height is per form*);
- fall a `NULL` height back to `TREE_FALLBACK_HEIGHT_M` = 9.1, and to nothing
  else;
- are yawed by the same angle, hashed from the same `tree_id`;
- obey the same `MAX_INSTANCES` cull, applied globally before form bucketing;
- take opacity and visibility through the GeoLibre paint bridge.

Switching source therefore cannot change which trees are drawn, or where, or how
tall. That is the property the toggle is worth having for: two pictures of one
dataset, not two datasets.

## The model table

`src/layers/tree/models.ts` holds `FORM_MODELS`, one file per form:

| form | file | modelled height | note |
| --- | --- | --- | --- |
| `spreading` | `oak_tree.glb` | 8.83 m | a 10.5 m dome — the 榕樹 / 樟樹 stand-in |
| `upright` | `beech_tree.glb` | 3.80 m | ovoid, clearly taller than wide |
| `tiered` | `acacia_tree.glb` | 6.90 m | contested — an umbrella, not whorled layers |
| `columnar` | `bamboo.glb` | 4.40 m | contested — the only narrow shape with foliage to the ground |
| `conic` | `spruce.glb` | 10.52 m | a tapering spire |
| `palm-feather` | `coconut_palm.glb` | 6.28 m | bare trunk, pinnate crown |
| `palm-fan` | `date_palm.glb` | 7.34 m | contested — the set contains no fan palm |
| `generic` | `maple_tree.glb` | 5.78 m | an unremarkable broadleaf |

Each row is **one file per level**: `oak_tree.glb` and, today, `oak_tree.L1.glb`
— a decimated copy for trees far enough away that nobody can count its
triangles. See *Levels of detail*.

The heights are **documentation of what the files contain, not input to the
code**: the loader measures each model and this column is never read. A number
that is only ever printed cannot drift the map the way `TREE_BASE_HEIGHT_M` did.

Three assignments are marked contested, and are worth stating plainly, because
the modelled source is where the form vocabulary stops being able to hide:

- **`palm-fan` → `date_palm`** is a feather palm standing in for a fan palm.
  蒲葵 and 華盛頓椰子 are 1.21% of the inventory and nothing in the set is
  palmate. The choice was this or folding `palm-fan` into `palm-feather`
  whenever the modelled source is on, and a form that silently merges is worse
  than one that is visibly approximate.
- **`columnar` → `bamboo`** draws 福木 and 龍柏 as culms. Wrong in detail, right
  in silhouette, and the only candidate with foliage to the ground.
- **`tiered` → `acacia_tree`** is a flat umbrella where 黑板樹 is a whorled
  pagoda. The procedural `tiered` shape is the better of the two here — which is
  itself an argument for keeping both sources rather than replacing one.

Nine further models sit in the same folder unreferenced: `birch_tree`,
`pine_tree`, `fir_tree`, `old_tree`, `curly_palm`, `banana_plant`,
`tropical_plant_2`, `tropical_plant_monstera_deliciosa` and `daisies`. They are
the shelf this table is retuned from. Nothing fetches them, so an unreferenced
model costs disk and nothing else — measured, a session over Da'an requests
exactly the eight files the table names.

As with `SPECIES_FORMS`, **the table is data and this spec owns the forms.**
Changing which file a form loads is a judgement correction and needs no spec
change. Adding, removing or renaming a *form* still does.

## The assets

### Where they live

`app/public/models/trees/`, served by Vite at `/models/trees/<file>.glb`. They
are **not** imported: a seventeen-file binary set has no business in the module
graph, and `public/` is the one directory Vite copies through verbatim.

They are committed, through **Git LFS** — `app/public/models/trees/*.glb` is an
LFS pattern. A clone made without LFS gets pointer files, every model load fails,
and the modelled source reports itself unavailable while the procedural source
carries on untouched. That is a degradation, not a broken app, and it is the
same shape as *When the server is down*.

### They are prepared, not the files that were downloaded

`app/tools/prepare-tree-models.py` reads an original GLB and writes **one served
file per level of the ladder** — today `<name>.glb` and `<name>.L1.glb`. For
each it does exactly two things:

1. **Resizes every texture to at most 512 px on its long edge and re-encodes it
   as WebP**, declaring `EXT_texture_webp`. The originals carry three
   uncompressed 1024² PNGs per material — six to fifteen images, 4–11 MB a file,
   124 MB across the set. A tree on this map is tens of pixels wide at z16 and a
   few hundred at z20, so the second half of that resolution is never resolved
   and is pure transfer and VRAM. Prepared, the folder is **13.5 MB** across
   both levels, of which the eight forms a session can actually load are
   **7.2 MB** — 6.3 MB at level 0 and 0.94 MB at level 1. WebP rather than
   JPEG because the foliage is `alphaMode: MASK` and the cutout lives in the
   baseColor alpha channel, which JPEG does not carry.
2. **Preserves `asset.extras` byte for byte.** That block holds each model's
   author, licence and source URL, and is the only record of them inside the
   file. A prep step that dropped it would turn a documented CC-BY asset into an
   anonymous one.

### Decimation, and why welding comes first

Every level above 0 is produced by `gltf-transform` (meshoptimizer) at
`--ratio 0.1 --error 0.15`, and its textures are prepared at **128 px** rather
than 512 — a tree beyond 300 m resolves neither the geometry nor the texels.
That makes a level-1 model 39–212 KB against level 0's 0.3–1.6 MB, so the whole
rung adds under 1 MB to what a session loads.

Across the eight forms in the table, decimation takes **69,998 triangles to
11,640** — 6.0× overall, and 10× on most. Three fall short of the ratio:
`beech_tree` 4.1×, `spruce` 6.5×, `date_palm` 2.2×. That is **topology, not the
error bound** — the numbers are identical at `--error` 0.15, 0.3 and 0.6, and
`--lock-border false` is already the default. Those models' foliage is
disconnected cards that meshoptimizer will not collapse further. Loosening the
error further buys nothing, so it is not set higher on the strength of looking
like it might.

**The `weld` pass before `simplify` is load-bearing, not tidying.** These are
Sketchfab exports with split vertices, and meshoptimizer will not collapse an
edge across a split. Run without welding, the leaf mesh obeyed the ratio
(7,340 → 673 triangles) while the trunk did not move **at all** — 1,024 before
and 1,024 after, at every ratio tried. Welded first, the same command reaches
the target on every primitive: oak_tree goes 8,364 → 775 triangles, a 10.8×
reduction. A prep step that silently declines to simplify an eighth of the
geometry is the kind of thing that only shows up in a frame-time graph.

The originals are not kept in the repo. `CREDITS.md` records the source URL of
every model, which is what keeps them re-fetchable, and the decimated file is
covered by the same credit as the model it is derived from — a decimated CC BY
asset is still a CC BY asset.

### Licensing

Every served model is **CC BY 4.0, by evolveduk** — the layer's **third**
attribution obligation, after OpenStreetMap and Taipei's open data.
`MODELS_ATTRIBUTION` MUST be rendered in the status bar whenever a modelled tree
is on screen, and `CREDITS.md` — title, author, licence and source URL per file,
generated by the prep script from `asset.extras` and never typed — ships beside
the models.

One model that arrived with the set, `stylized_tropical_pack.glb`, is under the
**Sketchfab Standard License** rather than CC BY, and is deliberately absent.
That licence does not permit redistributing the model file, and everything under
`public/` is downloadable by definition. The layer's tests assert the absence
rather than trusting it: every GLB in the folder must declare a CC-BY licence in
`asset.extras`, so re-adding that file fails `npm test` instead of shipping.

## Geometry — the procedural source

`buildForm(form)` returns a `{ bark, canopy }` pair of merged geometries for each
of the eight forms, lit by one hemisphere light and one directional light. The
builders are **procedural**: no asset, no loader, no async step, no licence.
Offsets and rotations remain **fixed constants, never `Math.random`**: the same
form yields the same geometry on every reload.

This is the default source and the one that always works. It is what the map
draws before any model has loaded, from a clone made without Git LFS, and after
a model fails to load.

**Form is what made the glTF swap tractable — the axis that turns a per-species
asset problem (471) into a per-form one (8).** The swap this section once named
as the intended extension point has now been taken; see *Geometry — the modelled
source*. It was cheap for exactly that reason, and it did **not** replace this
source. Eight files is a small enough number that keeping both and letting the
panel choose costs less than picking one.

### Base height is per form

`TREE_BASE_HEIGHT_M` is gone as a module constant. Each form carries the height
its geometry was modelled at, and the per-instance scale is
`height_m / form.baseHeightM`. A 13 m constant shared by a fan palm and a 九芎
would misproportion one of them.

That height is **measured from the built geometry, never written by hand**. The
constant it replaces had already drifted from the mesh it described: the shape
stood 12.23 m while the layer scaled it as 13, so every tree in the city drew
about 6% short of its surveyed height, silently and for as long as the constant
existed. A declared number can drift again; a measured one cannot.

`TREE_FALLBACK_HEIGHT_M` = 9.1 stays global and unchanged. It is a fact about the
*data* — the measured median of the inventory — not a property of any geometry,
and invariant 7 still governs it: a missing height renders at 9.1 m in whatever
form the species maps to, and nothing else is substituted anywhere.

### The canopy hull

`canopyHullOf(form)`, exported from `index.ts`, is the convex hull of the form's
procedural canopy. It is a closed `BufferGeometry` in this layer's Y-up frame,
normalised to a tree of height 1: the canopy's vertices divided by the form's
`baseHeightM`.

It is **measured from the built geometry, like `baseHeightM`**, and built once
per form and cached; callers must not dispose it. The sunlight layer casts its
shadows with it, placed with this layer's own `rotationOf`. So the shadow's
outline and the drawn crown agree, down to which way the crown faces.

It describes the procedural source only. A modelled tree's shadow is its form's
procedural hull, which is correct: the index takes nothing from the drawn mesh
(see the sunlight spec).

### The instance budget

`MAX_INSTANCES` = 20,000 is a **global** ceiling, not a per-form one. Sixteen
meshes each sized for 20,000 instances would allocate 320,000 matrix slots —
roughly 40 MB of buffer to draw a viewport that holds a few thousand trees.

So each form's mesh pair is allocated **lazily** at first use and **grows** in
powers of two from 1,024, never shrinking, capped at `MAX_INSTANCES`. A viewport
that is entirely palms is therefore served, and one that is entirely banyans
never allocates a palm buffer at all. Growth reallocates the form's
`InstancedMesh`es — the old ones are disposed and replaced in the group — which
is why it is bounded to at most five doublings per form.

Capacity is a property of the **form**, not of a mesh, and a modelled form's
parts share one instance-matrix attribute between them. A five-part model
therefore costs the same matrix buffer as the procedural pair does, and the
ceiling above stays a statement about trees rather than about how finely someone
else split their asset.

### What form does not touch

The `tree-points` half is unchanged. Circles remain coloured by `kind` and sized
by `height_m`; form is a property of the mesh geometry and reaches nothing else.
`TreeSettings` gains no field for it — there is no filter by form and no
control for one,
because a form is not a thing a reader of the map has asked to isolate.

## Geometry — the modelled source

### Loading

`GLTFLoader`, from `three/examples/jsm/loaders/GLTFLoader.js` — the same `three`
package `formGeometry.ts` already takes `mergeGeometries` from, so the modelled
source adds **no dependency**.

Loading is **lazy and per form**. Nothing is fetched until `meshSource` is first
set to `"model"`; from then each form's file is requested once, in parallel with
the others, and cached for the session. A form with no tree in view is never
fetched, so a session spent over a palm-lined boulevard downloads two files
rather than eight — the same reasoning that allocates a form's buffers lazily.

**A form keeps drawing procedurally until its model arrives.** This does not
contradict *When the server is down*, because nothing is being invented: the
position and the height are the data, both are already on screen, and both are
unchanged. Only the silhouette is pending, and the shape the layer drew a moment
ago is a better answer for the next second than a hole in the canopy. A tile that
never arrives means a tree we cannot claim exists; a model that has not arrived
yet means a tree we are still drawing the other way.

**A load that fails leaves that form procedural for the rest of the session.** No
retry loop, and no substitute: a form never borrows another form's file. The
panel reports how many forms are modelled, so a permanent failure is visible
rather than silent — a canopy quietly missing its palms is exactly the kind of
thing nobody notices.

### Normalisation

A downloaded model is not instanceable as it arrives. The loader fixes three
things before it is:

1. **The node tree is flattened.** Each mesh primitive's world matrix is baked
   into a clone of its geometry, so the form becomes a flat list of
   `{ geometry, material }` parts with no transform left to apply. Sketchfab
   exports carry their Y-up correction as a root rotation, and baking is what
   absorbs it.
2. **The parts are moved onto the origin.** The union bounding box is measured
   and every part translated so that the box's **minimum Y is 0** and its X/Z
   centre is 0. The models do not agree about this on their own — `old_tree`
   sits with 1.21 m of root below its origin — and an unmoved model plants its
   trees at the wrong depth.
3. **`baseHeightM` is the measured height of that box**, exactly as for a
   procedural form. *The model table* prints the number; the code never reads
   it.

Steps 2 and 3 are why *Base height is per form* is written the way it is. The
rule that a modelled height is measured and never declared was load-bearing
before there was a downloaded model to measure.

### Levels of detail

A modelled form is a **ladder** of geometries numbered from 0, and a tree draws
the lowest-numbered level whose reach covers its distance from the camera. The
last rung has no reach and catches everything beyond it.

| level | file | drawn when | oak_tree |
| --- | --- | --- | --- |
| 0 | `<name>.glb` | within 300 m of the camera | 8,364 tris |
| 1 | `<name>.L1.glb` | beyond 300 m | 775 tris |

Level 0 is the authored model and keeps the plain name; every decimated level
carries its number.

**The ladder is data** — `MODEL_LODS` in `models.ts`, `LEVELS` in the prep
script — so adding an `L2` tier beyond, say, 600 m is a row in each rather than
a change to this design. Nothing in the layer names a level; it indexes one, and
the bucket a tree lands in is `<form>|<level>`.

That is why the levels are numbered and not called `near` and `far`. A two-value
name is a two-value ceiling — in the file name and in the type behind it alike —
and it would have to be unpicked by whoever adds the third rung. The cost of
avoiding that now is an integer.

The procedural source is a single level and needs no ladder: it is around 130
triangles a tree already.

The ladder exists because instancing was never the bottleneck. Measured over
Da'an at z17.2 and pitch 65, the modelled source drew 11,607 trees in **22 draw
calls** — instancing doing exactly its job — and **95.2 million triangles a
frame**, which took the map from 120 fps to 13. One mesh was 61% of it:
oak_tree's canopy, 7,340 triangles against 7,866 instances, because `spreading`
is 46% of the inventory. These are hero assets authored to look right as *one*
tree.

With the ladder in place the same view draws **11.5 million triangles at
10.5 ms a frame — 95 fps**, and z20 at pitch 70 is 9.8 million at 8.8 ms.

Frame times are the median of three fresh-page trials, because a single
measurement of this is not worth much: an early one-off reading of this same
view came back 40% slower and did not reproduce. The triangle and instance
counts are exact.

**Level 0's reach is nearly free.** At 150 m the same two views ran 10.4 ms and
8.3 ms; at 300 m they run 10.5 ms and 8.8 ms — 1% and 6%. The expensive part was
never the near tier, which is small by construction; it was the 95 million
triangles that existed before there was a far tier at all.

#### Level 0 is for very few trees, and that is correct

Measured on fresh pages, the split is lopsided: **34 of 11,607** trees are at
level 0 at z17.2 and pitch 65, and **151 of 9,293** at z20 and pitch 70. The
reason is geometry, not a mis-set threshold — the camera stands 644 m from the
viewport centre at z17.2 and 80 m at z20, and at this map's pitch most of the
visible ground is a long way off, so only the nearest slice of the frustum is
inside 300 m.

Widening the reach moves this less than it looks like it should. At 150 m the
z17.2 view had *no* level-0 trees at all and z20 had 31; tripling the reach to
300 m bought 34 and 151. The frustum is deep and most of what is in it is far,
so reach buys detail slowly and costs frame time slowly — which is what makes
this number a comfortable one to choose rather than a knife edge.

The counts move with pitch and with which tiles happen to be loaded — the same
z20 view at pitch 65 holds 367 trees rather than 9,293 — which is invariant 5
showing through: the scene depends on the viewport. The *ratio* is the durable
part.

This is what a level of detail is *for*: full geometry exactly where it can be
resolved. It does mean the level-0 models are 6.3 MB to draw a few dozen trees
at a time, which is the honest cost of them looking right when you descend into
a street. Widening level 0's reach would put more of that download to work and
give back most of the frame time; the number is a judgement, and this paragraph
exists so the next person changes it knowingly.

#### Distance is measured from the camera, not the anchor

The obvious implementation is wrong. Instance positions are already metres from
the **anchor**, which is the viewport centre — so `x² + z²` is free, and using
it would be a mistake. At the pitch this map is built for, the trees nearest the
eye are in the foreground, a hundred metres or more *in front of* the viewport
centre, and they are the largest things on screen. Ranking by anchor distance
would hand them the decimated mesh and keep the full one for the specks on the
horizon.

So the camera's own position is taken from `map.getFreeCameraOptions().position`
and converted into the same local metre frame, and the test is a true 3D
distance — the camera's altitude matters at high pitch.

#### What a level change must not do

A tree's level depends on where the camera is, so it changes as you move. It
must change **nothing else**: not the position, not the rotation, and above all
not the height.

Height is the one that takes care: decimation moves a model's bounding box a
little, so a decimated level measured on its own would stand a fraction of a
percent shorter than level 0, and every tree would twitch as it crossed a
threshold. Every level above 0 is therefore **scaled to level 0's measured
height** at load, and the whole ladder shares one `baseHeightM` — level 0's. A
form's declared height is a property of the form, not of the rung.

Levels are re-evaluated on refresh, which runs on `idle`. Crossing the threshold
during a gesture therefore cannot flicker: the swap happens once, after the
movement settles.

### Materials

A model's materials arrive from the file and are **kept as authored**. The
foliage is `alphaMode: MASK` with a per-model cutoff and is double-sided; both
are what make a leaf card read as leaves, and overriding either would be
redecorating someone else's asset into a worse one. Two things are done to them,
and only two:

1. **`premultipliedAlpha` is set to `true`** on every one, for the reason in
   *Shared GL context*. `GLTFLoader` has no idea it is loading into MapLibre's
   context, so nothing else will do it.
2. **They are added to the material registry**, which is what the paint bridge
   iterates. A model material that is loaded but not registered does not fade
   with the rest of the layer.

Lighting is shared: the same hemisphere and directional light that light the
procedural forms light these, because they are in the same scene and a source
switch must not read as a change in the weather.

## Lifecycle

GeoLibre only moves and shows native layers that already exist, and
`map.setStyle()` destroys custom layers. Therefore, on **every** `style.load`,
the custom layer must be re-added before the next sync.

The `ThreeTreeLayer` instance outlives style changes:

- `onAdd` keeps the existing `WebGLRenderer` when the GL context is unchanged; a
  basemap swap re-adds the layer against the same canvas and context.
- `onRemove` drops only the map reference.
- `dispose` tears the renderer down, on map teardown only.

A basemap swap also discards the vector source, so the instance list is empty
until tiles reload. The refresh on `idle` covers this; no special case is needed.

## Settings

`TreeSettings`, with `DEFAULT_TREE_SETTINGS`:

| field | default | route |
| --- | --- | --- |
| `pointsVisible` | `true` | `tree-points` record → circle opacity (**not** `visible` — see above) |
| `meshVisible` | `true` | `tree-mesh` record → paint bridge → `setVisibility` |
| `meshSource` | `"procedural"` | app → `setMeshSource` directly |
| `opacity` | `1` | `tree-points` record → circle paint; `tree-mesh` → paint bridge → `setOpacity` |
| `heightScale` | `1` | app → `setHeightScale` directly |
| `kind` | `"all"` | `tree-points` → `filterExpression`; `tree-mesh` → app → `setKind` directly |

`kind` is one of `"all"`, `"street"`, `"park"`, `"custom"` — four segments, so
the control is `columns={4}`. `"custom"` selects nothing when no custom data is
loaded, which is the honest outcome: an empty result for an empty dataset, not a
hidden control. Adding a value here means adding it to `TreeKindFilter` in
`index.ts` *and* to `TreeKind` in `treeLayer.ts`, which mirrors it to avoid a
module cycle.

`meshSource` is `"procedural"` or `"model"` — two segments, so the control is
`columns={2}`, labelled **Generated** and **Modelled**. It reaches the mesh layer
directly rather than through GeoLibre, for the same reason `heightScale` does:
which geometry a plugin draws is not a GeoLibre concept, and a record field for
it would be silently inert.

It does not touch the `tree-points` record at all. The circles are the same
circles under either source, and redrawing them on a source switch would be
claiming the data had changed when only the rendering did. This is the one
setting in the table that reaches exactly one of the two halves on purpose.

`heightScale` **replaces** the old absolute `height` control. An absolute height
is meaningless once every tree carries its own; the control now exaggerates, the
way `BuildingSettings.heightScale` does, and 1 means true scale.

`kind` narrows both halves together — the points and the meshes must never show
different subsets of the same data — but it reaches them by **two different
routes**. GeoLibre compiles a `filterExpression` into the circle style layer, and
cannot do the same for a layer it does not paint: a `filterExpression` on
`tree-mesh` is silently inert. So the mesh layer is told separately, through
`setKind`, and applies the filter itself while reading features. Adding a filter
to one route and forgetting the other is the easy way to break invariant 8.

`setOpacity` flips `material.transparent` only when it actually changes, and sets
`needsUpdate` when it does. Every setter calls `map.triggerRepaint()` — the map
is otherwise idle and the change would not appear until the next interaction.

### Panel readouts

Below the controls, past a `.panel__rule`, the Trees card carries only
`StatLine` rows — the same definition-list form the Camera card uses. There is
no prose paragraph in this card:

| line | value | shown |
| --- | --- | --- |
| **Surveyed trees** | `TREES_TOTAL`, grouped (`162,930`) | always |
| **Points from** | `z` + `TREES_MIN_ZOOM` | always |
| **Meshes from** | `z` + `TREE_MESH_MIN_ZOOM` | always |
| **Modelled forms** | `loaded/total`, plus ` · N failed` | only while `meshSource === "model"` |

The count is the **inventory's** size — how many trees the loaded open data
holds — not how many are in view, which moves with the viewport and belongs to
no readout. It is a constant in `constants.ts` beside the rest of the source
contract, because it is a fact about what `infra/` loaded, not about what the
layer draws. It does not count custom trees: `infra/` decides how many of those
exist, the app never learns it, and a figure that silently excludes them is
honest only while it is labelled as the surveyed inventory.

The prose hint this replaces said the same number in a sentence, alongside two
claims — that height comes from the survey, and that the mesh source changes a
tree's look but never its place or height — which are specified here (*Neither
source is "real"*, *What the two sources share*) and are properties of the
layer, not a readout. A card of figures reads at a glance; a paragraph under it
does not.

## Attribution

The inventory is Taipei City open data. It is a **second** source alongside
OpenStreetMap, and therefore a second attribution obligation: MapLibre's own
control is disabled (`attributionControl: false`), so `TREES_ATTRIBUTION` MUST be
rendered by the app's status bar beside `OSM_ATTRIBUTION` whenever this layer is
visible. Removing it is a licensing regression, not a style choice.

> The exact required wording is set by the dataset's licence page on Taipei's
> open-data platform and must be confirmed against it before release.

The modelled source adds a **third** obligation. Every glTF model the layer
serves is CC BY 4.0 by evolveduk, and CC BY requires the author, the licence and
a link. `MODELS_ATTRIBUTION` MUST therefore be rendered beside the other two
whenever a modelled tree can be on screen — that is, whenever `meshVisible` and
`meshSource === "model"` — and `public/models/trees/CREDITS.md` carries the
per-file detail the status bar has no room for.

This one is conditional where the other two are not, and that is the point: the
obligation exists only while the assets are being used. Showing it under the
procedural source would credit evolveduk for icosahedra.

## Retired

- `TREE_LOCATION` is gone. The layer no longer has a location; `lib/viewpoints.ts`
  carries its own coordinate for the "Trees" viewpoint, which is now a vantage
  point over a dense part of Da'an rather than the address of one object.
- `TreeSettings.height` is gone, replaced by `heightScale`.
- `TREE_BASE_HEIGHT_M` is gone. Each form declares the height its geometry was
  modelled at; there is no single modelled height any more.
- `buildTree()` is gone, replaced by `buildForm(form)`. The shape it built
  survives as the `generic` form, which is what an unclassified species draws.

## Invariants

1. Both records are synced in the same `sync([...])` call as the buildings.
2. The custom layer is re-added on every `style.load`.
3. Only `defaultProjectionData.mainMatrix` is used for projection.
4. Visibility and opacity reach three.js through GeoLibre's paint bridge.
5. The mesh **geometry** is deterministic — a form yields the same shape every
   reload, under either source — and so is every tree's **rotation**, which is
   hashed from its `tree_id`. The **scene** is not: it depends on the viewport,
   and that is the point.
6. Instances are deduped by `tree_id`.
7. The layer never invents data. A missing height renders at
   `TREE_FALLBACK_HEIGHT_M`, and nothing else is substituted anywhere.
8. Points and meshes always show the same subset of the data.
9. The `tree-points` record is never `visible: false` while `meshVisible` is
   true — that starves the mesh layer of its data.
10. `TREES_ATTRIBUTION` is displayed whenever the layer is.
11. A species maps to exactly one form, and an unmapped species maps to
    `generic`. The layer never guesses a form from a neighbouring tree, a
    substring match, or a genus.
12. The `MAX_INSTANCES` cull runs before form bucketing, never within a form.
13. `meshSource` changes what a tree looks like and never which trees are drawn,
    where they stand, how tall they are, or which way they face.
14. Every material the layer draws with is in the material registry.
15. A form whose model has not loaded, or has failed to load, draws
    procedurally. It never borrows another form's model and never vanishes.
16. `MODELS_ATTRIBUTION` is displayed whenever a modelled tree can be on screen,
    and not while the procedural source is the one drawing.
17. Every GLB under `public/models/trees/` declares a CC-BY licence in
    `asset.extras`, and the test suite enforces it.
18. The layer never calls `Math.random`. Per-tree variation is hashed from
    `tree_id`; per-form variation is a fixed constant.
19. A level-of-detail change alters a tree's triangle count and nothing else —
    not where it stands, how tall it draws, or which way it faces. Every level
    of a form shares one `baseHeightM`, measured from level 0.
