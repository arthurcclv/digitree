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
App.tsx                 state + chrome          (knows settings, not MapLibre)
  ↓ settings objects
layers/<name>/index.ts  description             (knows GeoLibre, not MapLibre*)
  ↓ GeoLibreLayer records
lib/useMapEngine.ts     the only map owner      (knows MapLibre)
```

\* `layers/basemaps` is the deliberate exception — it is an *extension*, not a
layer, and it does touch the map (see below).

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

// useMapEngine.ts — applyLayers()
sync.sync([
  buildingsLayer(settings),
  ambientOcclusionRecord(ao, settings), // shown only while the buildings are
  sunlightRecord(sun, graph.demanded(LPI_NODE)), // fetches its own tiles; shares no source
  temperatureRecord(temp),      // derives from sunlight through the DAG
  treePointsLayer(treeSettings),
  treeMeshRecord(treeSettings),
]);
```

Every control is a `setState`. React re-renders, the effect in `useMapEngine`
re-runs `applyLayers`, the layer records are rebuilt from scratch, and
`createLayerSync` diffs them against what is on the map. There is no imperative
path from a control to a style property, and no state lives in the map that is
not derivable from `App.tsx`.

`settingsRef`/`treeSettingsRef`/`sunlightSettingsRef`/`aoSettingsRef`/`temperatureSettingsRef` exist only so that `applyLayers` can stay a
stable `useCallback` and still be called from the `style.load` handler, which was
registered once at map creation.

## Who may touch the MapLibre map

Exactly two places:

1. **`lib/useMapEngine.ts`** — constructs the map, owns the style-load lifecycle,
   drives the camera, holds the `LayerSync`, the derived-layer `Graph`, and the
   `ThreeTreeLayer`, `ThreeSunlightLayer`, `ThreeTemperatureLayer` and
   `ThreeAoLayer` instances.
2. **`layers/basemaps/index.ts`** — `hideBasemapBuildings`, `firstLabelLayerId`,
   `anchorUnderLabels`. These are style surgery, not layer description, and they
   are called *by* `useMapEngine`.

The four custom-layer classes, `ThreeTreeLayer`, `ThreeSunlightLayer`,
`ThreeTemperatureLayer` and `ThreeAoLayer`, are handed the map by MapLibre in `onAdd` and use it only for
what a custom layer needs: the camera, repaints, and — for the two
self-fetching layers — `idle` and `unproject`, to replan their tiles when the
view settles. They are constructed and added by
`useMapEngine`, never by anything else.

Nothing in `App.tsx`, `ui/`, or the other layer folders imports `maplibre-gl`.

## Layer folder rules

- `index.ts` is the only entry other modules import (`../layers/tree`, never
  `../layers/tree/treeLayer`). Split freely *inside* the folder.
- A folder may import from `src/lib` and from another layer's `index.ts`
  (`buildings` imports `OSM_TILEJSON` and `OSM_ATTRIBUTION` from `basemaps`). It
  must not reach into another folder's internals.
- `specs/spec.md` is mandatory.

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
dependent owns one downstream of it (`temperature.pet`). The engine creates
the one graph per map, adds the nodes in dependency order, and hands the graph
to each layer's constructor; the two layers never hold a reference to each
other. Publishing a node notifies everything downstream. Demand flows the other
way: a shown dependent makes its upstream compute even when that upstream's own
overlay is hidden. Because MapLibre runs no `prerender` for a hidden layer, a
record's visibility is whether its node is *demanded*, and the overlay's drawn
visibility is set on the layer by the engine, not through the paint bridge.

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
(`src/lib/tiles`), from the same two endpoints, and depends on no other layer
being shown. The ambient-occlusion layer fetches the building tiles the same
way, into a buildings-only store of its own, because MapLibre's depth buffer
cannot be sampled and it must redraw the buildings itself.

**`src/lib/tiles` is shared, not a layer.** It holds what both self-fetching
layers need: the z14 grid and Mercator formulas (`grid.ts`), the `TileStore`
(`store.ts` — fetch, decode with `@mapbox/vector-tile`, LRU cache, with a
per-source switch), per-tile building triangulation and placement
(`prisms.ts`), and the viewport's ground footprint (`footprint.ts`). Each layer
holds its own store instance; the browser's HTTP cache answers the second
request for a building tile. It imports the tile URLs from the `tree` and
`basemaps` index files, as the layers did.

`tree` is the one folder with a real internal split, and the split is by
dependency rather than by topic:

| Module | Owns | Imports three.js |
| --- | --- | --- |
| `index.ts` | the two GeoLibre records, `TreeSettings` | no |
| `constants.ts` | the Martin source contract | no |
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
| `index.ts` | the GeoLibre record, `SunlightSettings`, Taipei-time helpers | no |
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
`rotationOf`, and the tree source's URL and bounds (`TREES_TILES`,
`TREES_BOUNDS`), all from the tree's `index.ts`. So the shadow and the drawn
tree share a shape and a facing, and nothing else of the tree layer's internals
is reached.

`temperature` has the same split, smaller, since it computes nothing of its own:

| Module | Owns | Imports three.js |
| --- | --- | --- |
| `index.ts` | the GeoLibre record, `TemperatureSettings`, `PET_DEPS`, `PET_PARAM_RANGES` | no |
| `pet.ts` | `PET_NODE`, `PetField`, the formula (`PET_COEFFS`, `petOf`, `petGlsl`), the ramp, `classOf`, `petProbeOf` | **no** |
| `state.ts` | `TemperatureState`, `temperatureState()` | **no** |
| `temperatureLayer.ts` | `ThreeTemperatureLayer` — the overlay, and probe and export through the `LpiField` | yes |

The shader's PET expression is generated by `petGlsl()` from the same
coefficient table as `petOf`, so the GPU and CPU forms cannot drift.

`ambient-occlusion` has the same split:

| Module | Owns | Imports three.js |
| --- | --- | --- |
| `index.ts` | the GeoLibre record, `AmbientOcclusionSettings` | no |
| `state.ts` | `AoState`, `AO_MIN_ZOOM`, `aoState()` | **no** |
| `kernel.ts` | the hemisphere kernel, the 4 × 4 rotation tile, `compositeFactor` | **no** |
| `geometry.ts` | tile planning, prism placement with exaggeration and the min-height filter | **no** |
| `aoLayer.ts` | `ThreeAoLayer` — G-buffer, AO, blur, composite | yes |

It reads the buildings' `heightScale` and `minHeight` (set on it by
`useMapEngine`), so its redrawn prisms match the extrusions; it reaches
nothing of the `buildings` folder but the settings type.

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
  → hideBasemapBuildings(map)          // kill the basemap's own buildings
  → re-add ThreeTreeLayer if missing   // sync only *moves* native layers
  → re-add ThreeSunlightLayer if missing
  → re-add ThreeTemperatureLayer if missing
  → re-add ThreeAoLayer if missing
  → map.setLight(...)                  // tolerated to throw
  → applyLayers()                      // overlay visibility → demand, then
                                       // sync([buildings, ao, sunlight, temperature, tree…]) + re-anchor
  → setReady(true)
```

`styleReadyRef` exists because `map.isStyleLoaded()` stays false until every
source settles, long after the style is usable; syncing on that signal would be
needlessly late.

The `ThreeTreeLayer` *instance* deliberately outlives style changes — `onAdd`
keeps the existing `WebGLRenderer` when the GL context is unchanged, `onRemove`
drops only the map reference, and `dispose` is for map teardown only.

## The three.js seam

The tree is not a sibling of the map; it is a member of the layer list. The
record's `metadata` opts into GeoLibre's external-native path:

```ts
metadata: { customLayerType: "threejs", nativeLayerIds: [...], paintMode: "plugin" }
```

On that path GeoLibre only **moves and shows** the named native layer — it does
not create it and does not paint it. Opacity and visibility reach three.js
through `setExternalNativePaintBridge(TREE_LAYER_ID, { setOpacity, setVisibility })`,
registered once per map in `useMapEngine` and cleared on teardown. Height is not
a GeoLibre concept, so `setHeight` is driven directly by an effect in
`useMapEngine`. Full contract: `src/layers/tree/specs/spec.md`.

The sunlight overlay is a second member on the same path, with its own paint
bridge (`SUNLIGHT_LAYER_ID`) and its own `WebGLRenderer` on the shared context.
It also uses MapLibre's `prerender` hook — the offscreen pass — for its light
pass and for every readback (probe, export), so no GL work of its own ever runs
between MapLibre's draws. The sun time is driven by an effect, like height.

The temperature overlay is a fourth member, with its own paint bridge
(`TEMPERATURE_LAYER_ID`, opacity only) and its own `WebGLRenderer`. Its
`prerender` only publishes its DAG node; `render` draws the PET quad from the
sunlight textures. `G0`, `Ta` and `V` reach it through `setParams`, driven by
an effect, and the sunlight state through `setUpstreamState`, from the sunlight
layer's `onStatus`.

The ambient-occlusion layer is a third member, with its own paint bridge
(`AO_LAYER_ID`, visibility only). Its G-buffer, AO and blur passes run in
`prerender`; `render` only multiplies the result over the frame. Intensity,
radius and the buildings' exaggeration and filter reach it through
`setParams`, driven by an effect.

## Module inventory

| Module | Owns |
| --- | --- |
| `src/main.tsx` | React root, `StrictMode`, imports `styles.css` |
| `src/App.tsx` | all control state, the chrome, the status bar, telemetry |
| `src/lib/useMapEngine.ts` | map lifecycle, layer sync, the DAG and its nodes, camera, the probe clicks and export hand-offs; exports `Camera`, `Viewpoint`, `HOME`; keeps `flyTo` / `setPitch` with no caller yet |
| `src/lib/dag/` | the derived-layer DAG (`createGraph`): nodes, publish/clear, demand; pure, with its own spec |
| `src/lib/tiles/` | the self-fetching layers' shared tile grid, `TileStore`, building prisms and ground footprint |
| `src/ui/Panel.tsx` | `Panel` / `Slider` / `CheckboxRow` / `Segmented` / `Badge` / `Spinner` / `StatLine` primitives — presentational only |
| `src/ui/cameraReadout.ts` | the status bar's coordinate and zoom formatting; pure, tested |
| `src/ui/Compass.tsx` | bearing rose, inline SVG, click resets north |
| `src/ui/LayerMenu.tsx` | the viewport's layer-visibility popover; owns only its own open/closed state |
| `src/styles.css` | the entire design system; no CSS modules, no styled-components |

`Viewpoint` and `HOME` live in `useMapEngine.ts` because the engine is what
consumes them: `HOME` is the initial camera, and `flyTo` takes a `Viewpoint`.

## Build-time coupling

Two settings in `vite.config.ts` plus one line in `useMapEngine.ts` exist solely
to get MapLibre's worker to the browser; without them the map is a black
rectangle with a clean console. They are documented in `DECISIONS.md` and the
README, and the comments in the source say why. Do not "tidy" them.
