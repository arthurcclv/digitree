# Tree layer — spec

Source of truth for the tree layer. Behaviour changes here require this file to
change first.

Modules:
- `src/layers/tree/index.ts` — the two GeoLibre records (owns the description)
- `src/layers/tree/treeLayer.ts` — the MapLibre custom layer (owns the pixels)

## Purpose

Renders Taipei's tree inventory — 162,930 surveyed street and park trees, served
from the local PostGIS + Martin stack in `infra/`, plus any custom trees dropped
into that stack — at two levels of detail:

- **points**, as MapLibre circles, from z14 across the whole city;
- **mesh**, as instanced three.js geometry, from z16 within the viewport, in
  one of **eight shapes** chosen from the tree's species (see *Form classes*).

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

`diameter_cm` is carried as a property and used by the points record, but does
**not** drive mesh geometry. Nine thousand park rows record a diameter of zero,
and a trunk width derived from bad data reads as a rendering bug.

### Sixteen meshes, two materials

`buildForm(form)` produces two merged geometries — bark and canopy — drawn as two
`THREE.InstancedMesh`es sharing one instance list. Each of the eight forms owns
such a pair, so the scene holds sixteen meshes.

They are two per form rather than one merged mesh so that the layer keeps **one
material per geometry**, which is what `setOpacity` iterates over. Collapsing
them would break the GeoLibre paint bridge.

The sixteen meshes share **two** material instances — one bark, one canopy —
across all forms. That is what keeps the bridge intact as the form count grows:
`setOpacity` still iterates two materials, exactly as it did with one form,
rather than sixteen that could drift apart. Per-form materials are therefore
forbidden; a form that needs its own colour needs vertex colours, not its own
material.

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

## Geometry

`buildForm(form)` returns a `{ bark, canopy }` pair of merged geometries for each
of the eight forms, lit by one hemisphere light and one directional light. The
builders are **procedural**, so the app still carries no model asset, no loader,
no async step and no third attribution obligation. Offsets and rotations remain
**fixed constants, never `Math.random`**: the same form yields the same geometry
on every reload.

Keeping it procedural is what makes this change cheap, and it is also what makes
a later glTF swap cheap: **form is the axis that turns a per-species asset
problem (471) into a per-form one (8).** That swap remains the intended extension
point; it is now a tractable one.

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

### The instance budget

`MAX_INSTANCES` = 20,000 is a **global** ceiling, not a per-form one. Sixteen
meshes each sized for 20,000 instances would allocate 320,000 matrix slots —
roughly 40 MB of buffer to draw a viewport that holds a few thousand trees.

So each form's mesh pair is allocated **lazily** at first use and **grows** in
powers of two from 1,024, never shrinking, capped at `MAX_INSTANCES`. A viewport
that is entirely palms is therefore served, and one that is entirely banyans
never allocates a palm buffer at all. Growth reallocates the pair's
`InstancedMesh`es — the old ones are disposed and replaced in the group — which
is why it is bounded to at most five doublings per form.

### What form does not touch

The `tree-points` half is unchanged. Circles remain coloured by `kind` and sized
by `height_m`; form is a property of the mesh geometry and reaches nothing else.
`TreeSettings` gains no field — there is no filter by form and no control for it,
because a form is not a thing a reader of the map has asked to isolate.

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
| `opacity` | `1` | `tree-points` record → circle paint; `tree-mesh` → paint bridge → `setOpacity` |
| `heightScale` | `1` | app → `setHeightScale` directly |
| `kind` | `"all"` | `tree-points` → `filterExpression`; `tree-mesh` → app → `setKind` directly |

`kind` is one of `"all"`, `"street"`, `"park"`, `"custom"` — four segments, so
the control is `columns={4}`. `"custom"` selects nothing when no custom data is
loaded, which is the honest outcome: an empty result for an empty dataset, not a
hidden control. Adding a value here means adding it to `TreeKindFilter` in
`index.ts` *and* to `TreeKind` in `treeLayer.ts`, which mirrors it to avoid a
module cycle.

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

## Attribution

The inventory is Taipei City open data. It is a **second** source alongside
OpenStreetMap, and therefore a second attribution obligation: MapLibre's own
control is disabled (`attributionControl: false`), so `TREES_ATTRIBUTION` MUST be
rendered by the app's status bar beside `OSM_ATTRIBUTION` whenever this layer is
visible. Removing it is a licensing regression, not a style choice.

> The exact required wording is set by the dataset's licence page on Taipei's
> open-data platform and must be confirmed against it before release.

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
5. The mesh **geometry** is deterministic — the same form yields the same shape
   every reload. The **scene** is not: it depends on the viewport, and that is
   the point.
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
