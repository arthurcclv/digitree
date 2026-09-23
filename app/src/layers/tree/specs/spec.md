# Tree layer — spec

Source of truth for the tree layer. Behaviour changes here require this file to
change first.

Modules:
- `src/layers/tree/index.ts` — the two GeoLibre records (owns the description)
- `src/layers/tree/treeLayer.ts` — the MapLibre custom layer (owns the pixels)

## Purpose

Renders Taipei's tree inventory — 162,930 surveyed street and park trees, served
from the local PostGIS + Martin stack in `infra/` — at two levels of detail:

- **points**, as MapLibre circles, from z14 across the whole city;
- **mesh**, as instanced three.js geometry, from z16 within the viewport.

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

`kind` is `"street"` or `"park"`. `height_m` and `diameter_cm` are **nullable**:
`NULL` means the survey value was missing or implausible, not zero. `species` is
nullable too — 18 rows carry none.

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
  builds its ramp.
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

Scale is uniform, `height_m / TREE_BASE_HEIGHT_M`. A tree with a `NULL`
`height_m` uses `TREE_FALLBACK_HEIGHT_M` = **9.1** — the measured median of the
inventory — and the layer MUST NOT substitute anything else: not zero, not the
clamp ceiling, not a random value.

`diameter_cm` is carried as a property and used by the points record, but does
**not** drive mesh geometry. Nine thousand park rows record a diameter of zero,
and a trunk width derived from bad data reads as a rendering bug.

### Two instanced meshes, not one

`buildTree()` produces two merged geometries — bark and canopy — drawn as two
`THREE.InstancedMesh`es sharing one instance list.

They are two rather than one merged mesh so that the layer keeps **one material
per geometry**, which is what `setOpacity` iterates over. Collapsing them into a
single mesh would break the GeoLibre paint bridge.

### Shared GL context

Two rules follow from three.js and MapLibre sharing one context:

1. Materials set `premultipliedAlpha: true` — MapLibre uses
   `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` and expects premultiplied colours, or
   the meshes wash out at partial opacity.
2. `renderer.resetState()` runs every frame, handing the context back in a known
   state. `autoClear` is `false` so three.js never clears MapLibre's buffer.

## The mesh

Procedural, so the app carries no model asset and no loader: a 9-sided cylinder
trunk plus four overlapping flat-shaded icosahedra as canopy, lit by a hemisphere
light and a directional light. Offsets and rotations are **fixed constants, never
`Math.random`**.

`TREE_BASE_HEIGHT_M` = `13` — the modelled height every instance scales from.

Every tree is the same shape. The inventory names 291 street and 448 park
species, and the layer makes no attempt to model them: species is available for
colour, not for geometry. Swapping `buildTree()` for per-species glTF models is
the intended extension point.

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

## Invariants

1. Both records are synced in the same `sync([...])` call as the buildings.
2. The custom layer is re-added on every `style.load`.
3. Only `defaultProjectionData.mainMatrix` is used for projection.
4. Visibility and opacity reach three.js through GeoLibre's paint bridge.
5. The mesh **geometry** is deterministic — same shape every reload. The
   **scene** is not: it depends on the viewport, and that is the point.
6. Instances are deduped by `tree_id`.
7. The layer never invents data. A missing height renders at
   `TREE_FALLBACK_HEIGHT_M`, and nothing else is substituted anywhere.
8. Points and meshes always show the same subset of the data.
9. The `tree-points` record is never `visible: false` while `meshVisible` is
   true — that starves the mesh layer of its data.
10. `TREES_ATTRIBUTION` is displayed whenever the layer is.
