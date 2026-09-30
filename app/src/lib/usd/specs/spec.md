# USD export — spec

Source of truth for exporting the scene as OpenUSD: one `.usdz` package per
layer, and one root layer that references them. Behaviour changes here require
this file to change first.

Modules:
- `src/lib/usd/`: the shared writer, which knows no layer:
  - `usda.ts`: a text `.usda` serialiser;
  - `zip.ts`: the stored-zip writer, with CRC-32 and optional alignment;
  - `usdz.ts`: the `.usdz` packager, on `zip.ts`;
  - `frame.ts`: `ExportFrame`, the conversions into it, the tiles it touches;
  - `raster.ts`: a colourised grid as RGBA, and the PNG encoder;
  - `scene.ts`: `UsdPackage`, `UsdExportError`, the root layer and the
    outer zip;
  - `ground.ts`: the textured ground quad, and the raster package on it;
  - `fakePng.ts`: test support, the browser's PNG encoder stubbed;
  - `*.test.ts`.

  A package's tiles are fetched with `settle` from `src/lib/tiles`, which
  waits for a `TileStore` to settle over a set of tiles.
- One `usd.ts` in each participating layer folder, which builds that layer's
  package. A mount exposes it as `exportUsd(frame)`. The buildings and
  basemaps folders have no mount, so their `index.ts` exports a function
  (`exportBuildingsUsd`, `exportBasemapUsd`).
- `useMapEngine.ts` collects the packages and writes the root.
  `src/lib/sceneExport.ts` holds the host's two pure rules, which layers take
  part in what order and when the export is ready, shared by the host and
  `App.tsx`. `App.tsx` adds the button.

## Purpose

The map is a view. The same scene opened in a DCC or simulation tool
(usdview, Omniverse, Houdini, Blender) can be lit, rendered and edited there.
Each layer is its own file, so a consumer can swap, drop or re-export one
layer without touching the others. The root file is only composition.

The export is **what the app shows, at the moment of export**: the current
settings, sun time, mesh source and basemap. It is not a re-derivation from
the raw data. So it is produced in the browser, from the layers' own readings
(`treeOf`, `buildingHeight`, `rotationOf`, the ramps), and never duplicates
them.

## Output

One download: a plain zip named like the GeoTIFF exports, after the sun time
in UTC (`scene-2026-06-21T0400Z.zip`). It contains:

```
scene.usda              the root: composition and metadata only
basemap.usdz            ground plane, textured with the rendered basemap
buildings.usdz          one Mesh per building feature
trees.usdz              one PointInstancer and its prototypes
sunlight.usdz           ground plane, textured with the direct-sun ramp
sunlight.tif            the direct-sun values (the existing GeoTIFF export)
temperature.usdz        ground plane, textured with the PET ramp
temperature.tif         the PET values (the existing GeoTIFF export)
light.usdz              one DomeLight: sky light for the scene
```

**Only layers visible at export time are written.** A hidden layer has no
file, and the root has no reference to it. Visible means:

| layer | visible when |
| --- | --- |
| basemap | always |
| buildings | `visible` |
| trees | `meshVisible` (the circles are not exported) |
| sunlight | `visible`; being demanded through the DAG does not count |
| temperature | `visible` |
| light | always, day or night, whatever the overlays show |

### The root layer (`scene.usda`)

```usda
#usda 1.0
(
    customLayerData = {
        dictionary geo = { string crs = "EPSG:3857"; double originLat; double originLng; double sizeM }
        string exportedAt = "<ISO UTC>"
        string sunTime = "<ISO UTC>"
        string[] attribution = [ ... one per package, deduplicated ... ]
    }
    defaultPrim = "World"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "World"
{
    def "Basemap" ( prepend references = @./basemap.usdz@ ) {}
    def "Buildings" ( prepend references = @./buildings.usdz@ ) {}
    ...
}
```

- It holds **references**, not sublayers. Each child prim is one layer, so a
  consumer can deactivate it, move it or override it on its own.
- The children appear in stack order: basemap, buildings, sunlight,
  temperature, trees, then the light.
- Every package has a `defaultPrim`, so a reference names no prim path.
- It has no geometry and no materials.

### A layer package (`<layer>.usdz`)

- It follows the USDZ rules. The zip is uncompressed. The first entry is the
  package's root layer, `<layer>.usda`. Every entry's data starts at a
  64-byte-aligned offset. Only `.usda` and `.png` entries appear.
- Its root layer carries the same `upAxis`, `metersPerUnit` and `geo`
  metadata as `scene.usda`, so it also opens correctly on its own.
- Its `defaultPrim` is an `Xform` named after the layer, for example
  `/Buildings`, with `kind = "component"`. Its materials sit under `/<Layer>/Looks`, and its textures
  under `textures/` in the package.
- Its materials are `UsdPreviewSurface`. Nothing else is guaranteed to be
  read by every consumer.

## The export frame

Every file shares one local frame, so the layers line up with no transform in
the root:

- **Axes.** `x` east, `y` north, `z` up. Metres. The origin is the frame
  centre, on the ground (`z = 0`). This is the sunlight layer's frame
  (*Frame* in its spec), so its grids map onto it unchanged.
- **Extent.** A square of side `sizeM`, centred on the map centre at export
  time. `sizeM` is the USD export card's **Side** setting: 500 to 10,000 m in
  500 m steps, default 2,000 m. It is independent of the direct-sun display
  grid, whose side follows the zoom. The raster layers compute their own grid
  for it (*Raster layers and the frame*, below).
- **Projection.** A point's local coordinate is its Web Mercator offset from
  the centre, divided by `metreInMercator(centreLat)`, with `y` negated. So
  the frame is Mercator scaled at its centre. Across 4 km that differs from
  true ground distance by under 0.1%, and across 10 km by about 0.2% at the
  edges.
- **Inside** means `|x| ≤ sizeM / 2` and `|y| ≤ sizeM / 2`.
- **The tree layer's frame** is `x` east, `y` up, `z` south, so a tree-frame
  vector `(x, y, z)` is `(x, −z, y)` here. Both frames are right-handed, so a
  yaw of θ about three's `+y` is a yaw of θ about `+z`.

```ts
interface ExportFrame {
  centre: { lng: number; lat: number };
  sizeM: number;
}
```

**Raster layers and the frame.** Sunlight and temperature cover **exactly the
frame**, whatever its side. They do not write the display's result. At export
time, the direct-sun layer runs an **export pass** over the frame: one extra
light pass with its own tiles, occluders and target, off screen, which never
touches what the map shows. See *The export pass* in the sunlight spec. Its
grid is:
- **Side:** `sizeM`, centred on the frame's origin;
- **Cells:** `n = min(ceil(sizeM / 0.5), 4096, MAX_TEXTURE_SIZE)` per side, so
  0.5 m cells up to a 2,048 m side, growing beyond it (about 2.44 m at 10 km).

PET is derived from the same pass: its values are `petOf` of the same index
grid. Both overlays therefore cover the same cells, and a scene export runs
the pass once.

## Per layer

### Buildings (`buildings/usd.ts`)

- **Source.** The given `BuildingSource`, fetched through a `TileStore` of the
  export's own over every z14 tile the frame touches. Each feature is read
  with `buildingHeight` and filtered with `meetsMinHeight(settings.minHeight)`
  when `minHeight > 0`, the JS twins of the extrusion's filter (portability
  rule 5). A tile that fails rejects the export with `failed`.
- **Which footprints.** Every **footprint** (one polygon of a feature) with at
  least one vertex inside the frame. Nothing is clipped, so a building on the
  edge is whole. OpenMapTiles merges many footprints into one multipolygon
  feature, so the feature's other footprints that lie wholly outside are
  dropped; keeping the feature whole dragged in buildings kilometres away. A
  feature with no footprint kept is not exported. A feature that OpenMapTiles
  split at a tile edge is exported as the pieces it arrived in.
- **Extent.** The package's `extentM` (and its `customLayerData.extentM`) is
  the half-side of the smallest origin-centred square that covers every
  exported mesh and the frame. The basemap grows to it.
- **Geometry.** One `Mesh` per feature, holding its kept footprints, named `b_<x>_<y>_<index>` after its
  z14 tile and its order in it. Its polygons become:
  - **walls:** one quad per ring edge;
  - **roof:** triangles, from `THREE.ShapeUtils.triangulateShape`, as
    `addPrism` triangulates;
  - **no floor.**

  The outer ring is wound counter-clockwise seen from above, and holes
  clockwise, so with USD's default `rightHanded` orientation every face points
  outward. The base is at `z = 0`, and the top is at `height × heightScale`,
  as the extrusion draws it. The mesh uses `subdivisionScheme = "none"`.
- **Colour.** The colour the extrusion paints: `flatColor`, or the palette
  interpolated at the true height when `paletteId` names a palette (the
  extrusion colours by unexaggerated height). It is written as a constant
  `primvars:displayColor`, in linear RGB. One shared material reads it
  through a `UsdPrimvarReader_float3`.
- **Attributes.** `primvars:heightM` (constant) carries the true height,
  before `heightScale`. The package's `customLayerData` records `heightScale`.

### Trees (`tree/usd.ts`)

- **Source.** The given `TreeSource`, read with `treeOf`, over every z14 tile
  the frame touches, through a `TileStore` of the export's own. It is
  filtered by `kind` exactly as the meshes are (`all`, or `tree.kind ===
  kind`). A tree is kept when its position is inside the frame. A `tree_id`
  seen twice (points near a tile edge arrive in both tiles) is kept once.
- **One `PointInstancer`** at `/Trees/Instances`, with trees sorted by
  `tree_id`:
  - `protoIndices`: the prototype of the tree's form (`formOf(species)`);
  - `positions`: `(x, y, 0)` in the export frame;
  - `orientations`: a yaw of `rotationOf(tree_id)` about `+z`, as a `quath`;
  - `scales`: uniform, `height × heightScale / baseHeightM(form)`. `height` is
    the surveyed height, or the source's `fallbackHeightM`, and nothing else
    (tree spec, *Per-instance transform*);
  - `primvars:treeId` and `primvars:species` (string, one per instance), so a
    consumer can find a tree again. A species that is not a string is `""`.
- **Prototypes** at `/Trees/Instances/Prototypes/<form>`, one per form used,
  sorted by form name, from **the mesh source currently active**:
  - `procedural`: `buildForm(form)`'s bark and canopy meshes, with
    `buildMaterials()`' two colours;
  - `model`: the form's glTF at **level 0** (`<name>.glb`, the full-detail
    rung), normalised by `normalizeModel`, as one `Mesh` per part. Materials
    are kept as authored (tree spec, *Materials*): base colour and its
    texture; `opacityThreshold` from `alphaTest`; and `doubleSided` from
    `side`. Textures are encoded as PNG in the browser, because USDZ does not
    allow WebP. The glTF `uv` becomes `primvars:st` with `v` flipped
    (`1 − v`), since glTF's origin is top-left and USD's bottom-left. A model
    that fails to load rejects the export with `failed`.
  - Each prototype is an `Xform` with a `rotateX` of 90°, which turns its
    Y-up geometry into the frame's Z-up.
- **Attribution.** The tree source's attribution, plus `MODELS_ATTRIBUTION`
  when the model source is used (the models are CC BY).

### Sunlight and temperature (`sunlight/usd.ts`, `temperature/usd.ts`)

- **Geometry.** One quad `Mesh` covering the frame, the export pass's grid,
  with `st` spanning `[0, 1]²`, north up. It sits just above the ground so it does not z-fight
  the basemap: sunlight at `z = 0.02`, temperature at `z = 0.04`.
- **Texture.** A PNG of the export pass's grid, at its cell resolution. Each
  value goes through the layer's ramp at full opacity (alpha 255). Roof,
  incomplete and outside cells are transparent (alpha 0). The material uses
  the texture's `rgb` as `diffuseColor` and its `a` as `opacity`, with
  `opacityThreshold` 0.5.
- **Values.** The float grid is not in the package, because USDZ cannot
  carry a TIFF. The outer zip carries it as `<layer>.tif`, beside the package,
  written like the layer's own GeoTIFF export (EPSG:3857, north up, the same
  metadata), but over the frame. The package's `customLayerData` records
  it as `string values = "<layer>.tif"`, along with the layer's NoData (`-1`
  for direct sun, `-9999` for PET). It is a string, not an asset path: inside
  a package, an asset path resolves within the package, so it would be
  reported as a missing dependency.
- **Metadata.** Beside `values` and `noData`, the package's `customLayerData`
  records `sunTime` (ISO UTC) and `quantity`, a readable name for what the
  values are. PET also records `g0`, `ta` and `v`, the parameters it was
  computed with.
- **Centred.** `rasterPackage` rejects with `failed` a grid whose centre lies
  more than half a cell from the frame's origin. A layer computes its grid
  over the frame, so one elsewhere is a bug, and is never written.
- **Attribution.** Sunlight credits the tree source and the building source,
  whose features cast its shadows. Temperature credits none of its own: it
  derives from the same pass, whose package credits them.
- **One pass.** The PNG and the GeoTIFF of both overlays come from one export
  pass (`LpiField.readFrame`, below). The index grid is read back once, and
  each overlay maps it through its own transform. Both turn their read into
  a raster the same way, through `nearRaster` in the sunlight folder's
  `index.ts`.
- **The ramps in JS.** The direct-sun ramp exists only as a GLSL uniform
  today, so it gains a JS twin, `sunlightRampAt(index)` in `sunlight/ramp.ts`.
  The shader's uniform and the JS twin both read the one `RAMP` table there,
  and a test checks the twin against the spec's table. Temperature already has
  `petRampAt`.

### Light (`sunlight/usd.ts`)

The scene's light, so it opens lit.

- **The light.** One `DomeLight` at `/Light/Dome`, the package's root prim
  being `Light`:
  - `inputs:intensity = 1000` and `inputs:exposure = 0`;
  - `inputs:color = (1, 1, 1)`;
  - no texture, so it is a uniform sky, and no orientation.
- **When.** Every export, day or night. A dome is sky light, not the sun, so
  nothing gates it.
- **The sun is not a light.** A dome has no direction, so the sun's position
  is not in the lighting. The package's `customLayerData` records it for a
  consumer who wants to add one: `sunTime` (ISO UTC), and `azimuthDeg` and
  `elevationDeg` from `sunPosition` at the frame's centre, the sun the
  overlays' shadows are cast with.
- **Cost.** No fetch and no GPU.

The sunlight mount exposes it as `exportLightUsd(frame)`, since the sun's
position is that layer's. It reads only the mount's own `sunTime`, so it does
not need the overlay to be visible or `ready`.

### Basemap (`basemaps/usd.ts`)

- **Geometry.** One quad `Mesh` at `z = 0`, covering the **ground square**: the
  frame, grown to the buildings package's `extentM` when buildings are
  exported, so the ground lies under every exported building. It stays centred
  on the frame's origin, so the other layers still line up. The sunlight and
  PET quads stay frame-sized: the export pass computes the frame, not the
  buildings' overhang. The
  package's `customLayerData.groundSizeM` records the ground square's side,
  and `customLayerData.style` the style URL it was rendered from.
- **Resolution at large sides.** One capture of at most 4,096 pixels covers
  the ground square, so a 10 km side at 4,096 px is about
  2.4 m per pixel. Tiling the capture stays out of scope.
- **Texture.** The current basemap style, rendered top-down in a hidden
  offscreen MapLibre map: pitch 0, bearing 0, its canvas square, and its view
  fitted exactly to the ground square in Mercator. It is created with
  `preserveDrawingBuffer: true` and captured as PNG on the first `idle` after
  its style has loaded. Resolution is 2 px per metre, capped at the GPU's
  `MAX_TEXTURE_SIZE` and at 4,096 px, MapLibre's default `maxCanvasSize`.
  Browsers refuse larger WebGL canvases on common GPUs even when the texture
  limit allows them. Its building layers are hidden
  (`hideBasemapBuildings`), and so are its symbol layers: labels are drawn in
  screen space, and baked into a ground texture they would sit at the wrong
  scale.
- **Cleanup.** The hidden map and its container are removed afterwards,
  whether the export succeeds or not.
- **Timeout.** A capture that does not reach `idle` within 60 s rejects with
  `failed`.
- **Attribution.** `OSM_ATTRIBUTION`.

## The host's part

- `useMapEngine` gains `exportScene(sizeM): Promise<Blob>`. It rejects when
  the map is not ready yet. Otherwise it:
  1. builds the `ExportFrame` from the map centre and the side it is given;
  2. asks each participant `sceneParticipants(visible)` names for its
     package: `exportBuildingsUsd` and
     each mount's `exportUsd(frame)` all at once, and `exportBasemapUsd` once
     the buildings package has resolved, with its `extentM`. It always asks
     the sunlight mount for `exportLightUsd(frame)`, and adds that package;
  3. writes `scene.usda` from the packages, in stack order;
  4. zips everything, stored, into one `Blob`.

  It knows each package only as a `UsdPackage`, and adds no per-layer logic
  (portability rule 1).
- `sceneParticipants(visible)` in `src/lib/sceneExport.ts` turns the four
  visibility flags (buildings, sunlight, temperature, tree meshes) into the
  participants, in stack order, per the table in *Output*. The host exports
  them, and `App.tsx` lists them. `sceneExportReady(...)` is the button's rule
  below.
- `App.tsx` adds a **Side** slider and an **Export USD** button in a panel of
  their own. The slider is in km, 0.5 to 10 in steps of 0.5, default 2, and
  lives in App state. It is not saved across reloads. Under the slider, an
  **Includes** line lists the layers the export will write, in stack order,
  from `sceneParticipants`. The button is
  enabled once the map is ready, and only when each visible raster
  participant is in state `ready` (buildings, trees and basemap are always
  ready). While the export runs, the button reads "Exporting…", as the
  GeoTIFF buttons do. A rejected export shows its message under the button.

```ts
// src/lib/usd
interface UsdPackage {
  /** File stem and root prim name: "buildings" → buildings.usdz, /World/Buildings. */
  name: string;
  /** The package's root prim name, for example "Buildings". */
  prim: string;
  usdz: Blob;
  /** Files written next to the package in the outer zip (the GeoTIFFs). */
  sidecars: { name: string; blob: Blob }[];
  /** Shown in the root's attribution list. */
  attribution: string[];
  /** Set by a raster layer: its result's sun time. */
  sunTime?: number;
  /** Half-side of the origin-centred square covering the geometry, when it can exceed the frame. */
  extentM?: number;
}

class UsdExportError extends Error {
  reason: "not-ready" | "failed";
  layer: string;
}
```

A participant rejects with a `UsdExportError`. The scene export then rejects
as a whole, naming the layer, and a partial scene is never downloaded.

## Changes to shared contracts

- **`LpiField` gains `readFrame(frame, transform, nodata, metadata)`**, which
  resolves to `{ tiff: Blob; grid: NearGrid }` (the export pass's grid mapped
  through `transform`), or rejects with a `UsdExportError`. `NearGrid` holds
  `size`, `values` (a `Float32Array`, rows from the north), `nodata`, the
  grid's `Domain`, the sun time and the GDAL metadata. The pass for a frame
  and sun time is kept until the next one, so the second overlay reuses it.
  `readNear` (the display's GeoTIFF) is unchanged.
- **The mount member table** (`src/lib/mount`): `mountTree`, `mountSunlight`
  and `mountTemperature` gain `exportUsd(frame)`, and `mountSunlight` also
  gains `exportLightUsd(frame)`.
- **The host's allowlist** (`lib/mount/structure.test.ts`) gains
  `/^export\w+Usd$/`, so the host can call the two record-only layers' export
  functions.
- **The shared-module guard** (`lib/tiles/structure.test.ts`) covers
  `src/lib/usd` too: it imports nothing from `src/layers/`.

## Invariants

1. **One frame.** Every package's geometry is in the export frame. The root
   applies no transform, and a building, a tree and a sunlit cell that
   coincide on the map coincide in the stage.
2. **No re-reading.** A package reads its data only through its owner's
   schema (`treeOf`, `buildingHeight`, `meetsMinHeight`) and its owner's
   derivations (`formOf`, `rotationOf`, `buildForm`, `normalizeModel`, the
   ramps).
3. **Deterministic.** The same data, settings, frame and sun time give
   byte-identical `.usda` text. Prims are sorted, numbers are formatted by
   one routine, and the only timestamp is `customLayerData.exportedAt` in the
   root.
4. **USDZ-valid.** Every package is uncompressed, 64-byte aligned, contains
   only allowed file types, and has its root layer first.
5. **What you see.** Only visible layers are exported, with the settings,
   mesh source, basemap and sun time on screen.
6. **Portable.** `src/lib/usd` imports nothing from `src/layers/`, and names
   no city (portability rules 8 and 9). A layer's `usd.ts` names no other
   layer's settings (rule 6).
7. **No dependency.** The writers are hand-written, like `geotiff.ts`, and
   `package.json` does not change.

## Tests

In vitest, with no GL context:
- `usda.ts`: golden strings for prims, typed attributes, arrays, asset paths,
  string escaping and number formatting.
- `zip.ts` / `usdz.ts`: a small reader in the test parses the output back. It
  checks CRCs, stored-only entries, 64-byte data alignment, and the root
  `.usda` first.
- `frame.ts`: Mercator ↔ local conversions, the tiles a frame touches, the
  tree frame's `(x, −z, y)` mapping, and the yaw quaternion.
- `raster.ts`: colourising, with NoData transparent.
- `scene.ts`: the root references exactly the given packages, in order.
- `settle` (`src/lib/tiles`): it settles on ready and on failed tiles.
- `ground.ts`: a grid not centred on the frame rejects with `failed`.
- The export grid: its cell count and size for a side (0.5 m up to 2,048 m,
  capped at 4,096 cells), its domain centred on the frame, the tiles it
  fetches (the frame plus the fetch margin), and the reuse of one pass by both
  overlays, including two requests made together, before the pass finishes.
  The host builds its frame from the side it is given.
- `sceneParticipants`: the stack order, each flag adding only its own layer,
  the basemap and the light always. `sceneExportReady`: the map ready, and
  each visible raster overlay `ready`.
- `buildings/usd.ts`, on fake features: the filter, the per-footprint
  edge-vertex rule, the extent,
  winding, palette colours and determinism.
- `tree/usd.ts`, on fake features: the kind filter, deduplication,
  `fallbackHeightM`, yaw equal to `rotationOf`, and scale.
- `tree/usd.ts`: the procedural prototypes (one per form, bark and canopy,
  the `rotateX` of 90°), and a model that fails to load rejecting with
  `failed`.
- `sunlightPackage` and `temperaturePackage`, with the PNG encoder stubbed:
  the texture, the `.tif` beside the package, `values`, `noData`, `sunTime`,
  `quantity` (and PET's parameters), and the attribution.
- `basemaps/usd.ts`: the capture hides the style's symbol layers and asks
  for its buildings to be hidden, on a fake map.
- `sunlightRampAt` against the spec's table.
- Each mount's "exposes exactly its members" test gains `exportUsd`, and
  sunlight's also `exportLightUsd`.
- The light package: one `DomeLight` at intensity 1000, written by day and by
  night, with the sun's time, azimuth and elevation in its metadata.

Checked by hand (`ai/WORKFLOWS.md`): `usdchecker` on each package, the
scene opened in usdview, lining up with a screenshot of the map, and the
basemap capture's cleanup and 60 s timeout, which need a real DOM and map.

## Decisions

Settled when this spec was approved (2026-09-30):

1. **Building colour** is the on-screen colour, as `displayColor`.
2. **Tree models** export level 0 only, with no variant sets.
3. **Buildings and basemaps** export through a function in their `index.ts`,
   which the host calls. There is no mount made just for the export.
4. **Basemap resolution** is 2 px/m, capped at `MAX_TEXTURE_SIZE` and 4,096 px,
   in one capture. There is no tiled stitching.
6. **The side is the user's** (added 2026-09-30): 0.5–10 km in 0.5 km steps,
   default 2 km.
7. **The overlays cover the frame** (added 2026-09-30, superseding the crop):
   an export pass computes direct sun over exactly the frame, in one 4,096-cell
   pass, and PET derives from it.
8. **The scene has a dome light** (2026-09-30, replacing a sun
   `DistantLight` the same day): `light.usdz`, one `DomeLight` at intensity
   1000, in every export. The sun's position is metadata only.
5. **Raster z-offsets** are 2 cm for sunlight and 4 cm for temperature.

## Out of scope

- Terrain. The ground is flat at `z = 0`, as the map is.
- Ambient occlusion. It is a screen-space effect with no geometry; a DCC
  computes its own.
- The far grid, and anything outside the frame.
- Tiled export passes at a fixed cell size. One pass of at most 4,096 cells
  per side covers the frame, so cells coarsen beyond a 2,048 m side.
- Binary `.usdc`, animation over sun time, and geospatial schemas (such as
  Cesium's georeference prims). The origin is recorded in metadata only.
- Merging building pieces split at tile edges.
- Growing the raster overlays with the ground: outside the frame they have no
  data.
- Basemap labels.
