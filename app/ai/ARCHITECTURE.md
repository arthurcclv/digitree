# ARCHITECTURE — how the pieces fit

Structural orientation. Each layer's contract with GeoLibre is in its
`src/layers/<name>/specs/spec.md`; this file covers what sits *between* the
layers.

## Shape

Single Vite + React app, living in `app/` beside `infra/`. No monorepo, no
workspaces, no root `package.json` — `app/package.json` is the only one, and the
app is entered with `cd app`. `app/` never imports from `infra/`; it reaches its
data over HTTP like any other tile source. Three tiers:

```
App.tsx                   state + chrome        (knows settings, not MapLibre)
  ↓ settings objects
layers/<name>/records.ts  description           (knows GeoLibre, not MapLibre*)
layers/<name>/mount.ts    attachment            (the layer's own lifecycle on a map)
  ↓ GeoLibreLayer records, via prepareSync()
lib/useMapEngine.ts       the host              (owns the map, the sync, the graph)
```

\* `layers/basemaps` is the deliberate exception — it is an *extension*, not a
layer, and it does touch the map (see below). `buildings` has a record builder
and no mount: it needs nothing else.

A layer with a custom (three.js) half is **portable**: any GeoLibre host that
owns a MapLibre map and a `LayerSync` can run it with `mount<Name>(ctx,
settings)`, then `update` and `prepareSync`. Nothing the layer needs lives in
the host. The contract is `src/lib/mount/specs/spec.md`.

## The one-way flow

```ts
// App.tsx
const [settings, setSettings] = useState<BuildingSettings>(DEFAULT_BUILDING_SETTINGS);
const [tree, setTree] = useState<TreeSettings>(DEFAULT_TREE_SETTINGS);
const [sun, setSun] = useState<SunlightSettings>(DEFAULT_SUNLIGHT_SETTINGS);
const [ao, setAo] = useState<AmbientOcclusionSettings>(DEFAULT_AO_SETTINGS);
const [temp, setTemp] = useState<TemperatureSettings>(DEFAULT_TEMPERATURE_SETTINGS);
const [probe, setProbe] = useState<ProbeResult | null>(null);
const [petProbe, setPetProbe] = useState<PetProbe | null>(null);
// the engine reports probe clicks back
useMapEngine(basemap, settings, tree, sun, ao, temp, setProbe, setPetProbe);

// useMapEngine.ts — on any settings change
mounts.ao.update({ ao, extrusion: shadedExtrusion(settings) }); // every update first: one
mounts.sunlight.update(sun);                    // layer's may change another's
mounts.temperature.update(temp);                // records through DAG demand
mounts.tree.update(tree);
// applyLayers()
sync.sync([
  buildingsLayer(settings),
  ...mounts.ao.prepareSync(),          // shown only while the buildings are
  ...mounts.sunlight.prepareSync(),    // visible while sunlight.lpi is demanded
  ...mounts.temperature.prepareSync(), // derives from sunlight through the DAG
  ...mounts.tree.prepareSync(),        // [points, mesh]
]);
```

Every control is a `setState`. React re-renders, the effect in `useMapEngine`
hands every mount its settings, then `applyLayers` rebuilds the records and
syncs them. `sync` re-applies every layer it is given, so `applyLayers` skips
it when the records are identical to the last ones synced (a sun-time step
changes none). There is no imperative path from a control to a style property,
and no state lives in the map that is not derivable from `App.tsx`.

`settingsRef` exists only so that `applyLayers` can stay a stable
`useCallback` and still be called from the `style.load` handler, which was
registered once at map creation. Each mount keeps its own last settings.

## Who may touch the MapLibre map

Three places:

1. **`lib/useMapEngine.ts`**, the host. It constructs the map, owns the
   style-load lifecycle, drives the camera, and holds the `LayerSync`, the
   derived-layer `Graph`, and the four mounts.
2. **Each layer's `mount.ts`**, which uses the map for exactly two things:
   `getLayer` and `addLayer` for its own custom layer (through
   `nativeLayer` in `src/lib/mount`). It also registers the layer's paint
   bridge.
3. **`layers/basemaps/index.ts`** — `hideBasemapBuildings`, `firstLabelLayerId`,
   `anchorUnderLabels`. These are style surgery, not layer description, and they
   are called *by* `useMapEngine`.

The four custom-layer classes, `ThreeTreeLayer`, `ThreeSunlightLayer`,
`ThreeTemperatureLayer` and `ThreeAoLayer`, all extend `ThreeLayer`
(`src/lib/three`). MapLibre hands them the map in `onAdd`, and they use it
only for what a custom layer needs: the camera, repaints, and, for the
self-fetching layers and the tree, the settled view (`viewSettled`, the base's
coalesced `idle`) and `unproject`, to replan their tiles. Each is constructed
and added by its own folder's mount, never by anything else.

Nothing in `App.tsx`, `ui/`, or the other layer folders imports `maplibre-gl`.

## Layer folder rules

- `index.ts` is the only entry other modules import (`../layers/tree`, never
  `../layers/tree/treeLayer`). Split freely *inside* the folder.
- A folder may import from `src/lib` and from another layer's `index.ts`
  (`sunlight` imports `treeTiles` from `tree` and `buildingTiles` from
  `buildings`). It must not reach into another folder's internals.
- **No layer holds an endpoint.** Where a dataset is served is a descriptor
  (`TreeSource`, `BuildingSource`) that the host passes in. How a feature is
  read is the owning layer's `schema.ts`. See *Data sources* below and
  `src/lib/tiles/specs/spec.md`.
- `specs/spec.md` is mandatory.
- A layer with a custom half keeps its record builders in `records.ts` and its
  mount in `mount.ts`. `mount.ts` imports `records.ts` and only *types* from
  `index.ts`, so the two never form a module cycle.

Current folders: `basemaps` (extension — produces no record), `buildings`
(vector-tile extrusion record), `tree` (external-native record + the custom
layer class), `sunlight` (external-native record + a second custom layer that
computes the direct-sun index from the tree and building tiles),
`ambient-occlusion` (external-native record + a third custom layer that
darkens the drawn buildings by screen-space ambient occlusion), `temperature`
(external-native record + a fourth custom layer that draws PET, derived from
the sunlight layer's result through the DAG).

**Derived layers go through the DAG** (`src/lib/dag`, its own spec). A layer
whose output another layer derives from owns a node (`sunlight.lpi`); the
dependent owns one downstream of it (`temperature.pet`). The host creates
the one graph per map and hands it to every mount; each mount adds its own
node, so mount order is dependency order (a dependent mounted first throws).
The two layers never hold a reference to each other, and the host forwards
nothing between them: value **and state** travel through the graph (the
temperature layer reads `graph.state("sunlight.lpi")` to report `zoom`,
`low-sun`, …). Publishing a node notifies everything downstream. Demand flows the other
way: a shown dependent makes its upstream compute even when that upstream's own
overlay is hidden. Because MapLibre runs no `prerender` for a hidden layer, a
record's visibility is whether its node is *demanded*, and the overlay's drawn
visibility is set on the layer by its mount's `update`, not through the paint
bridge.

The temperature layer shares the sunlight layer's GPU result without a copy:
the `LpiField` it publishes carries the render targets' `WebGLTexture`s, which
the temperature layer's own renderer wraps in `THREE.ExternalTexture`. Those
wrappers are never disposed (three would delete the texture). Its probe and
export go back through the field's `probe` and `readNear`, so only the
sunlight layer ever reads pixels.

**Two ways to get data.** The tree mesh reads MapLibre's own parsed tiles back
with `querySourceFeatures`, so it sees exactly the viewport. The sunlight
overlay cannot: the shade at the sunward edge of the view, and on the far ground
of a pitched view, comes from tiles MapLibre never loads. So it fetches its own
(`src/lib/tiles`), from the same two descriptors the records use, and depends
on no other layer being shown. The ambient-occlusion layer fetches the building tiles the same
way, into a buildings-only store of its own, because MapLibre's depth buffer
cannot be sampled and it must redraw the buildings itself.

**`src/lib/tiles` is shared, not a layer, and knows no dataset.** It holds
what both self-fetching layers need: the z14 grid and Mercator formulas
(`grid.ts`); the `TileStore` (`store.ts`), which is generic over the sources
it is given and handles fetch, TileJSON resolution, the LRU cache and
`decodeMvt` over `@mapbox/vector-tile`; per-tile building triangulation and
placement (`prisms.ts`); and the viewport's ground footprint (`footprint.ts`).
Each layer holds its own store instance, and the browser's HTTP cache answers
the second request for a building tile. It imports nothing from `src/layers/`,
and `structure.test.ts` enforces that.

**Data sources.** Where the data is and how it is read are separate. *Where*
is a plain descriptor (`TreeSource`: `tiles`, `sourceLayer`, zoom range,
`bounds`, `attribution`; `BuildingSource`: `tileJson`, `sourceLayer`,
`attribution`). The app's only values are in `src/sources.ts` (`TREES`,
`BUILDINGS`, `TREES_SURVEYED`). `useMapEngine` hands them to the records and
mounts, and `App.tsx` reads the attributions from them. *How* is each dataset
owner's `schema.ts`, the single reading every consumer shares:
- `tree/schema.ts` has `treeOf`, which the meshes and the direct-sun layer
  both read trees with, plus `treeTiles(source)`, the tree source as a
  `TileStore` source.
- `buildings/schema.ts` holds the extrusion's MapLibre filter and height
  expression beside `buildingHeight`, the JS form, plus
  `buildingTiles(source)`.

**The place.** What the app knows about *where it is* is not data either.
`src/lib/place` (its own spec) is generic: `Place`, `Viewpoint`, and local
time at a fixed UTC offset (`localDate`, `localMinutes`, `fromLocal`,
`noonToday`, `offsetLabel`). `src/place.ts` holds the app's `PLACE`: Taipei,
UTC+8, the Xinyi home view, and the panel's 05:00–19:00. `useMapEngine`
starts the camera at `PLACE.home`. `App.tsx` gives the sunlight layer its
moment (`noonToday(PLACE)`) and builds the time labels from `PLACE`. The
layers name no city: the sunlight layer has no default moment, and the
dataset facts it used to hold (record names, `sourceKind`, the tree fallback
height) are descriptor fields.

Another city is a change to `src/sources.ts` and `src/place.ts` only,
provided its data publishes the same schema. The species tables are the one
Taipei-specific content left in the layers; see the place spec, *Out of
scope*.

`tree` is the one folder with a real internal split, and the split is by
dependency rather than by topic:

| Module | Owns | Imports three.js |
| --- | --- | --- |
| `index.ts` | the folder's entry: `TreeSettings`, re-exports | no |
| `records.ts` | the two GeoLibre records | no |
| `mount.ts` | `mountTree` — the layer attached to a map | yes, via `treeLayer.ts` |
| `constants.ts` | the record ids, `MODELS_ATTRIBUTION` | no |
| `schema.ts` | `TreeSource`, `TREE_PROPS`, `treeOf` (the one reading of a tree), `treeTiles` | no (it pulls `lib/tiles`) |
| `forms.ts` | `TreeForm`, the 100-species table, `formOf()` | **no** |
| `placement.ts` | `rotationOf()` — a tree's yaw, hashed from its `tree_id` | **no** |
| `formGeometry.ts` | the eight procedural shapes, the two shared materials, and `canopyHullOf` | yes |
| `models.ts` | `FORM_MODELS`, the glTF loader, `normalizeModel`, the LOD rule | yes |
| `treeLayer.ts` | `ThreeTreeLayer` — the custom layer, instancing, the GL seam | yes |

`forms.ts` and `placement.ts` are deliberately three.js-free. They are the
layer's two pure modules and therefore the ones fully testable without a GL
context, which is why the species table lives in one and the rotation hash in the
other rather than inside the geometry they feed.

They also divide along the same line: both answer a question about the *tree*
rather than about the mesh. `forms.ts` says which shape it takes, `placement.ts`
says which way it faces — and because neither reads the geometry, a source
switch changes neither.

`sunlight` splits the same way — pure modules for everything that can be
tested, one module for the GL:

| Module | Owns | Imports three.js |
| --- | --- | --- |
| `index.ts` | `SunlightSettings`, `DEFAULT_SUNLIGHT_SETTINGS` (no moment: the host's), re-exports | no |
| `records.ts` | the GeoLibre record | no |
| `mount.ts` | `mountSunlight` — adds `sunlight.lpi`, the bridge, the re-add | yes, via `sunlightLayer.ts` |
| `sun.ts` | `sunPosition()` — the NOAA solar position formulas | **no** |
| `state.ts` | `SunlightState`, `SUNLIGHT_MIN_ZOOM`, `blockedState()` (what stops all work), `readoutSun()`, `lpiNodeAction()` | **no** |
| `lpi.ts` | the DAG node: `LPI_NODE`, `LpiField`, and `LPI_SAMPLE_GLSL`, the sampling code both overlays share | **no** |
| `transmittance.ts` | `FORM_ALPHA`, `SPECIES_ALPHA`, `alphaOf`, `tauOf` | **no** |
| `frame.ts` | the two domain grids, local frame, shadow shear, footprint polygon helpers | **no** |
| `tileGrid.ts` | fetch planning and tile-based coverage (re-exports the grid from `src/lib/tiles`) | **no** |
| `geotiff.ts` | the hand-written GeoTIFF writer | **no** |
| `sunlightLayer.ts` | `ThreeSunlightLayer` — the light pass, overlay, probe, export | yes |

It borrows the crown shape from the tree layer through `canopyHullOf(form)`
(the convex hull of the procedural canopy), the per-tree yaw through
`rotationOf`, and the tree tile source (`treeTiles`, over the `TreeSource`
its mount is given), all from the tree's `index.ts`. So the shadow and the drawn
tree share a shape and a facing, and nothing else of the tree layer's internals
is reached.

`temperature` has the same split, smaller, since it computes nothing of its own:

| Module | Owns | Imports three.js |
| --- | --- | --- |
| `index.ts` | `TemperatureSettings`, `PET_PARAM_RANGES`, re-exports | no |
| `records.ts` | the GeoLibre record | no |
| `mount.ts` | `mountTemperature`, `PET_DEPS` — adds `temperature.pet` after `sunlight.lpi` | yes, via `temperatureLayer.ts` |
| `pet.ts` | `PET_NODE`, `PetField`, the formula (`PET_COEFFS`, `petOf`, `petGlsl`), the ramp, `classOf`, `petProbeOf` | **no** |
| `state.ts` | `TemperatureState`, `temperatureState()` | **no** |
| `temperatureLayer.ts` | `ThreeTemperatureLayer` — the overlay, and probe and export through the `LpiField` | yes |

The shader's PET expression is generated by `petGlsl()` from the same
coefficient table as `petOf`, so the GPU and CPU forms cannot drift.

`ambient-occlusion` has the same split:

| Module | Owns | Imports three.js |
| --- | --- | --- |
| `index.ts` | `AmbientOcclusionSettings`, `ShadedExtrusion`, re-exports | no |
| `records.ts` | the GeoLibre record | no |
| `mount.ts` | `mountAmbientOcclusion` — takes `{ ao, extrusion }` | yes, via `aoLayer.ts` |
| `state.ts` | `AoState`, `AO_MIN_ZOOM`, `aoState()` | **no** |
| `kernel.ts` | the hemisphere kernel, the 4 × 4 rotation tile, `compositeFactor` | **no** |
| `geometry.ts` | tile planning, prism placement with exaggeration and the min-height filter (`meetsMinHeight`, from the buildings schema) | **no** |
| `aoLayer.ts` | `ThreeAoLayer` — G-buffer, AO, blur, composite | yes |

Its interface names what it shades in its own terms: a `ShadedExtrusion`
(`visible`, `heightScale`, `minHeight`), the extrusion it redraws and so must
match. The host maps its extrusion's settings onto it; here `useMapEngine`'s
`shadedExtrusion(BuildingSettings)`. It reads the buildings' **data** through
their schema (`buildingTiles`, `meetsMinHeight`, the JS form of the
extrusion's `minHeightFilter`), and never their settings. A test fails if any
of its modules imports another layer's settings type.

`formGeometry.ts` and `models.ts` are the two **mesh sources**, and they are
interchangeable on purpose: each hands `treeLayer.ts` a list of
`{ geometry, material }` parts plus the height its shape was modelled at, and
the layer places them identically. `models.ts` needs a GL context no more than
`formGeometry.ts` does — `normalizeModel` is bounding-box arithmetic over
`BufferGeometry` and is tested, unlike the fetch around it.

Neither source reaches the other, and nothing outside `treeLayer.ts` chooses
between them: `App.tsx` sets `TreeSettings.meshSource` and the layer resolves it
per form, because a form is modelled only once its file has actually arrived.

## The style-load cycle

This is the non-obvious part of the engine. `map.setStyle()` — which every
basemap swap calls — **wipes the entire style**: GeoLibre's layers and every
MapLibre custom layer are destroyed. So `onStyleLoad` is the app's real
initialisation path and runs on every basemap change, not once:

```
style.load
  → styleReadyRef = true
  → syncedRef = null                   // the style is new: always sync
  → hideBasemapBuildings(map)          // kill the basemap's own buildings
  → map.setLight(...)                  // tolerated to throw
  → applyLayers()                      // each mount's prepareSync re-adds its
                                       // custom layer if missing (sync only
                                       // *moves* native layers), then
                                       // sync([buildings, ao, sunlight, temperature, tree…]) + re-anchor
  → setReady(true)
```

`styleReadyRef` exists because `map.isStyleLoaded()` stays false until every
source settles, long after the style is usable; syncing on that signal would be
needlessly late.

Every three.js layer *instance* deliberately outlives style changes. That is
`ThreeLayer`'s lifecycle: `onAdd` keeps the existing `WebGLRenderer` when the
GL context is unchanged, `onRemove` drops only the map reference, and
`dispose` is for map teardown only.

## The three.js seam

**One host for the GL rules.** `ThreeLayer` (`src/lib/three`, its own spec)
holds everything the four layers share with MapLibre's context:
- the renderer, made once per context with `autoClear = false`;
- `renderingMode: "3d"`;
- `pass(fn)`, which resets state before and after every block of three.js
  drawing;
- `projection(args, model)`, the one place `mainMatrix` is read;
- `mercatorFrame`, the local-metres-to-Mercator matrix;
- `PREMULTIPLIED_OVER`.

Each layer writes only its own `render`, and a `prerender` only if it has
offscreen work: MapLibre gives any layer with one an offscreen pass, so tree
has none. A structure test fails if a layer makes a renderer, resets state or
reads `mainMatrix` itself.

The tree is not a sibling of the map; it is a member of the layer list. The
record's `metadata` opts into GeoLibre's external-native path:

```ts
metadata: { customLayerType: "threejs", nativeLayerIds: [...], paintMode: "plugin" }
```

On that path GeoLibre only **moves and shows** the named native layer — it does
not create it and does not paint it. Opacity and visibility reach three.js
through `setExternalNativePaintBridge(TREE_LAYER_ID, { setOpacity, setVisibility })`,
registered by `mountTree` and cleared by its `dispose`. Height is not
a GeoLibre concept, so `setHeightScale` is pushed by the mount's `update`. Full contract: `src/layers/tree/specs/spec.md`.

The sunlight overlay is a second member on the same path, with its own paint
bridge (`SUNLIGHT_LAYER_ID`) and its own `WebGLRenderer` on the shared context.
It also uses MapLibre's `prerender` hook — the offscreen pass — for its light
pass and for every readback (probe, export), so no GL work of its own ever runs
between MapLibre's draws. The sun time is pushed by the mount's `update`, like
height.

The temperature overlay is a fourth member, with its own paint bridge
(`TEMPERATURE_LAYER_ID`, opacity only) and its own `WebGLRenderer`. Its
`prerender` only publishes its DAG node; `render` draws the PET quad from the
sunlight textures. `G0`, `Ta` and `V` reach it through `setParams`, pushed by
its mount's `update`, and the sunlight state through the DAG
(`graph.state("sunlight.lpi")`).

The ambient-occlusion layer is a third member, with its own paint bridge
(`AO_LAYER_ID`, visibility only). Its G-buffer, AO and blur passes run in
`prerender`; `render` only multiplies the result over the frame. Intensity,
radius and the buildings' exaggeration and filter reach it through
`setParams`, pushed by its mount's `update`.

## Module inventory

| Module | Owns |
| --- | --- |
| `src/main.tsx` | React root, `StrictMode`, imports `styles.css` |
| `src/App.tsx` | all control state, the chrome, the status bar, telemetry |
| `src/lib/useMapEngine.ts` | the host: map lifecycle, the mounts and their order, layer sync, the one DAG, camera, the probe clicks and export hand-offs, `exportScene` (the USD export: frame, packages, root, zip); exports `Camera`; starts at `PLACE.home`; keeps `flyTo` / `setPitch` with no caller yet |
| `src/lib/mount/` | `LayerMount`, `nativeLayer` (bridge + re-add), `changed`, and `fakeMap` for tests; its own spec |
| `src/lib/three/` | `ThreeLayer` (the renderer lifecycle, `pass`, coalesced `idle`), `projection`, `mercatorFrame`, `PREMULTIPLIED_OVER`; its own spec |
| `src/lib/dag/` | the derived-layer DAG (`createGraph`): nodes, publish/clear, demand; pure, with its own spec |
| `src/lib/tiles/` | the self-fetching layers' shared tile grid, the generic `TileStore`, `decodeMvt`, `settle` (wait for a store of the caller's own), building prisms and ground footprint; the *Data sources* spec |
| `src/lib/usd/` | the USD export's shared writer: `.usda` text, stored zip and `.usdz`, the `ExportFrame`, ground and raster packages, the root layer and the outer zip; knows no layer; its own spec |
| `src/lib/sceneExport.ts` | the host's scene-export rules, pure: `sceneParticipants` (who is written, in stack order) and `sceneExportReady`; shared by `useMapEngine` and `App.tsx` |
| `src/lib/colour.ts` | `hexRgb`, `srgbToLinear`, `interpolateStops`: the one colour reading behind the direct-sun and PET ramps, the buildings' palette colour and `lib/usd`'s linear colours |
| `src/layers/sunlight/occluders.ts` | one set of placed occluders and the scenes a light pass draws; the display holds one, each USD export pass builds and disposes its own |
| `src/layers/<name>/usd.ts` | that layer's USD package (buildings, tree, sunlight, temperature, basemaps), exposed as a mount's `exportUsd(frame)` or, for the two mount-less folders, as `exportBuildingsUsd` / `exportBasemapUsd` |
| `src/sources.ts` | the app's datasets: `TREES`, `BUILDINGS`, `TREES_SURVEYED`. The only place an endpoint lives |
| `src/lib/place/` | `Place`, `Viewpoint`, local time at a fixed offset; its own spec |
| `src/place.ts` | the app's `PLACE`: Taipei, UTC+8, the Xinyi home view, the panel's daylight range. With `src/sources.ts`, the only place the city is named |
| `src/ui/Panel.tsx` | `Panel` / `Slider` / `CheckboxRow` / `Segmented` / `Badge` / `Spinner` / `StatLine` primitives — presentational only |
| `src/ui/cameraReadout.ts` | the status bar's coordinate and zoom formatting; pure, tested |
| `src/ui/Compass.tsx` | bearing rose, inline SVG, click resets north |
| `src/ui/LayerMenu.tsx` | the viewport's layer-visibility popover; owns only its own open/closed state |
| `src/styles.css` | the entire design system; no CSS modules, no styled-components |

`Viewpoint` lives in `src/lib/place` beside `Place`, whose `home` is one. The
engine consumes both: `PLACE.home` is the initial camera, and `flyTo` takes a
`Viewpoint`.

## Build-time coupling

Two settings in `vite.config.ts` plus one line in `useMapEngine.ts` exist solely
to get MapLibre's worker to the browser; without them the map is a black
rectangle with a clean console. They are documented in `DECISIONS.md` and the
README, and the comments in the source say why. Do not "tidy" them.
