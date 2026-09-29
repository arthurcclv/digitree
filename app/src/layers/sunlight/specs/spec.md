# Sunlight layer — spec

Source of truth for the ground light-penetration overlay. Behaviour changes
here require this file to change first.

Modules: `src/layers/sunlight/` — `index.ts` (record, settings, exports),
`sunlightLayer.ts` (the custom layer), and
the pure modules `sun.ts`, `state.ts`, `transmittance.ts`, `frame.ts`,
`tileGrid.ts`, `geotiff.ts`. Its tile fetching, the z14 grid, the
per-tile building triangulation and the ground footprint live in
`src/lib/tiles/`, shared with the ambient-occlusion layer; this spec still
defines their behaviour (*Data*, *Coverage*, *Recompute*).

## Purpose

For each ground point in view, the fraction of **direct sunlight** reaching it
at **one moment**, after passing through tree crowns and past buildings. It is
drawn as a colour overlay on the ground, can be read at a clicked point, and
can be exported as a GeoTIFF. It recomputes live as the sun time changes.

The index is also called the **light penetration index (LPI)**. The layer
publishes it as the DAG node `sunlight.lpi` (see *The LPI node*), from which
the temperature layer derives PET.

## Definition

For a ground point `p` and the sun direction `s`, take the ray from `p` towards
the sun. Every occluder `i` it crosses has a transmittance `αᵢ ∈ [0, 1]`:

```
index(p) = ∏ αᵢ  =  exp(−Σ τᵢ),   τᵢ = −ln αᵢ
```

- `1` means full direct sun, and `0` means fully shaded.
- Two crowns of α = 0.5 on one ray give **0.25**. The computation therefore
  **accumulates optical depth** τ. It is not a depth-tested shadow map, which
  keeps only the nearest occluder and so cannot multiply.
- **Each occluder counts once per ray.** A crown is one closed volume, not a
  set of surfaces.
- **α carries all of a crown's porosity.** The crown volume has no gaps of its
  own, and neither drawn mesh source (generated or modelled) takes part.
- Ground is flat, at elevation 0.

### What the index is not

- **Not total light.** Diffuse skylight is excluded. Labels say
  "direct sun", never "light level" or "brightness".
- **Not a time integral.** It covers one sun position.
- **Not the drawn scene.** It ignores every display control:
  - Building and tree height exaggeration are not applied.
  - The tree kind filter and the minimum-height filter are not applied.
  - The layers' visibility makes no difference.
  - The mesh source makes no difference.

  The physics of a point does not change because a slider moved.

## Sun position

`sunPosition(time: Date, lng, lat) → { azimuthDeg, elevationDeg }` in
`sun.ts`. It implements the NOAA solar position algorithm (the spreadsheet
formulation, without refraction). Azimuth is measured clockwise from true
north. It is evaluated once per recompute, at the domain centre.

| constant | value | meaning |
| --- | --- | --- |
| `MIN_SUN_ELEVATION_DEG` | 5 | below this the layer computes nothing and reports `low-sun` |

At 5° a 100 m building casts a 1,143 m shadow. Below it the map is shade almost
everywhere, and the fetch margin (below) grows without bound.

## Occluders

### Trees

- **Source.** Every tree in the layer's own fetched tree tiles (see *Data*).
  Duplicates from the tile buffer are removed by `tree_id`.
- **No filtering.** Every `kind` is included, and the kind filter is ignored.
- **Height.** The surveyed `height_m`, or `TREE_FALLBACK_HEIGHT_M` (9.1 m) when
  missing. Always at true scale.
- **Cap.** At most `SUNLIGHT_MAX_TREES` = 200,000, keeping the tallest. That is
  more than the whole inventory (162,932), so in practice nothing is dropped.

The crown is the **convex hull of the form's procedural canopy**, placed
exactly as the tree layer places that tree:
- **Hull.** `canopyHullOf(form)` is exported by the tree layer. It is the
  convex hull of every vertex of the form's procedural canopy geometry,
  normalised to a tree of height 1 (divided by the form's `baseHeightM`), in
  the tree layer's Y-up frame. It is measured from the drawn geometry, never
  declared, so the shadow's outline and the drawn crown cannot disagree. It
  has 20–76 triangles per form.
- **Scale.** Uniform, by the tree's height `h`: the same `h / baseHeightM`
  scale the tree layer applies, at true scale (exaggeration ignored).
- **Yaw.** `rotationOf(tree_id)`, the tree layer's own hashed yaw, so a
  lopsided hull (a spreading crown's blobs, a palm's fronds) faces the way
  the drawn tree does. The tree layer's rotation about its +Y (up) axis is a
  rotation by the same angle about +Z in this layer's east-north-up frame.

A hull is closed and convex, which is what *Each occluder counts once per ray*
needs (see *The light pass*). The raw canopy is not: its overlapping blobs and
stacked cones would count one tree two or more times where they overlap.
What the hull gives up is the concavities between blobs and the gaps between
palm fronds. That is porosity, and α already carries all of it.

The shape comes from the **procedural** source whichever mesh source is drawn;
the glTF models' open leaf cards are not volumes.

The trunk is ignored.

### Buildings

- **Source.** Every feature in the layer's own fetched building tiles (source
  layer `building`) with `hide_3d` not true. These are the same tiles and
  features the extrusion layer draws at `minHeight` 0.
- **Height.** Each footprint is a prism from 0 to `render_height`, the same
  attribute the extrusion reads, at true scale.
- **Tile pieces.** Tile clipping splits a building into pieces, and the tile
  buffer repeats some of them. Neither matters: a building is opaque, and an
  opaque occluder counted twice is still opaque.
- **τ.** `BUILDING_TAU` = 1000. `exp(−1000)` is 0 in any float format.

## Data

**The layer fetches its own tiles.** MapLibre loads only what covers the
viewport, and at high pitch its distant tiles fall below the tree source's
z14 floor. That leaves no data for occluders just off-screen towards the sun,
nor for the far ground of a pitched view. So this layer requests the tiles it
needs itself, independently of what MapLibre has loaded and of whether the tree
and building layers are shown.

| source | URL | zoom | source layer |
| --- | --- | --- | --- |
| trees | `TREES_TILES` from the tree layer (`/tiles/trees/{z}/{x}/{y}`) | 14 | `trees` |
| buildings | the first `tiles` template in the TileJSON at `OSM_TILEJSON` (basemaps layer) | 14 | `building` |

- **Zoom.** Both are fetched at **z14**, one tile grid for both. That is the
  buildings source's maximum zoom. For trees, a point layer loses nothing at
  z14: every tree is in every zoom.
- **Decoding.** Tiles are decoded on the main thread with `@mapbox/vector-tile`
  and `pbf`, and converted to lng/lat with the decoder's own `toGeoJSON(x, y, z)`.
- **Tree tiles outside the inventory.** Tree tiles are requested only inside
  the inventory bounds (`TREES_BOUNDS`); outside them a tree tile is known
  empty and counts as fetched.
- **Cache.** Decoded tiles are kept in an in-memory LRU of `TILE_CACHE_SIZE` =
  256 tiles per source, for the session.
- **Concurrency.** At most `FETCH_CONCURRENCY` = 6 requests are in flight.
- **Failures.** A request that fails, or a TileJSON that cannot be read, leaves
  its tile **unfetched**. Unfetched tiles count as not covered (below), so
  their ground is left undrawn, never drawn as if empty. The panel reports the
  number of failed tiles.
- **Retries.** A failure is not cached. The next plan that wants a failed tile
  requests it again, and a TileJSON that could not be read is fetched again
  for the next building tile.

### Which tiles

The **wanted region** is the visible ground footprint (see *Coverage*) plus
the near domain, expanded on every side by the fetch margin, and clipped to
the far domain:

```
FETCH_MARGIN_M = SHADOW_REACH_M / tan(MIN_SUN_ELEVATION_DEG) ≈ 1,714 m
```

The margin surrounds the region in every direction, not just sunward. A new sun
time therefore never needs a new tile: any sun the layer will compute for has a
reach no longer than the margin. Every z14 tile intersecting the wanted
region's bounding box is fetched.

## Transmittance (α)

`transmittance.ts`:

- `FORM_ALPHA: Record<TreeForm, number>`, which must have a value for every
  form;
- `SPECIES_ALPHA: Record<string, number>` holds species overrides, keyed
  exactly like the tree layer's species table;
- `alphaOf(species) = SPECIES_ALPHA[species] ?? FORM_ALPHA[formOf(species)]`;
- `tauOf(α)`: `−ln α`, except that α = 0 gives `BUILDING_TAU`.

Every value must satisfy `0 ≤ α ≤ 1`, and a test enforces it.

**The shipped values are placeholders.** Every form is 0.5 and there are no
species overrides. They make the machinery testable; they are not a botanical
claim. Replacing them with measured values is a data change to this table,
reviewed like the species → form table.

## The domain

The overlay is computed on **square ground grids**. It is not computed in the
light's own view, so every cell is the same size on the ground whatever the sun
elevation. There are two grids, nested and centred on the same point:

| level | when | constant | side | cells per side | cell |
| --- | --- | --- | --- | --- | --- |
| near, fine | zoom ≥ `NEAR_FINE_MIN_ZOOM` (15) | `DOMAIN_M`, `GRID_SIZE` | 2,048 m | 4,096 | 0.5 m |
| near, wide | zoom < 15 | `WIDE_DOMAIN_M`, `GRID_SIZE` | 4,096 m | 4,096 | 1 m |
| far | always | `FAR_DOMAIN_M`, `FAR_GRID_SIZE` | 16,384 m | 2,048 | 8 m |

**The near grid follows the zoom.** At z14 a flat view is about 4 × 4 km,
about 4.3 m per screen pixel. A 2 km near grid would leave three-quarters of
it on the 8 m far grid, with a seam at its edge. So below z15 the near grid
doubles to 4 km at 1 m cells, which is still finer than a pixel there. It
covers the flat view, in the same 4096² target and so at no extra GPU memory.
From z15 up it is the 2 km, 0.5 m grid. `nearGridFor(zoom)` in `frame.ts`
makes the choice, at plan time. Crossing z15 is a new plan, and so a full
rebuild.

At a pitched view the far ground is several kilometres away. There one screen
pixel spans tens of metres along the view, so an 8 m cell is finer than what
it is drawn on. The far grid reaches the view's horizon out to ±8 km. Beyond
that, nothing is drawn.

- **Centre.** The map centre at recompute time, for both levels.
- **Frame.** A local frame in metres: `x` east, `y` north, `z` up, origin at
  the domain centre. It is placed on the map by translating to the centre's
  Mercator coordinate and scaling by `meterInMercatorCoordinateUnits`, with `y`
  negated.
- **Everything "near" means the current near grid**: its half-width is the
  near box in *Which tiles*, the extent the export covers, and the reach that
  decides which trees the near pass draws.
- **Small GPUs.** When `MAX_TEXTURE_SIZE` is smaller than a level's cell count,
  that grid shrinks to the maximum and its cell grows. The readout shows the
  near resolution actually used.
- **Which level.** A ground point uses the near grid when it lies inside it,
  and the far grid otherwise. This applies to the overlay, to the probe and to
  the completeness test.

### Coverage

**The visible ground footprint** is the convex quadrilateral made by
unprojecting the four canvas corners to the ground. A top corner is rejected,
and walks down its canvas edge in steps of 2% of the canvas height until it is
not, when its ground point:
- is not finite;
- or does not project back onto its own pixel, within 1 px (above the horizon,
  MapLibre's `unproject` returns a mirrored point behind the camera rather than
  failing).

A corner that is merely far is kept, and the footprint is clipped to the far
grid. At z12 a flat view's corners lie about 11 km from the centre, and
walking them down would shrink the footprint to nothing. The footprint decides only **which tiles to fetch**.

**Coverage** is the set of z14 tiles for which **both** sources have been
fetched: their union, as squares on the ground. Coverage is drawn into each
level's target (see *The light pass*), so it is a raster, not a polygon.

- A cell **outside** coverage has no value. That covers a tile still in
  flight, a tile that failed, and ground beyond the far grid.
- A cell inside coverage is **incomplete** when the point `SHADOW_REACH_M /
  tan(el)` metres from it, towards the sun, lies outside coverage.
  `SHADOW_REACH_M` = 150 m. Something taller than that, standing in an
  unfetched tile, could shade such a cell unseen. The test samples coverage at
  that point on whichever level holds it. The overlay draws incomplete cells
  hatched, the probe says "incomplete", and export writes them as NoData.
  Because the fetch margin already reaches that far in every direction, a
  cell is incomplete only next to a tile that is pending or failed, or at the
  edge of the far grid.
- A cell inside a building footprint is **roof**, not ground. It has no value
  and is written as NoData.

Every fetched occluder is placed, at both levels.

## Rendering

### The light pass

It runs in the custom layer's `prerender`, and only when the layer is marked
dirty (see *Recompute*). Each level has its own render target: RGBA
half-float, with no depth buffer, cleared to 0, and additive blending
(`ONE, ONE`). The two levels together hold 160 MB of GPU memory. The same
three draws go into each target, with that level's domain in the matrix:

1. **Occluders, into R.** Every vertex is projected along the sun ray onto the
   ground, `(x, y, z) → (x − z·k·uₓ, y − z·k·u_y)` with `u = (sin az, cos az)`
   and `k = 1 / tan el`, then mapped orthographically onto the domain. The shear
   turns each occluder into its shadow, drawn straight into the ground grid.
   - Crowns are instanced canopy hulls, one instanced mesh per form, with
     per-instance transform (position, yaw, scale) and τ. Both levels draw the
     same hulls: the near level for the trees in or near it, the far level for
     every tree.
   - Buildings are one merged mesh of prisms (floor, roof, walls) with
     τ = `BUILDING_TAU`.

   **Both are drawn double-sided and write τ / 2.** Every ray crosses a closed
   surface an even number of times, so a convex hull contributes exactly τ and
   no face-winding assumption is needed.
2. **Footprints, into G.** The building floors are drawn with `k = 0` (straight
   down), writing 1. G > 0.5 marks roof.
3. **Coverage, into B.** One square per covered z14 tile, straight down,
   writing 1. B > 0.5 marks covered ground.

### The overlay

A ground quad covering the far domain, in the same three.js scene placed on
the map. It is drawn in the translucent pass with `renderingMode: "3d"`. It tests
against MapLibre's depth buffer (so extrusions and tree meshes occlude it) and
never writes depth. For each fragment it:

1. samples the near target if the fragment is inside the near domain, else the
   far target;
2. discards roof, outside-coverage and outside-domain cells;
3. maps `index = exp(−R)` through the ramp (below);
4. hatches incomplete cells;
5. emits premultiplied colour at the layer's opacity.

### Ramp

| index | colour |
| --- | --- |
| 0 | `#2b2f6b` |
| 0.25 | `#5a4f9c` |
| 0.5 | `#a0679e` |
| 0.75 | `#e39a6d` |
| 1 | `#ffe3a1` |

Alpha is `opacity × (0.35 + 0.65 × (1 − index))`, so open sun is a light wash
and shade is solid. Incomplete cells are drawn grey `#8a8f98` with diagonal
hatching at half alpha, whatever their value.

### GL rules

It shares the rules of the tree layer's *Shared GL context*:
- the layer owns its own `WebGLRenderer` on MapLibre's context;
- `autoClear = false`;
- `resetState()` runs before and after each pass;
- `setRenderTarget(null)` runs after the light pass.

**Unsupported GPUs.** When the renderer lacks `EXT_color_buffer_float`, the
layer draws nothing and reports `unsupported`. It never falls back to an
8-bit target, which would quantise τ.

## Recompute

On `idle` (a moved view), and when the layer becomes visible, the layer plans
its tiles and requests the ones it lacks.

**Nothing is planned, fetched or rebuilt** while the layer is off (its node
is not demanded, see *The LPI node*), below
`SUNLIGHT_MIN_ZOOM`, or below `MIN_SUN_ELEVATION_DEG`. `blockedState` in
`state.ts` decides this before any work, in that order (with `unsupported`
after `off`). A plan put off this way runs as soon as nothing blocks it, for
example when a new sun time lifts the sun above the minimum.

The layer is dirty, and recomputes on the next frame, when:
- its node becomes demanded;
- the planned tiles change;
- a requested tile arrives or fails (arrivals are coalesced: at most one
  rebuild per `REBUILD_DEBOUNCE_MS` = 150 ms);
- the sun time changes (the light pass only; the geometry does not move);
- the layer becomes visible.

A rebuild decodes nothing: it gathers the features of the covered tiles from
the cache, rebuilds the crown instances and the building mesh, then runs the
light pass on both levels.

Each tile's buildings are **triangulated once**, in tile-relative units, and
kept with the decoded tile. A rebuild only scales and offsets those vertices
into the current frame. On a dense 9-tile view that is ~30–40 ms against ~110
ms triangulating afresh. The first sight of a tile still pays its
triangulation once. Results can appear tile by tile: until a tile has
arrived, its ground is outside coverage and is not drawn. While the map moves between recomputes, the
last result stays anchored to its own domain on the ground: it is still
correct where it is drawn.

Below `SUNLIGHT_MIN_ZOOM` = 12, or below `MIN_SUN_ELEVATION_DEG`, nothing is
drawn. The index does not depend on the tree meshes being drawn (they start at
z16), nor on MapLibre's tree source (from z14): the layer always fetches its
own z14 tiles, whatever the zoom. Its behaviour at the lowest zooms:
- **The view is most of the city.** At z12 a flat view is about 16 × 16 km,
  about 17 m per screen pixel. The wide near grid covers its middle 4 km, and
  the 8 m far grid, finer than a pixel there, covers the rest.
- **±8 km is the limit you meet.** A pitched view at z12–13 sees ground
  beyond the far grid, which is not drawn (*The domain*).
- **The data is the whole city.** A z12 view plans on the order of 60–80 z14
  tiles per source, all inside the 256-tile cache. The first sight fetches
  roughly 15–25 MB and triangulates about 100k building footprints once. From
  then on panning is served from the cache.

## Readouts, probe and export

`status()` returns:

| field | meaning |
| --- | --- |
| `state` | `off` (not demanded), `zoom`, `low-sun`, `unsupported`, `waiting` (no result yet) or `ready`; with the overlay hidden but demanded, the state is still reported, so the temperature layer can show it |
| `azimuthDeg`, `elevationDeg` | when `ready`, the sun used by the last recompute; otherwise the sun at the set time, so `low-sun` shows the sun that is actually set |
| `trees`, `buildings` | occluders in the last recompute (a building is one tile feature; OpenMapTiles merges equal-height footprints at z14, so one feature can be many footprints) |
| `cellM` | the near resolution actually used |
| `tiles` | `{ covered, pending, failed }`, in z14 tiles |
| `rebuildMs` | CPU time of the last recompute, feature read to draw submission |

`probe(lng, lat)` resolves, on the next frame, to one of:
- `{ kind: "value", index }`;
- `{ kind: "roof" | "incomplete" | "outside" | "none" }`.

It reads one texel back from the level that holds the point, as RGBA / FLOAT, the pair WebGL 2
guarantees for a float colour buffer. Probes and exports are queued and served
inside MapLibre's offscreen pass (`prerender`), never between its draws.

`exportGeoTiff()` returns a `Blob` holding an uncompressed, single-band
Float32 GeoTIFF of the whole **near** grid (the far grid is for display):
- in EPSG:3857, north up, with the Web Mercator pixel size equal to the ground
  cell size scaled by the Mercator scale at the domain centre;
- NoData is `-1`, written for roof, outside and incomplete cells;
- the GDAL metadata tag carries the sun time (ISO UTC), the azimuth, the
  elevation, the cell size, and a `definition` item naming the quantity
  (direct-sun transmittance) and pointing at this spec.

The pixels are read back in strips of 256 rows, so the whole grid is never held
twice at RGBA width. `geotiff.ts` is a hand-written writer with no dependency.
It writes only the tags listed in its header comment.

## The LPI node

The layer owns the DAG node `sunlight.lpi` (`src/lib/dag/specs/spec.md`), with
no deps.

- **Publish.** After every light pass that reaches `ready`, it publishes an
  `LpiField`:
  - `near`, `far`: each level's `WebGLTexture` (the render target's) and its
    `Domain`;
  - `covered`, `reach`, `sunTime`, `azimuthDeg`, `elevationDeg`: the `Result`
    fields;
  - `probe(lng, lat)`: this layer's `probe`, answering for this result;
  - `readNear(transform, nodata)`: this layer's export pipeline, returning the
    near grid as a GeoTIFF `Blob` with each value mapped through `transform`
    and non-complete cells written as `nodata`. `exportGeoTiff()` is
    `readNear(identity, -1)`.
- **Clear.** Whenever the state leaves `ready`, and on `dispose`.
- A target is resized only between a clear and the next publish, so a
  published `WebGLTexture` stays valid until the node is cleared or
  re-published.

**Demand.** Computing is gated on the node being **demanded**: the overlay is
visible, or a demanded dependent exists. The overlay is **drawn** only while
the layer's own visibility is on. So with the Direct sun overlay off and the
temperature overlay on, this layer plans, fetches and runs its light pass, but
draws nothing.

## The GeoLibre records

`sunlightRecord(settings)` follows the external-native pattern of the tree
mesh record:
- `id: "sunlight"`;
- `metadata.customLayerType: "threejs"`;
- `nativeLayerIds: ["threejs-sunlight-native"]`;
- `paintMode: "plugin"`;
- `source: {}`.

Opacity reaches the layer through `setExternalNativePaintBridge`. Visibility
does not:
- The record's `visible` is whether `sunlight.lpi` is **demanded**. MapLibre
  runs no `prerender` for a hidden layer, and the light pass lives there, so
  the layer must stay visible to MapLibre while a dependent wants the index,
  drawn or not. `sunlightRecord(settings, demanded)` takes it as an argument.
- Whether the overlay is **drawn** is `ThreeSunlightLayer.setVisibility`,
  which `useMapEngine` calls with `SunlightSettings.visible` before each
  sync. That call also sets the node's own demand, so the engine reads
  `demanded` after it.
- The bridge's `setVisibility` is a no-op.
The sync order is buildings → ambient occlusion → sunlight → temperature →
tree points → tree mesh, so the overlay sits above the extrusions' ground,
below the PET overlay, and below the circles.

## Settings

`SunlightSettings`, with `DEFAULT_SUNLIGHT_SETTINGS`:

| field | default | meaning |
| --- | --- | --- |
| `visible` | `false` | overlay on or off; when off and no dependent is demanded, nothing is fetched or computed |
| `opacity` | `0.8` | overlay opacity |
| `sunTime` | today, 12:00 Asia/Taipei | the moment, epoch ms |

The panel shows:
- a date field;
- a time-of-day slider from 05:00 to 19:00 Asia/Taipei in 15-minute steps;
- the opacity slider, from 10% to 100% (0% would be an overlay that is on but
  invisible, which the Overlay toggle already covers);
- readouts:
  - the set moment as local time (`HH:MM +08`);
  - sun azimuth and elevation;
  - the state when not `ready`;
  - while `waiting` or `ready`: the cell size, the occluder counts, the tiles
    (with pending and failed counts when not zero), and the last probe value.
    The probe value is cleared when the sun time changes or the overlay is
    switched, because it answered for a result that no longer stands;
- an **Export GeoTIFF** button, enabled only when `ready`.

Clicking the map while the layer is visible probes the clicked point.

## Invariants

The pure invariants (1–7, 12) are asserted by vitest. The GPU ones (8–11) are
checked in the browser.

1. `sunPosition` at the solar noon of the June solstice, at Taipei, gives an
   elevation of `90 − |φ − δ|` within 0.1°, and in December likewise. The
   azimuth at solar noon in December is 180° ± 0.5°, morning azimuths are
   east of south and afternoon ones west.
2. The occluder shear maps `(0, 0, h)` to `−h/tan(el) · u`, and maps any point
   with `z = 0` to itself.
3. `alphaOf` prefers a species override to the form default. `tauOf(0.5)` is
   `ln 2`, `tauOf(1)` is `0` and `tauOf(0)` is `BUILDING_TAU`. Every table
   value is in [0, 1].
4. `canopyHullOf(form)`, for every form:
   - is closed: every edge is shared by exactly two triangles;
   - is convex: every hull vertex lies on or behind every face's plane;
   - contains every vertex of the form's procedural canopy;
   - lies within [0, 1] of the tree height.

   A yawed hull instance matches the tree layer's instance matrix for the same
   tree, with the axes mapped from Y-up to Z-up.
5. Tile planning: the tiles planned for a footprint cover the footprint
   expanded by `FETCH_MARGIN_M` on every side, clipped to the far grid, and no
   tile outside that box plus one tile is planned. Coverage classification: a
   point whose tile and whose sunward reach are both covered is complete; one
   whose reach lands in an uncovered tile is incomplete; one in an uncovered
   tile is outside.
6. `nearGridFor(zoom)` gives the wide 4,096 m / 1 m grid below z15 and the
   fine 2,048 m / 0.5 m grid from z15, both 4,096 cells. Grid indexing and the
   lng/lat ↔ cell round trip agree to within one cell.
   The export geotransform places cell (0, 0)'s corner at the domain's
   north-west corner.
7. The GeoTIFF writer's output parses back with the right size, sample format,
   pixel scale, tie point, EPSG code and NoData.
8. In the browser, open ground reads `1.000`, and a point in a street under
   two overlapping crowns reads the product of their α. A point inside a lone
   tree's hull shadow reads exactly that tree's α, with no darker core. Once the planned tiles
   have arrived, every visible ground point within ±8 km of the centre is
   drawn, and none is hatched, at any pitch and at any sun from 5° up.
9. A tall building's shadow runs away from the sun, with length ≈
    `h / tan(el)`.
10. Changing a display control (exaggeration, kind filter, mesh source,
    hiding the buildings or the trees) leaves every probed value unchanged.
11. With the layer off and no demanded dependent, no tile is requested and no
    pass runs. With the overlay off and the temperature overlay on, tiles are
    fetched and passes run, and no direct-sun overlay is drawn.
12. Every pass that reaches `ready` publishes `sunlight.lpi` once; leaving
    `ready` clears it once (asserted by vitest on the state gate).

## Out of scope

- Terrain, and self-shadowing by hills.
- Diffuse sky.
- Path length through a crown (Beer–Lambert).
- Seasonal leaf-off.
- Daily sums.
- Aligning the tree rig's `DirectionalLight` and MapLibre's `setLight` with the
  computed sun. The drawn shading is decorative and still ignores the sun time;
  aligning it is a separate change to the tree layer and the engine.
