# DECISIONS

Append new decisions at the **top**. Each entry: what was decided, what it
rules out, and what would make us revisit it. A decision that is reversed gets a
new entry — the old one stays, marked superseded.

---

## 2026-09-29 — The four three.js layers extend one `ThreeLayer` host

**Decision.** `ThreeLayer` (`src/lib/three`) is the base of `ThreeTreeLayer`,
`ThreeSunlightLayer`, `ThreeTemperatureLayer` and `ThreeAoLayer`.
- It owns the renderer's lifecycle: one per context, kept across `setStyle`,
  rebuilt on a new context (`contextChanged`), disposed at teardown.
- It owns the coalesced `idle` (`viewSettled`), `renderingMode: "3d"`, and
  `pass(fn)`, which runs `resetState()` before and after every block of
  three.js drawing.
- Its helpers are `projection(args, model)`, the one read of `mainMatrix`;
  `mercatorFrame(origin, metre)`; and `PREMULTIPLIED_OVER`.

The rules of 2026-09-22 (*`renderingMode: "3d"`*, *`mainMatrix`*) stand. They
now live in one module instead of four. The contract is
`src/lib/three/specs/spec.md`.

**Why.** Each class wrote the rules out for itself, and they had drifted.
Tree and sunlight reset state only before `render`, and the sunlight spec
already said "before and after each pass". Getting any of these wrong fails
silently.

**Also decided.**
- `render` and `prerender` stay in each layer. MapLibre gives every layer
  that *has* a `prerender` an offscreen pass (`hasOffscreenPass()` is
  `prerender !== undefined`), so the base defines neither. Tree has none, as
  before.
- The one behaviour change is that tree's and sunlight's `render` now also
  reset after drawing. It was verified in the browser: the direct-sun and PET
  GeoTIFF exports are byte-identical to the previous commit's, and so are the
  screenshots, whenever two runs load the same tiles.
- The base makes its renderer through an overridable `createRenderer`, so the
  lifecycle is tested with a fake renderer and no WebGL.

**Found while doing it.** The occluder count is not repeatable run to run:
the same code settles on 1,792 or 1,795 buildings for the same view, and the
exports differ accordingly. This predates the change. Hash comparisons are
therefore only meaningful between runs with the same count.

**Rejected.** *One renderer shared by all four layers.* Their render targets,
state and lifetimes differ, and one context-loss path would then take down
all four.

---

## 2026-09-29 — Ambient occlusion shades a `ShadedExtrusion`, not the buildings' settings

**Decision.** AO's record and mount take a `ShadedExtrusion` (`visible`,
`heightScale`, `minHeight`). The type is owned by AO and names the extrusion
it redraws and so must match. It replaces `Pick<BuildingSettings, …>` under a
field called `buildings`. The host maps its extrusion's settings onto it
(`useMapEngine`'s `shadedExtrusion`). AO's minimum-height check is now the
buildings schema's `meetsMinHeight`, the JS form of `minHeightFilter`, where it
used to be a hand-written `heightM < minHeight`.

**Why.** The portability half of this already came with the mounts and the
source descriptors. What remained was an interface phrased as a sibling's
settings, and a third copy of the height filter that nothing tied to the
other two. A test now evaluates `minHeightFilter` with MapLibre's
`featureFilter` against `meetsMinHeight`, and another fails if an AO module
imports another layer's settings type.

**Rules out.** AO reading any layer's settings. It may read the buildings'
**data** through their schema (`buildingTiles`, `meetsMinHeight`), because
the data is what it redraws.

---

## 2026-09-29 — Layers take their data sources as descriptors; one schema per dataset

**Decision.** No layer holds an endpoint.
- Where a dataset is served is a plain descriptor the host passes in:
  `TreeSource` (`tiles`, `sourceLayer`, zoom range, `bounds`,
  `attribution`) and `BuildingSource` (`tileJson`, `sourceLayer`,
  `attribution`). The app's values live in one file, `src/sources.ts`
  (`TREES`, `BUILDINGS`, `TREES_SURVEYED`).
- How a feature is read is the owning layer's `schema.ts`. `treeOf` is the one
  reading of a tree, shared by the meshes and the direct-sun layer.
  `buildingHeight` sits beside the extrusion's MapLibre filter and height
  expression.
- `TileStore` becomes generic: `new TileStore({ trees: treeTiles(TREES),
  buildings: buildingTiles(BUILDINGS) })`, read with `featuresOf(name,
  tile)`. `lib/tiles` imports nothing from `src/layers/`.

The contract is `src/lib/tiles/specs/spec.md`.

**Why.** Porting a layer meant editing constants inside it, and `lib/tiles`
imported from `layers/tree` and `layers/basemaps`, so the dependency pointed
the wrong way. Both reading rules were also written twice. Another city is now
a change to `src/sources.ts` alone, provided its data publishes the same
schema.

**Supersedes, in part.** 2026-09-22 *One OSM snapshot*: `buildings` no longer
imports `OSM_TILEJSON`. `src/sources.ts` builds `BUILDINGS` from basemaps'
`OSM_TILEJSON` and `OSM_ATTRIBUTION` and hands that one descriptor to the
extrusion, the sunlight store and the AO store. The snapshot is still one;
`sources.test.ts` asserts it.

**Found while doing it.** With no minimum height, the extrusion filter keeps a
footprint whose `render_height` is 0 or missing and draws it flat.
`buildingHeight` drops it. The difference is harmless: a flat footprint has
nothing to shade or occlude. It is pinned by a test that evaluates the filter
with MapLibre's own `featureFilter`, so it cannot widen unnoticed. Making the
extrusion drop those footprints too would change what the map shows, so that
would be its own spec change.

**Also decided.**
- Property names are part of the schema and not configurable. A mapping
  table would be a seam with one adapter.
- `@maplibre/maplibre-gl-style-spec` is declared as a dev dependency, pinned
  to the version `maplibre-gl` already installs, for that test (`STACK.md`).
- Two tests read the source tree (`lib/tiles/structure.test.ts`): no shared
  module in `src/lib` imports a layer, and no layer except basemaps holds a
  tile endpoint.

**Revisit if** a second dataset with a different schema needs to be read.
That is the second adapter that would justify a mapping seam.

---

## 2026-09-29 — Each layer mounts itself; upstream state travels through the DAG

**Decision.** Every layer with a custom (three.js) half exports a mount,
`mount<Name>(ctx, settings, hooks)`, from a `mount.ts` in its own folder. The
mount constructs the class, registers its paint bridge, adds its DAG node,
pushes non-GeoLibre settings when they change (`update`), re-adds the custom
layer after a style reset and returns the records (`prepareSync`), and tears
down (`dispose`). The contract is `src/lib/mount/specs/spec.md`.
`useMapEngine` becomes a host: it owns the map, the sync, the one graph, the
mount order and the stack order, and knows nothing layer-specific.
The DAG gains a node **state** (`setState`/`state`). Sunlight sets its state
on `sunlight.lpi`, and temperature reads it from there.
`ThreeTemperatureLayer.setUpstreamState` is gone.

**Why.** The goal is that a layer folder can be ported to another GeoLibre
application. Before this change, a layer's real interface was the ~250 lines
of engine glue for it. Any other host would have had to rediscover that glue:
re-adding on every `style.load`, routing visibility around the bridge,
forwarding sunlight's status. Forwarding status was also the alternative the
DAG entry below rejected, back in the code for one field.

**Supersedes, in part.**
- 2026-09-22 *The three.js tree rides in the same `sync()` call*, and
  ARCHITECTURE's "exactly two places touch the map". The custom layers are now
  constructed and added by their own mounts, not by `useMapEngine`. Its rule
  that opacity and visibility go through the paint bridge, never the UI,
  stands, and the mounts now register the bridges.
- 2026-09-29 *Derived layers go through a DAG*: "the engine adds the nodes".
  The host still owns the one graph, but each mount adds its own node.

**Also decided.**
- Overlay visibility, which sets demand, is applied in `update`, not
  `prepareSync`. `prepareSync` runs in stack order, sunlight before
  temperature, so doing it there would build sunlight's record before
  temperature's demand arrived.
- `buildings` gets no mount: it would only pass settings through.
- Record builders move to each folder's `records.ts`, so `mount.ts` and
  `index.ts` never import each other.
- The host skips `sync` when the records are identical to the last ones
  synced. `sync` re-applies every layer, and a sun-time step now reaches the
  host as a settings change that alters no record.

**Rejected.**
- *A mount that listens for `style.load` itself.* It works only if its
  listener runs before the host's sync, which depends on listener
  registration order.
- *A sibling `sunlight.state` node.* State changes happen inside sunlight's
  demand listener, where `publish` throws. `setState` is allowed there, as
  `clear` is.

**Revisit if** a host needs to unmount one layer from a live map, or mount one
twice. Both are out of scope for the mount spec.

---

## 2026-09-29 — The direct-sun overlay computes down to a 5° sun

**Decision.** `MIN_SUN_ELEVATION_DEG` drops from 10° to 5°, so the overlay and
the temperature layer built on it keep working into early morning and late
afternoon. The fetch margin follows the constant: the 150 m reach at 5° is
~1,714 m on every side, up from ~851 m.

**Costs.** About one more ring of z14 tiles around a mid- or high-zoom view on
first sight. At z12 the wider margin mostly falls outside the ±8 km far grid,
so the plan barely grows. Shadows at 5° are ~11.5× their occluder's height, so
the map is mostly shade near the cutoff.

**What would make us revisit it.** Tile counts overrunning the 256-tile cache,
or a need to go lower still: below a few degrees the margin grows without
bound and the far grid no longer contains a tall building's shadow.

---

## 2026-09-29 — The right column is gone; the camera is a status bar

**Decision.** The right sidebar (the Viewpoints and Camera cards) is removed.
The shell becomes the control column plus the viewport, with a 24px
full-width status bar at the foot. The bar reads latitude, longitude and
zoom, right-aligned, and nothing else. The coordinates go unlabelled, since
`25.0339° N` / `121.5645° E` name their own axis; only zoom keeps a label:
- **Bearing** is stated by the compass's label.
- **Pitch** has no readout and no slider; the map's right-/ctrl-drag sets it.
- **Attribution** keeps its plate over the map, not the bar.

The eight viewpoints are **removed**, not moved. `lib/viewpoints.ts` is
deleted. `HOME` stays in `useMapEngine.ts` as the initial camera. `flyTo` and
`setPitch` stay in the engine's return value with no caller, kept on purpose
for the next UI that wants them. This retires DESIGN.md's "Findable"
principle: the trees are found by zooming past z16, not by one click.

**Rejected.**
- *Viewpoints in a toolbar popover, or at the foot of the left column*:
  keeps a feature the user chose to drop.
- *Bearing and pitch in the bar*: the ask was coordinates and zoom. Bearing is
  already on the compass.
- *Attribution in the bar*: the plate works, and moving a licensing obligation
  is a change of its own.

**Revisit if** navigating to a known place becomes a task again (a search box,
a tour, a tree lookup). `flyTo` is already waiting for it.

---

## 2026-09-29 — Derived layers go through a DAG; PET is derived from LPI on the GPU

*Partly superseded by 2026-09-29 — Each layer mounts itself; upstream state travels through the DAG.*

**Decision.** A small pure graph (`src/lib/dag`) carries one layer's output
to another's. The first edge is `sunlight.lpi` → `temperature.pet`:
- **Pushing results.** When a node publishes, everything downstream of it
  is notified.
- **Pulling demand.** Demand flows the other way: a shown PET overlay makes
  the direct-sun layer compute even with its own overlay hidden.
- **Ownership.** The engine owns the one graph per map and adds the nodes.
  Layers never reference each other.

PET is affine in LPI, so the temperature layer runs **no pass and keeps no
texture of its own**:
- It samples the sunlight layer's render targets in its overlay shader,
  wrapped in `THREE.ExternalTexture`.
- `G0`, `Ta` and `V` are three uniforms.
- Probe and export go back through the sunlight layer's own readback, with a
  per-value transform.

**Also decided.** MapLibre skips `prerender` for a hidden layer. So a derived
layer's record is visible while its node is demanded. The overlay's drawn
visibility is set on the layer by `useMapEngine` before each sync, and the
paint bridge's `setVisibility` is a no-op for these two layers. Found in the
browser: routing visibility through the bridge left PET "computing…" forever
with Direct sun off. The PET colour scale is fixed (22–46 °C on the Taiwan
PET classes), not stretched to the current range.

**Rejected.**
- *The engine calls the temperature layer when the sunlight one finishes*:
  works for one edge, and needs new wiring for every derived layer after it.
- *A PET render target*: another 80 MB of GPU memory, for a value one
  multiply-add away from the LPI already there.
- *Reading LPI back to the CPU*: a 4096² readback on every sun-slider move.
- *Keeping the sunlight layer always visible to MapLibre*: a hidden,
  undemanded layer would keep running its `prerender`.

**Revisit if** a derived quantity stops being a per-texel function of its
inputs (a blur, a neighbourhood statistic, a time integral). That needs a
render target and a pass of its own, and a node that publishes a texture it
owns.

---

## 2026-09-24 — Building ambient occlusion is screen-space, from a redrawn G-buffer

**Problem.** MapLibre 6.10's `fill-extrusion` has no ambient-occlusion
property (that is Mapbox-only), and GeoLibre 3.0.0 exposes only the
`vertical-gradient` it hardcodes on. A custom layer cannot sample MapLibre's
depth buffer either, since the default framebuffer's depth is not a texture in
WebGL.

**Decision.** A new `ambient-occlusion` layer, a third three.js custom layer:
- It fetches the z14 building tiles itself, and redraws them into a
  half-resolution G-buffer (eye-relative position and normal, RGBA32F).
- It runs 16-sample hemisphere SSAO with a range check, then a 4 × 4
  depth-aware blur.
- It multiplies the result over the frame by **redrawing the prisms and a
  ground plane** with a polygon offset. The prisms test `LESS` and write depth,
  so a building repeated by the tile buffer darkens once. The ground never
  writes depth, so the direct-sun overlay still meets the ground's depth.
- It works from z14 up only. There MapLibre draws the same overzoomed z14
  tiles, so the redrawn prisms match the extrusions.
- It follows the display controls (exaggeration, min height, buildings
  hidden). It is decoration, not physics, unlike the direct-sun index.

**Also decided.** `TileStore`, the tile grid, the building triangulation and
the ground footprint moved from `sunlight/` into `src/lib/tiles/`, and the
store gained a per-source switch. Each layer keeps its own store instance: one
store has a single wanted set, so sharing would let one layer's plan cancel the
other's. The layer ships **on**.

**Rejected.**
- *Ground contact AO only* (a blurred footprint halo): cheap, but it cannot
  darken walls or inner corners.
- *Baked per-building AO* (one tone per building, from PostGIS): static, and
  it needs an infra pipeline.
- *A full-screen composite writing `gl_FragDepth`*: MapLibre gives 3D layers
  their own depth range, which `gl_FragDepth` bypasses.

**Revisit if** MapLibre gains a native extrusion AO, or exposes a sampleable
depth texture to custom layers. Either would remove the redraw. Revisit too if
the G-buffer's cost shows on low-end GPUs, where `AO_SCALE` is the knob.

---

## 2026-09-24 — The direct-sun overlay starts at z12, with a zoom-adaptive near grid

**Decision.** `SUNLIGHT_MIN_ZOOM` is 12. Below z15 the near grid is 4,096 m at
1 m cells, not 2,048 m at 0.5 m, in the same 4096² target. The footprint
**clips** distant canvas corners to the far grid instead of rejecting them.

**Why the grid adapts.** At z14 a flat view is ~4 km across and a pixel is
~4.3 m. A fixed 2 km near grid would leave three-quarters of the view on 8 m
cells, where small crowns vanish, with a seam at 2 km. At z12 (~17 m per
pixel) the 8 m far grid is finer than the screen, so no third level is needed.

**Why clip, not reject.** Rejecting corners beyond ±8 km is harmless at z16,
but at z12 every corner is ~11 km out. The footprint collapses to nothing and
84% of the view goes undrawn. Only the mirrored above-horizon points are
rejected.

**Measured**, per fresh page:

| view | tiles | trees | ready | download |
| --- | --- | --- | --- | --- |
| z12 flat | 81 | 154k | 3.8 s | 8.5 MB |
| z12 pitch 60 | 81 | 154k | 21 s | 13.5 MB |
| z14 flat | 9 | 62k | ~0.5 s | — |
| z14 pitch 60 | 35 | 141k | 0.8 s | 2.4 MB |

Rebuilds run 80–200 ms. Every ground point within ±8 km was covered at every
zoom tested.

The slow pitched z12 case is OpenFreeMap latency: single building tiles took up
to 5 s.

**What it rules out.** Below z12 a flat view outgrows the ±8 km far grid. A
pitched z12–13 view already shows the grid's square edge, and the ground beyond
it is not drawn. So the export stays the near grid, at most 4 km; a city-scale
GeoTIFF would be a batch job, not this overlay.

---

## 2026-09-24 — The direct-sun overlay fetches its own tiles, on two nested grids

**Problem.** Read from MapLibre's viewport tiles, much of the view is left
uncovered. At pitch 75 about 30% of the canvas lies outside a single 2 km grid.
At a 17° sun, 54% of even a flat view is hatched "incomplete", because the
occluders exist only in the viewport's tiles and a 150 m reach at 17° is 494 m.

**Decision.**
- **Two nested grids.** A far grid of 16 km at 8 m cells sits around the near
  grid.
- **The layer fetches its own z14 tiles.** It requests Martin's trees and
  OpenFreeMap's buildings for the visible footprint plus an 851 m margin on
  every side (the 150 m reach at the 10° minimum sun). It decodes them with
  `@mapbox/vector-tile` and caches 256 tiles per source.
- **Coverage is the set of fetched tiles**, drawn into a third channel of each
  target. Verified in the browser across pitch 0–85 and suns of 10–64°: every
  ground sample within ±8 km is covered, with none incomplete.

**Why not MapLibre's tiles, like the tree mesh.** Reading them back keeps the
app free of its own network code, and for this layer it makes correctness
impossible. The tree mesh keeps that design, because it only ever draws what is
in view.

**Costs, measured.**
- 160 MB of GPU memory for two targets.
- A 10 ms pass for both levels.
- A rebuild of ~30–40 ms per view change once tiles are cached. Buildings are
  triangulated once per tile, and without that it is ~110 ms.
- On first sight, 9–15 z14 tiles per source.

**Found on the way.** Above the horizon MapLibre's `unproject` returns a
mirrored point *behind* the camera rather than failing, which sent the fetch
plan south of a north-facing view. A ground point is accepted only if it
projects back onto its own pixel.

**What it rules out.** The overlay stops at ±8 km. Its far ground is 8 m cells,
where a small crown can be sub-cell and cast nothing. Export is the near grid
only. Revisit if a far-horizon analysis is ever wanted.

---

## 2026-09-24 — Direct sun is accumulated optical depth, drawn straight into a ground grid

**Decision.** The sunlight layer computes, per ground cell, `exp(−Σ τ)` over
every occluder the sun ray crosses (τ = −ln α). It does **not** use a shadow
map. One GPU pass shears every occluder vertex along the sun onto the ground and
rasterises it additively into a north-up half-float grid. Crowns are each
form's canopy hull, instanced; buildings are prisms at τ = 1000. Everything is
drawn double-sided at τ / 2.

**Why not a shadow map.** A depth map keeps only the nearest occluder, so it
answers "lit or not" and cannot multiply: two α = 0.5 crowns would read 0.5, not
0.25. Accumulating τ is the product, without 8-bit quantisation.

**Why a ground grid, not the light's view.** In the sun's own view a ground cell
stretches by 1/sin(el) along the azimuth — 5.8× at 10°. The shear writes
straight into a north-up grid, so every cell is the same size whatever the sun,
and the overlay and the export sample it without resampling.

**Why double-sided at τ / 2.** Every ray crosses a closed surface an even
number of times, so a convex crown contributes exactly τ with no assumption
about face winding under a shear and a mirrored Mercator axis.

**Why each form's canopy hull.** A crown is the convex hull of its form's
procedural canopy (`canopyHullOf(form)`, from the tree layer), normalised to
height 1, scaled by the surveyed height and yawed by the tree layer's own
`rotationOf(tree_id)`. So the shadow has the drawn crown's outline and faces
its way. It is a hull, not the canopy itself, because τ / 2 per crossing is
"once per tree" only for a closed convex volume. The canopy is overlapping
blobs and stacked cones, so drawn as-is it would count one tree two or more
times where they overlap, a darker core under a lone tree. The hull keeps the
outline and loses only the gaps between blobs and fronds, which α already
stands for. A symmetric proxy (an ellipsoid in the canopy's bounding box) was
considered: right in size, wrong in outline, and unable to face the way the
tree does. At 20–76 triangles a hull is also cheaper than a smooth ellipsoid.

**Checked.**
- **Unit tests:** every form's hull is closed, convex, contains every canopy
  vertex and fits the unit height, and a hull instance lands exactly where the
  tree layer's matrix puts the tree.
- **In the browser:** every probed lone-crown point reads 0.500 and every
  two-crown point 0.250. Around lone trees every sample reads 1, 0.5 or 0
  (buildings); the only 0.25s were all explained by a neighbouring 75 m "tree",
  one of the inventory's keyed heights. The two-level pass measured 4–9 ms.

**It ignores every display control.** Exaggeration, the kind filter, the mesh
source and layer visibility do not change a value. The glTF models' leaf
textures play no part either, because α already carries all of a crown's
porosity; letting the textures cast shade as well would count it twice.

**What it rules out.** Diffuse sky, terrain, path length through a crown, and
leaf-off (all in the spec's *Out of scope*). Concave crowns and frond gaps
casting their own shade, and modelled (glTF) trees casting their own shapes: a
shadow is always the form's procedural hull. An exact-silhouette variant (one
fragment per tree per texel, through a per-instance depth and a `NOTEQUAL`
test) would lift that, at the cost of a depth buffer per level. It also rules
out syncing the decorative tree and extrusion lights to the sun time; that is a
separate change to the tree layer. The α values are placeholders (0.5
everywhere) until real ones are supplied.

---

## 2026-09-24 — Cards state figures as stat lines, not prose

**Decision.** The Trees card's closing paragraph is gone. The number it carried
is now a `StatLine` — **Surveyed trees · 162,930** — at the head of the card's
readout block, from a new `TREES_TOTAL` in `src/layers/tree/constants.ts`.

**Why.** The paragraph buried a figure in four lines of prose, and its other two
claims (height comes from the survey; the mesh source changes a tree's look, not
its place or height) are properties of the layer that the spec already states.
The panel is an instrument: what it knows about the data it should say the way
the Camera card says latitude.

**Why the constant sits with the source contract.** `TREES_TOTAL` is a fact
about what `infra/` loaded, alongside the bounds and the zoom range, not about
what the layer draws. It counts the street and park open data only — `infra/`
decides how many custom rows exist and never tells the app — so the label says
*surveyed*.

**What it rules out.** The count is not live. It does not follow the kind
filter, and it is not the number of trees in view, which moves with the
viewport and with which tiles happen to be loaded. An in-view count would need
the mesh layer to report upward the way `modelStatus` does; that is the change
to make if the question ever becomes "how many am I looking at" rather than "how
big is this dataset". Revisit when `infra/` loads a newer extract — the figure
is then stale, and a stale figure stated confidently is worse than the
paragraph was.

---

## 2026-09-24 — Paper is the default basemap, and buildings are always flat

**Decision.** `BASEMAPS[0]` is now `positron` ("Paper"), so the app opens on a
pale ground, and `DEFAULT_BUILDING_SETTINGS.flatColor` moves with it to
`#d6d3cd`. The colour-ramp panel is removed: `paletteId` defaults to `null` and
nothing in the UI ever sets it, so every building is painted one flat colour.

**The ramp code stays.** `PALETTES`, `colorExpression` and the `paletteId`
branch of `buildingsLayer()` remain in the layer, specified and covered by
tests. What was removed is the control, not the capability.

**Why.** Two of the three ramps were tuned for a dark ground, and on Paper a
height ramp fights the basemap instead of reading against it. The ramp also
competed with the trees: with 162,930 trees drawing their own colours, a second
data colour over the buildings made the view harder to read, not richer. Flat
buildings in the basemap's own `buildingColor` give the trees the foreground and
keep the extrusions as shape rather than as a second chart.

**What it rules out.** There is no way to colour a building by height from the
interface, and no legend. Height is still readable — through extrusion itself,
the height-exaggeration slider and the minimum-height filter — but not as
colour. It also rules out the swatch-carrying variant of the segmented control
having any live use; the prop stays on the primitive.

**What would make us revisit.** A question that only colour can answer over the
building stock — age, use, a survey value — or a ramp designed for a light
ground. The layer is ready for it: set `paletteId` and the expression compiles.
Bringing the panel back means a spec change first, as this one had.

---

## 2026-09-23 — Modelled trees draw a numbered ladder of detail levels

**Decision.** A modelled form is a **ladder** of geometries numbered from 0.
Level 0 is the authored model at the plain name; every rung above it is a
decimated copy named for its number — `oak_tree.glb`, `oak_tree.L1.glb`,
`oak_tree.L2.glb` and so on. Rungs are built by `gltf-transform`
(meshoptimizer) at `--ratio 0.1 --error 0.15` with 128 px textures instead of
512. A tree draws the **lowest-numbered rung whose reach covers its distance
from the camera**; the last rung has no reach and catches everything beyond.
Today the ladder is two rungs, with level 0 reaching 300 m.

The ladder is **data**: `MODEL_LODS` in `models.ts` holds how far each rung
reaches, `LEVELS` in the prep script holds how each is built. Adding an L2 is a
row in each and no code change — nothing in the layer names a level, it indexes
one. The procedural source keeps its single level; it is ~130 triangles a tree
already.

**Why.** Instancing was working and was never the bottleneck. Measured over
Da'an, the modelled source drew 11,607 trees in **22 draw calls** and **95.2
million triangles a frame**, which took the map from 120 fps to 13. One mesh was
61% of it — oak_tree's canopy, 7,340 triangles against 7,866 instances, because
`spreading` is 46% of the inventory. These are hero assets, authored to look
right as one tree and carrying no LOD of their own. The earlier prep step
downscaled textures and never touched geometry, so the triangle load arrived
untouched.

With the ladder in place the same view draws **11.5 M triangles at 10.5 ms —
95 fps** (median of three fresh-page trials; a single reading of this is not
worth much, as one early one-off came back 40% slower and did not reproduce).

**What it rules out.**

- **The cheap distance metric is wrong and is not used.** Instance positions are
  already metres from the anchor, so `x² + z²` is free — and the anchor is the
  *viewport centre*. At this map's pitch the trees nearest the eye sit well in
  front of it, and they are the largest things on screen; ranking by anchor
  distance would hand them the decimated mesh and keep full geometry for the
  specks on the horizon. The camera's real position is derived instead, from
  public camera state (`getVerticalFieldOfView`, `getZoom`, `getPitch`,
  `getBearing`, canvas height) — **not** from `transform.cameraPosition`, which
  is `@internal`, nor `getFreeCameraOptions`, which MapLibre v6 removed. The
  derivation was cross-checked against MapLibre's own `cameraToCenterDistance`
  and matched exactly (1371 px).
- **Numbered levels, not `near` and `far`.** A two-value name is a two-value
  ceiling — in the file name and in the type behind it alike — and the next
  tier this map wants is the one it does not have yet. Renaming only the file
  would have left the ceiling one layer in, for whoever adds the third rung to
  unpick. The cost of avoiding it is an integer.
- **The whole ladder shares one `baseHeightM`, measured from level 0.**
  Decimation moves a bounding box slightly, so a rung measured on its own
  stands a fraction of a percent shorter and every tree would twitch as it
  crossed a threshold. `matchHeight` scales each rung to level 0's height at
  load. Invariant 19.
- **`weld` before `simplify` is load-bearing.** Sketchfab exports carry split
  vertices and meshoptimizer will not collapse an edge across one. Unwelded,
  oak_tree's leaves obeyed the ratio (7,340 → 673) while its trunk did not move
  at all — 1,024 before and after, at every ratio tried. Welded, the same
  command reaches the target on every primitive: 8,364 → 775, a 10.8× cut.
- **Three models are topology-limited and stay that way.** `beech_tree` 4.1×,
  `spruce` 6.5×, `date_palm` 2.2× — identical at `--error` 0.15, 0.3 and 0.6,
  with `--lock-border false` already the default. Their foliage is disconnected
  cards. The error bound was not raised on the strength of looking like it might
  help.
- **Level 0 draws very few trees, and widening its reach changes that
  slowly.** At the shipped 300 m: 34 of 11,607 trees at z17.2/pitch 65, 151 of
  9,293 at z20/pitch 70. At 150 m it was 0 and 31 — so tripling the reach bought
  34 and 151 trees and cost 1% and 6% of frame time (10.4 → 10.5 ms and
  8.3 → 8.8 ms). The frustum is deep and most of what is in it is far, so reach
  buys detail slowly and costs slowly; the number is a comfortable choice rather
  than a knife edge. It does still mean 6.3 MB of level-0 models exist to draw a
  couple of hundred trees at a time.
- **A build-time dependency on `@gltf-transform/cli`**, shelled out to from a
  Python script. Mixed, and deliberately outside `npm run build`: the input
  changes about never, and the alternative is a mesh toolchain in every
  `npm install`.

**What would make us revisit.** Models authored with their own LODs, which would
retire the decimation step. Or impostors — a billboard rung beyond a few hundred
metres would cut the remaining 11 M triangles by another order of magnitude, and
is now an `L2` row rather than a redesign, which is the point of numbering them.

---

## 2026-09-23 — Each tree's rotation is hashed from its `tree_id`

**Decision.** Every instance is yawed about the vertical by an angle in
`[0, 2π)` returned by `rotationOf(treeId)` in `src/layers/tree/placement.ts` —
FNV-1a over the id's UTF-16 code units, then murmur3's `fmix32`, scaled to a
turn. The layer does not call `Math.random`, anywhere (invariant 18). Yaw only:
no pitch, no roll.

**Why.** Without rotation a street of 榕樹 is one mesh stamped forty times at
forty spacings, and the repetition reads as a rendering artefact rather than as
a row of trees. The angle has to be *stable* rather than merely varied, and for
a stronger reason than reproducibility across launches: the mesh refresh runs on
`idle`, so a drawn angle would make every tree in view visibly spin while
panning.

`tree_id` is the seed because it is already the layer's answer to *which tree is
this* — instances are deduped by it, and it is published as a tile property for
that reason. It also makes the angle a property of the tree rather than of the
geometry, which is what keeps a source switch from re-orienting the city;
invariant 13 was extended to say so.

**What it rules out.**

- **No `Math.random`, and no seeded-PRNG dependency either.** The arithmetic is
  written out because the *exact* constants are the contract: changing them is
  not a refactor, it reshuffles every tree in Taipei. `placement.test.ts` pins
  three angles to five decimal places to make that concrete rather than
  aspirational.
- **Plain FNV-1a was not good enough, and the reason is specific to this data.**
  The inventory's ids are sequential — `BT0015000001`, `BT0015000002`, … — and
  one street's trees carry consecutive ones. Two ids differing by 1 leave FNV-1a
  differing by exactly one multiple of the prime, 0.39% of a circle: measured on
  the real ids, consecutive trees came out **1.4° apart** (106.8°, 105.4°,
  104.0°, …). The hash meant to remove the repetition reintroduced it. Hence the
  `fmix32` finalizer, which took the mean gap between consecutive trees from
  16.6° to 96.7° (90° is what independent angles would give).
- **A uniformity test would not have caught that**, which is why the test suite
  does not rely on one. Plain FNV-1a already spread 20,000 ids evenly across
  eight octants; the defect was *local correlation* between neighbouring ids,
  invisible to a histogram. `placement.test.ts` therefore measures the angular
  gap between consecutive ids and asserts a floor on the mean.
- **Orientation is only as stable as `tree_id`.** If `infra` reloads and a row's
  id changes, that tree re-orients. Honest: the layer has been told it is a
  different tree.
- **No lean.** Pitch and roll are not modelled because the survey does not
  record them, and inventing one would be inventing data — the same rule that
  governs a `NULL` height.

**What would make us revisit.** A survey field that actually records orientation
or lean, which would replace the hash with data for the rows that have it. Or
per-form variation beyond yaw — a modest per-tree scale jitter is the obvious
next increment and would hash from the same id, but it fights the rule that a
tree's drawn height is its surveyed height, so it has not been taken.

---

## 2026-09-23 — A second mesh source: per-form glTF models, switchable

**Decision.** The mesh half can draw from **two** sources, chosen by
`TreeSettings.meshSource` and a two-segment control in the Trees panel. The
`"procedural"` source is the eight shapes `formGeometry.ts` builds and is the
default. The `"model"` source loads one authored glTF per form from
`public/models/trees/`. Seventeen CC BY 4.0 models by Sketchfab's `evolveduk`
are served; `FORM_MODELS` in `src/layers/tree/models.ts` names eight of them and
the other nine are a shelf for retuning the table.

**Why.** The entry below predicted this: form is the axis that turns a
per-species asset problem (471) into a per-form one (8), and at eight the swap
is cheap. It turned out cheap enough that it did not have to be a swap at all —
keeping both sources and letting the panel choose costs one setting and one
branch, and the comparison is worth more than either source alone. The
procedural source is also the one that survives a missing file, a clone without
Git LFS, and a first paint; making it the default means the app still fetches
nothing until someone asks it to.

**What it rules out, and what it reverses.**

- **"No glTF, no loader, no asset" is no longer true of the layer** — only of
  its default source. The entry below is superseded on that clause alone; its
  reasoning about *per-species* assets stands entirely, which is why the models
  are indexed by form and there are eight of them.
- **The "two shared materials" rule is gone**, replaced by a **material
  registry**. Sixteen procedural meshes could share one bark and one canopy
  material; eight models bring twenty-odd of their own, authored by someone
  else. So the constraint moved from *how many* materials exist to *where they
  are*: `setOpacity` iterates the registry, and a mesh drawn with a material not
  in it silently ignores GeoLibre's paint bridge. That failure looks like a
  rendering bug and is a contract bug, which is why it is now invariant 14.
- **The layer now fetches.** Opting into the modelled source makes `GLTFLoader`
  pull eight files. `DESIGN.md` and `STACK.md` are amended rather than quietly
  left wrong. Nothing was added to do it — `three` already ships the loader.
- **Three attribution obligations, one of them conditional.** The models are CC
  BY 4.0 and the credit shows only while they are drawing.
  `stylized_tropical_pack.glb` arrived with the set under the Sketchfab Standard
  License and is **deliberately absent**: that licence does not permit
  redistributing the model file, and `public/` is downloadable by definition. A
  test asserts every served `.glb` declares CC-BY, so re-adding it fails
  `npm test` rather than shipping.
- **Binary assets in the repo, through Git LFS**, and a manual Python prep step
  outside `npm`. The originals are 124 MB of uncompressed 1024² PNG textures;
  prepared they are 11.6 MB, of which a session loads 6.3 MB. A tree is tens of
  pixels wide at z16, so the discarded half of that resolution was never
  resolved.
- **`columnar` draws as bamboo**, and the entry below criticises this very
  library for shipping a bamboo model for an inventory with no bamboo in it.
  That criticism was about *taxonomy* and still holds — nothing here claims
  Taipei has bamboo. It is the asset-side application of the rule that already
  governs the class names: a form is a silhouette, and bamboo is the only
  candidate in the set that is narrow with foliage to the ground, which is what
  福木 and 龍柏 look like from across a street. Two other rows are approximate
  for the same reason and the spec names all three.

**What would make us revisit.** A set of models that actually matches a
subtropical East Asian inventory — at which point the contested rows
(`palm-fan` served by a feather palm, `tiered` served by a flat umbrella) get
replaced and `FORM_MODELS` changes with no spec change, because the table is
data. Or evidence that nobody uses the toggle, in which case one source should
win outright rather than both being carried.

---

## 2026-09-23 — Trees are drawn by silhouette, not by species

> **Superseded in part** by the entry above: the builders are no longer the
> layer's only mesh source. Everything here about *per-species* assets, and
> about naming classes for shape rather than taxon, stands.

**Decision.** The mesh half draws one of **eight** shapes instead of one. Seven
are named for a silhouette — `spreading`, `upright`, `tiered`, `columnar`,
`conic`, `palm-feather`, `palm-fan` — and the eighth, `generic`, is the shape
the layer drew before. A hand-written table of 100 species in
`src/layers/tree/forms.ts` maps species → form and covers 95.02% of the 162,930
surveyed trees; everything else, including every unrecognised custom drop-in,
draws `generic`. The builders stay procedural: no glTF, no loader, no asset.

**Why.** Per-species geometry was the spec's stated extension point and is not
reachable: the inventory names 471 species, and the model library that prompted
this (Sketchfab's `evolveduk`, 33 stylised models) is temperate-European and
desert-tropical against a subtropical East Asian inventory. Cross-checked, it
offers an exact genus match for 3.5% of the trees and a defensible stand-in for
another 28%, and has no counterpart at all for 茄苳, 樟樹, 臺灣欒樹, 黑板樹 or
白千層 — five species that are a quarter of Taipei's canopy between them. It
also contains a "bamboo" model for an inventory with no bamboo in it: 竹柏 is a
podocarp and 竹蕉 is a *Dracaena*.

Form is the axis that makes the problem finite. It is also what makes the glTF
swap tractable *later* — eight assets rather than 471 — so this is the cheap
step that does not foreclose the expensive one.

The classes are named for shape and never for a taxon, because the data punishes
taxonomic naming: 福木 is a broadleaf that is `columnar`, 竹柏 and 羅漢松 are
podocarps that are also `columnar`, and 楓香 sits in `upright` beside 青楓
without being an *Acer*. A class called `cypress` would have to lie about three
of those.

**What it rules out.** `spreading` and `upright` are 75% of the inventory, so
the map's character is still set by two shapes; this buys the silhouettes that
read as Taipei, not botanical accuracy. The table is a judgement, not a
derivation — a wrong row is a wrong shape on the map and an error nowhere else,
and three assignments are contested in the spec by name (楓香, 木棉, 阿勃勒).
Species keys are matched exactly, with no normalisation, so a supplier whose CSV
spells 臺灣欒樹 with 台 gets `generic` silently. Sixteen `InstancedMesh`es now
exist where two did, which is why they are allocated lazily and grown by
doubling rather than each being sized for `MAX_INSTANCES`; the cull stays global
and runs *before* the split by form, or a palm-lined street would evict the
banyans behind it.

`TREE_BASE_HEIGHT_M` is gone with it. Each form's base height is measured from
its built geometry, which incidentally fixed a silent error: the constant said
13 m for a mesh that stood 12.23 m, so every tree in the city had been drawing
about 6% short of its surveyed height.

**Revisit when.** A model library exists that actually covers subtropical East
Asian street trees, or the 1,500 trees of a single dominant species in one
district justify modelling that species alone. Splitting `spreading` — a vase
榔榆 against a dense 芒果 — is available without revisiting any of this.

---

## 2026-09-23 — `vitest` is the test runner

**Decision.** `vitest` is a dev dependency, `npm test` runs it, and tests live
beside the code as `<module>.test.ts` inside the layer folder. No jsdom, no
browser mode, no headless GL.

**Why.** The repo has asked for a test with every change since it started, and
had nowhere to put one; the form classes are the first change where the
untestable excuse ran out, because a species → silhouette table is pure data and
a geometry builder is a pure function of no inputs. `vitest` costs nothing here:
it reuses the existing Vite config and TypeScript setup, and `tsc -b` already
covers the test files because `tsconfig.json` includes all of `src`.

Restricting it to what is pure is the point rather than a limitation. The tests
that matter assert the things a reader cannot check by looking — that the
silhouette classes actually have the silhouettes they promise (`spreading` is
wider than tall, `tiered` leaves real gaps, the palms have bare trunks), and
that each form's declared height is the height its geometry actually has.

**What it rules out.** Nothing in `treeLayer.ts` itself is covered: the GL
context, the `querySourceFeatures` read-back, the paint bridge, the projection
matrix and the style-load cycle remain browser-verified, and `npm test` passing
says nothing about them. Adding jsdom or a headless GL harness to reach them is
a separate decision, and a much larger one — it would make the runner something
the project maintains rather than something it uses.

**Revisit when.** A bug lands in the instancing or the refresh path that a unit
test could have caught. That is the evidence that would justify the harness this
decision declines.

---

## 2026-09-23 — Neither surveyed measurement has an upper bound

**Decision.** `trees.height_m` and `trees.diameter_cm` are kept whenever they
are positive. The `(0, 40]` and `(0, 400]` ranges that `01_schema.sql` enforced
and `02_load.sql` applied are gone; only a zero or negative value still becomes
`NULL`. This supersedes the cleaning rules introduced with the tree layer.

**Why.** The 40 m cut was calibrated on the two values that are obviously junk —
2023.0 in the street file, a survey year typed into the height field, and 797.0
in the park file — but it could not tell those apart from a genuinely tall tree,
so it took 22 rows with them. Discarding a real height is the more expensive
error: a `NULL` renders as the 9.1 m median and reads as ordinary, whereas an
absurd spike reads as bad data at a glance and points at the row that needs
fixing upstream. The threshold also could not survive contact with drop-in data,
where the plausible range is whatever the supplier's trees happen to be.

Diameter's ceiling was the same bet at a twentieth of the stakes: it discarded
two rows, the park file's 468.8 and 2637.0, and a 26 m-wide trunk announces
itself without a constraint's help. Its `> 0` floor was kept, and is the reason
this is a decision about ceilings rather than about cleaning: 9,319 rows record
a diameter of exactly `0`, which is a blank field, and admitting those would
change what the column means rather than merely widening it.

**What it rules out.** The map now draws a 2,023 m and a 797 m tree, and the
mesh half keeps the **tallest** instances when it exceeds `MAX_INSTANCES`, so
those two are the rows least likely to be culled — they are permanent fixtures
of any view that contains them. Anything wanting a bounded height range (a
colour ramp keyed to height, a height histogram, an auto-fitted camera) must
clamp for itself rather than trusting the column. Rows with a `NULL` height fall
from 78 to 56; rows with a `NULL` diameter from 9,321 to 9,319.

**Revisit when.** Per-row provenance exists — a way to say *this* value is a
keying error without also indicting every tall tree. A confidence column, or a
correction file under `data/custom/`, would let the junk be nulled by name
instead of by threshold, which is the thing a threshold was standing in for.

---

## 2026-09-23 — Custom tree data is a third `kind`, not a second source

**Decision.** Trees that are not the city's open data — anything dropped into
`infra/data/custom/` as `TreeID,TreeType,Diameter,TreeHeight,LAT,LON` — load
into the same `trees` table with `kind = 'custom'`, and reach the app through
the same Martin source, the same tile URL and the same properties. The app gains
one union member, one colour and one segment in the Tree kind control. It gains
no second source, no second GeoLibre record and no code path of its own.

**Why.** A custom tree is the same object as a surveyed one: a point with a
species, a height and a diameter. The parts of the layer that are hard — one
source feeding two renderers, dedup by `tree_id`, the paint bridge, the bounds
and zoom floor — are indifferent to where a row came from, and duplicating them
for a second source would double the surface while changing nothing on screen.
`kind` already existed as the discriminator for exactly this reason.

**What it rules out.** Custom rows carry no district, place or survey date —
the drop-in schema has no columns for them — so `district` lost its `NOT NULL`
and a NULL district is now how a custom row is recognised. Per-dataset styling,
per-dataset visibility and per-dataset attribution are all out of reach without
revisiting this: there is one `custom` bucket, not one bucket per file.

Two couplings are accepted rather than solved. `TREES_BOUNDS` is still a
hand-measured constant, so custom trees outside it render nothing until it is
widened — `infra`'s load prints the extent per kind so the cause is visible.
And `TreeKindFilter` in `index.ts` is still mirrored by `TreeKind` in
`treeLayer.ts`, so a fourth kind means editing both.

**Revisit when.** A drop-in needs its own colour, its own toggle or its own
attribution line — at that point `kind` is being asked to carry dataset
identity, which it cannot, and the right move is a `source` column with the
filter driven from the loaded values rather than from a hardcoded union.

---

## 2026-09-22 — Tree data from local PostGIS + Martin, read back from MapLibre's own tiles

**Decision.** Taipei's 162,930-tree inventory is loaded into PostGIS and served
as vector tiles by Martin (`infra/`). The tree layer consumes it as **two**
GeoLibre records from **one** source: `tree-points`, an ordinary `vector-tiles`
record drawing circles city-wide from z14, and `tree-mesh`, the existing
external-native three.js record drawing instanced geometry in the viewport from
z16. The mesh half fetches nothing — it reads the tiles MapLibre already parsed,
via `querySourceFeatures`.

**Why.** 163k trees cannot all be three.js meshes, and circles alone waste the
surveyed heights. Two renderers over one source means the views cannot disagree,
and — the point that decided it — the app still makes **no `fetch()` of its
own**: no async state, no loading or error paths, no CORS surface beyond the tile
URL, despite now having a backend.

**What it rules out.** The app does not talk to Postgres, does not hold a second
endpoint, and does not gain a data-fetching layer. `source.tiles` is used rather
than Martin's TileJSON, whose tile URL is absolute and would bypass the Vite
proxy. And the two records are **not** independent: hiding `tree-points` would
starve the mesh layer of data, so it stays visible at zero opacity instead. That
coupling is the price of the design and is recorded as an invariant in the spec.

**What it reverses.** The tree layer was a single procedural tree at a hardcoded
coordinate, deterministic across reloads. The mesh *shape* is still
deterministic; the *scene* is not — it depends on the viewport. `TREE_LOCATION`
is retired and `TreeSettings.height` (absolute metres) becomes `heightScale`,
because an absolute height is meaningless once every tree carries its own.

**Revisit when.** The inventory needs per-species geometry (glTF), or a second
dataset wants the same treatment and the points/mesh pairing is worth extracting
into something reusable. Also if Martin ever has to be reachable from anywhere
but a developer's machine — none of this considers auth, caching or uptime.

## 2026-09-22 — Split the repo into `app/` and `infra/`

**Decision.** The Vite app moves from the repo root into `app/`, taking its
`ai/` documentation set with it, and a sibling `infra/` holds the local data
stack and the raw open-data extracts it loads. `CLAUDE.md` splits in two: the
root file carries the rules that govern every package (spec first and approved,
no spec/code drift, tests, docs current), `app/CLAUDE.md` carries the
layer-specific mechanics. The root `README.md` stays at the root and describes
both.

**Why.** The app is about to consume data from a PostGIS + Martin stack we run
ourselves. That stack is not a dependency of the app in any npm sense and must
not become one — but it does need a home, a schema, a loader and its own
documentation. Leaving the app at the root would have forced the backend to
either live inside the frontend package or float in an unnamed sibling
directory. Naming both packages makes the boundary explicit.

**What it rules out.** No workspaces and no root `package.json`:
`app/package.json` remains the only one, and every npm command is run after
`cd app`. `app/` must never import from `infra/` — it reaches the data over HTTP
like any other tile source, so the app still runs, minus those layers, with
nothing else running. This is what keeps `infra/` optional rather than required.

**What did not change.** No behaviour, and no build configuration.
`tsconfig.json` includes only `["src", "vite.config.ts"]` and `vite.config.ts`
holds no paths, so the move was six `git mv`s and nothing else. The three
load-bearing MapLibre worker settings are untouched.

**Revisit when.** A second frontend appears, or `infra/` grows something the app
genuinely needs to import (generated types from the schema would be the likely
trigger). At that point workspaces stop being overhead and start paying for
themselves.

## 2026-09-22 — Adopt the slate/blue desktop-tool visual language

**Decision.** Replace the app's visual system with the one described in
`new_visual_design.md`: a neutral slate palette on a `#14161a` ground, **one**
blue accent (`#2c66c9`), flat opaque cards on a 4/6/8/999 radius scale, the
system font stack with no web fonts, an 11/12/13/15px type scale, and a
three-column shell (36px top bar, 340px controls, viewport, 340px sidebar) in
place of chrome floating over a full-bleed map. Recorded in full in
[VISUAL_DESIGN.md](VISUAL_DESIGN.md).

**Why.** The app is a tool for judging a 3D scene, and the previous system — a
tinted instrument panel with a vignette, film grain, a 58px display wordmark and
staggered panel entrances — competed with the thing being judged. The new
language also brings a semantic discipline the old one had no room for: a
bright-on-dark badge pattern, a red/amber banner pair that distinguishes *empty*
from *incomplete*, and the rule that state is never carried by colour alone.

**What it reverses.**

1. **The chrome accent no longer tracks the basemap.** `--accent` was set per
   basemap so the interface re-tinted with the map. A single stable accent is
   what makes the semantic set mean anything (blue = active, green = fine, amber
   = not what it looks, red = broken), and the accent now holds structural roles
   — selection border, selected-row ground, checkmark column — that must survive
   a `setStyle()` teardown. The basemap's colour identity stays in the map, as
   `buildingColor`.
2. **Web fonts come out** of `index.html`; zh-TW now resolves through PingFang TC
   / Microsoft JhengHei in the system stack.
3. **Radius everywhere**, replacing a deliberately zero-radius interface.
4. **Opaque columns beside the map** rather than translucent panels over it —
   `backdrop-filter`, the vignette and the grain are removed, and decorative
   motion goes with them.

**Resolved with approval.** `accent` is **removed** from `Basemap`, from all four
catalogue entries and from the basemaps spec, which previously described it as
"the tint the custom chrome adopts, so the UI tracks the map". A basemap's colour
identity now reaches the app only as `buildingColor`.

**Status.** Landed. `src/styles.css` is rewritten, `src/App.tsx` restructured
into the three-column shell, `index.html` drops the web fonts, `ui/Panel.tsx`
carries the new primitives and `ui/LayerMenu.tsx` is new. Verified in a browser
at 1440px and 820px: layer sync live, the three.js tree still rendering and
correctly occluded after a full `setStyle()` teardown to another basemap.

**Outstanding.** The tree's hemisphere ground colour is the one thing the new
language condemns that this change did not fix — it alters rendered output, so it
needs a tree-spec amendment first. See `VISUAL_DESIGN.md`.

---

## 2026-09-22 — `ai/` docs live beside the specs, not inside them

**Decision.** Orientation documentation (`DESIGN`, `ARCHITECTURE`,
`CONVENTIONS`, `DECISIONS`, `WORKFLOWS`, `STACK`, `VISUAL_DESIGN`) lives in a
top-level `ai/` folder. Each layer's `specs/spec.md` remains the source of truth
for that layer's behaviour and is not duplicated here.

**Why.** The specs answer "what must this layer do"; they are the wrong place
for "why is the repo shaped like this" or "how do I run the thing". Mixing the
two makes the spec unreliable as a contract.

**Rules out.** Restating layer contracts in `ai/`. When the two disagree, the
spec wins and the `ai/` doc is the bug.

---

## 2026-09-22 — Every layer, plugin, or extension is a folder with a spec

**Decision.** `src/layers/<name>/` with a mandatory `specs/spec.md` and an
`index.ts` as the sole entry point. Adding a layer means adding a folder, never
a file in `src/lib`. `src/lib` is reserved for the shared engine (`useMapEngine`)
and its data (`viewpoints`).

**Why.** The app's whole subject is *layers*. Filing them as loose modules made
the boundary between "thing GeoLibre renders" and "app plumbing" invisible, and
left their contracts undocumented.

**Rules out.** Cross-folder deep imports. `buildings` may import
`../basemaps` (its `index.ts`) but not `../basemaps/something-internal`.

**Revisit when.** A layer grows a second consumer that needs internals — that is
a signal to promote the shared piece to `src/lib`, not to loosen the rule.

---

## 2026-09-22 — `basemaps` is an extension, not a layer

**Decision.** `basemaps` lives under `src/layers/` and carries a spec, but
produces no `GeoLibreLayer` record. It owns the MapLibre style the GeoLibre
layers are synced into and conditions it (`hideBasemapBuildings`,
`firstLabelLayerId`, `anchorUnderLabels`).

**Why.** It is the only module besides `useMapEngine` that legitimately touches
the map. Giving it a folder and a spec makes that exception explicit and
auditable rather than accidental.

**Constraint it carries.** Nothing in it may mutate a layer whose id starts with
`layer-` — that prefix is GeoLibre's.

---

## 2026-09-22 — The three.js tree rides in the same `sync()` call as the buildings

*Partly superseded by 2026-09-29 — Each layer mounts itself; upstream state travels through the DAG.*

**Decision.** The tree is a `GeoLibreLayer` record on GeoLibre's external-native
path (`metadata.customLayerType: "threejs"`, `nativeLayerIds`,
`paintMode: "plugin"`), synced as `sync([buildings, tree])`. Visibility and
opacity reach three.js through `setExternalNativePaintBridge`; height does not,
because height is not a GeoLibre concept.

**Why.** The alternative — adding the custom layer beside GeoLibre and managing
its stacking by hand — would have proved nothing. The point of the app is that a
foreign renderer can be a first-class member of the layer list.

**Rules out.** Calling `tree.setOpacity` / `setVisibility` from the UI directly.
Those two must go through the bridge.

**Cost.** `map.setStyle()` destroys custom layers and GeoLibre only *moves*
native layers that already exist, so the custom layer must be re-added on every
`style.load`. That is now an invariant of the engine.

---

## 2026-09-22 — `renderingMode: "3d"`, sharing MapLibre's depth buffer

**Decision.** The custom layer declares `renderingMode: "3d"` so the OSM
extrusions occlude the tree rather than the tree always drawing on top.

**Evidence.** From bearing 180°, the tree's visible area drops 93% with
buildings on versus off. Losing that is a regression, not a style change.

**Cost.** Two rules follow from sharing one GL context: materials must be
`premultipliedAlpha: true` (MapLibre blends with `ONE, ONE_MINUS_SRC_ALPHA`), and
`renderer.resetState()` must run every frame with `autoClear = false`.

---

## 2026-09-22 — Project the tree with `defaultProjectionData.mainMatrix`

**Decision.** In `render(gl, options)`, use
`options.defaultProjectionData.mainMatrix` — the matrix taking unit Mercator
coordinates to clip space — and multiply it by a model matrix built from
`MercatorCoordinate`.

**Why it is worth an entry.** MapLibre v6 no longer passes the bare matrix that
every v2/v3-era three.js recipe destructures, and
`modelViewProjectionMatrix` is a *different world space*: using it puts the mesh
far outside the frustum **with no error of any kind**. The failure mode is a
silent blank map, so the wrong choice is easy to make twice.

---

## 2026-09-22 — Colour and the min-height filter read unexaggerated height

**Decision.** `heightScale` is applied only via
`style.extrusionHeightScale`. It must not appear in the colour expression or in
the filter, both of which read `["to-number", ["get", "render_height"], 0]`
directly.

**Why.** Exaggeration is a viewing aid. If it leaked into colour, the ramp would
lie about how tall a building is; if it leaked into the filter, "min height 30 m"
would mean something different at every exaggeration setting.

---

## 2026-09-22 — Buildings draw above the basemap labels by default

**Decision.** `createLayerSync` appends to the top of the stack and that is kept
as the default. The `labelsOnTop` setting opts into calling `anchorUnderLabels`
after each sync.

**Why.** Labels styled for a dark ground are unreadable over lit building faces.
The common case should look right without a control.

**Alternative rejected.** Asking GeoLibre for an insertion point — the sync API
does not offer one, and re-anchoring after the fact is honest about that.

---

## 2026-09-22 — One OSM snapshot for ground plane and extrusions

*Partly superseded by 2026-09-29 — Layers take their data sources as descriptors.*

**Decision.** `OSM_TILEJSON` (`https://tiles.openfreemap.org/planet`,
OpenMapTiles schema, no API key) is owned by `basemaps` and imported by
`buildings`. Attribution (`OSM_ATTRIBUTION`) travels with it.

**Why.** Basemap and buildings can then never disagree about where a building
is. A second source would also mean a second attribution obligation.

**Obligation.** MapLibre's `AttributionControl` is disabled
(`attributionControl: false`), so the app's status bar **must** render
`OSM_ATTRIBUTION`. Removing it is a licensing regression.

---

## 2026-09-22 — Two MapLibre worker settings, kept deliberately

**Decision.** Keep `optimizeDeps.exclude: ["maplibre-gl"]` and
`worker.format: "es"` in `vite.config.ts`, and set
`maplibreConfig.WORKER_URL` from `maplibre-gl-worker.mjs?worker&url` at module
scope in `useMapEngine.ts`. Also `resolve.dedupe` for `maplibre-gl`, `react`,
`react-dom`.

**Why.** MapLibre resolves its worker as a sibling of its own module URL. Vite's
pre-bundler rewrites the module into `.vite/deps` without copying the worker
(dev 404), and in a production build the dynamic path means Rollup emits no
worker asset at all. Either way: no tile is ever parsed, and the map is a black
rectangle with a clean console. `dedupe` guarantees GeoLibre's sync and the map
instance come from the same copy of the library.

**Revisit when.** MapLibre ships a worker resolution that survives bundling.
Until then, treat these three lines as load-bearing.

---

## 2026-09-22 — Headless GeoLibre, hand-built chrome

**Decision.** Depend on `@geolibre/map` + `@geolibre/core` only. No React
bindings, no Zustand store, no Cesium, no GeoLibre controls, and no MapLibre
`NavigationControl`. The entire interface is hand-written against
`src/styles.css`, with no component library.

**Why.** The claim being demonstrated is that the engine is usable headlessly.
Bundled chrome would blur it, and a UI kit would make the app about the kit.

**Cost.** Panel, Slider, CheckboxRow, Segmented, the compass and the layer menu
are maintained by hand. Accepted.
