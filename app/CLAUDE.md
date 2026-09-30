# CLAUDE.md — `app/`

Guidance for the Vite + React map application. The repo-wide rules live in the
root `CLAUDE.md`; this file covers what is specific to the app.

## What this is

A single Vite + React app (`taipei-3d`) — one `package.json`, no workspaces. A 3D
map of Taipei built on GeoLibre 3.0.0 over MapLibre, with four three.js custom
layers (tree meshes, direct sun, felt temperature, ambient occlusion).

**Every GeoLibre layer, plugin, or extension gets its own folder under
`src/layers/<name>/`, and every such folder carries a `specs/spec.md`.** That
spec is the source of truth for the layer's behaviour. Adding a new layer means
adding a new folder with a spec, not a new file in `src/lib`.

```
index.html          Vite entry
vite.config.ts      React plugin + the two MapLibre worker settings (see README)
tsconfig.json       TS project refs; `tsc -b` runs in `npm run build`
src/
  layers/           one folder per GeoLibre layer / plugin / extension
    basemaps/
      index.ts        basemap catalogue, OSM tiles + attribution, basemap
                      building suppression, label anchoring
      specs/spec.md
    buildings/
      index.ts        buildingsLayer(settings, source) GeoLibre record,
                      BuildingSettings, PALETTES
      schema.ts       BuildingSource; the OSM building rule in both forms
                      (MapLibre filter + buildingHeight), buildingTiles()
      specs/spec.md
    tree/
      index.ts        TreeSettings; the folder's entry, re-exporting the rest
      records.ts      both GeoLibre records (treePointsLayer, treeMeshRecord)
      mount.ts        mountTree() — the layer attached to any GeoLibre map
      treeLayer.ts    ThreeTreeLayer — the MapLibre custom layer + instanced mesh
      formGeometry.ts the eight procedural form shapes + the shared materials,
                      and canopyHullOf() — each form's convex canopy hull
      models.ts       FORM_MODELS, the glTF loader, normalizeModel — the other
                      mesh source; interchangeable with formGeometry.ts
      forms.ts        TreeForm, the species -> silhouette table, formOf()
      placement.ts    rotationOf() — each tree's yaw, hashed from its tree_id
      schema.ts       TreeSource; treeOf() — the one reading of a tree,
                      shared by the meshes and the direct-sun layer;
                      treeTiles()
      constants.ts    the record ids and MODELS_ATTRIBUTION
      *.test.ts       vitest, beside the modules they cover
      specs/spec.md
    sunlight/
      index.ts        SunlightSettings (the moment is the host's); the entry
      records.ts      sunlightRecord() GeoLibre record
      mount.ts        mountSunlight() — adds the sunlight.lpi node
      sunlightLayer.ts ThreeSunlightLayer — light pass, overlay, probe,
                      export, and the USD export pass over any square
      occluders.ts    placed crowns/prisms/footprints/coverage and their
                      scenes: the display's set, or an export pass's own
      sun.ts, state.ts, transmittance.ts, frame.ts, tileGrid.ts, geotiff.ts,
      ramp.ts, nearGrid.ts
                      the pure parts: sun position, state gate, α table,
                      grid/shear maths, tile planning/coverage, GeoTIFF
                      writer, the ramp table + its CPU twin
      *.test.ts
      specs/spec.md
    ambient-occlusion/
      index.ts        AmbientOcclusionSettings; the entry
      records.ts      ambientOcclusionRecord() GeoLibre record
      mount.ts        mountAmbientOcclusion()
      aoLayer.ts      ThreeAoLayer — G-buffer, SSAO, blur, multiply composite
      kernel.ts, geometry.ts, state.ts
                      the pure parts: sample kernel + composite factor,
                      tile planning + prism placement, state gate
      *.test.ts
      specs/spec.md
    temperature/
      index.ts        TemperatureSettings; the entry
      records.ts      temperatureRecord() GeoLibre record
      mount.ts        mountTemperature(), PET_DEPS — adds temperature.pet
                      after sunlight.lpi
      temperatureLayer.ts ThreeTemperatureLayer — PET overlay drawn from the
                      sunlight textures; probe and export through the LpiField
      pet.ts, state.ts
                      the pure parts: formula + its GLSL form, ramp, comfort
                      classes, state
      *.test.ts
      specs/spec.md
  lib/              shared engine + config, not layers
    useMapEngine.ts   the host: map lifecycle, the mounts, GeoLibre layer
                      sync, camera; owns Camera, starts at PLACE.home
    place/            Place, Viewpoint, local time at a fixed UTC offset —
                      generic; its own specs/spec.md
    mount/            LayerMount — how a layer with a custom half attaches
                      to any GeoLibre map; nativeLayer, fakeMap (tests); its
                      own specs/spec.md
    three/            ThreeLayer — the base of every three.js custom layer:
                      renderer lifecycle, resetState around each pass,
                      mainMatrix projection; its own specs/spec.md
    dag/              the derived-layer DAG: one layer's output feeding
                      another's (sunlight.lpi → temperature.pet); pure, with
                      its own specs/spec.md
    tiles/            shared by the self-fetching layers (sunlight, AO): z14
                      grid, TileStore (generic over its sources: fetch +
                      decode + cache), settle (wait for a store of your
                      own), building prisms, ground footprint; the
                      data-sources specs/spec.md; *.test.ts beside them
    usd/              the USD export's shared writer: .usda text, stored
                      zip + .usdz, ExportFrame, ground/raster packages, the
                      root layer; knows no layer; its own specs/spec.md.
                      Each participating layer adds a usd.ts (buildings,
                      tree, sunlight, temperature, basemaps)
    sceneExport.ts    the host's scene-export rules: its participants in
                      stack order, and when it may start (pure, tested)
    colour.ts         hex → sRGB, sRGB → linear, a ramp of stops: shared by
                      the layers' ramps and src/lib/usd (pure, tested)
  ui/
    Panel.tsx       Panel / Toggle / Slider primitives
    Compass.tsx     bearing rose
    cameraReadout.ts  the status bar's lat/lon/zoom formatting (pure, tested)
  App.tsx           the interface: control state, panel, status bar, telemetry
  sources.ts        the app's datasets (TREES, BUILDINGS) — the only place
                    an endpoint lives; layers take them as descriptors
  place.ts          the app's PLACE (Taipei, UTC+8, the Xinyi home view) —
                    with sources.ts, the only place the city is named
  main.tsx          React root
  styles.css        the design system (all styling lives here; no CSS modules)
public/             copied verbatim by Vite, never imported
  models/trees/     17 CC BY glTF tree models, each at every rung of the
                    detail ladder (<name>.glb, <name>.L1.glb, ...), Git LFS,
                    + CREDITS.md
tools/
  prepare-tree-models.py
                    texture downscale + WebP re-encode; run out of band, not
                    part of npm. See ai/WORKFLOWS.md
dist/               build output (gitignored)
```

### Rules for a layer folder

- `index.ts` is the only entry other modules import (`../layers/tree`, never
  `../layers/tree/treeLayer`). Split into more files inside the folder freely.
- A layer folder may import from `src/lib` and from another layer's `index.ts`
  (`sunlight` imports `treeTiles` and `canopyHullOf` from `tree`). It must not
  reach into another layer's internals.
- `specs/spec.md` is mandatory and must describe the layer's contract with
  GeoLibre, its settings, and its invariants.
- A layer with a custom half keeps its record builders in `records.ts` and its
  mount in `mount.ts`. `mount.ts` imports only *types* from `index.ts`, so the
  two never form a module cycle. tsc will not catch one; `lib/mount/structure.test.ts`
  fails on any runtime import cycle in `src/`.

### Portability rules — every layer must stay runnable in any GeoLibre host

Each layer folder can be lifted into another GeoLibre application: the host
mounts it, passes it descriptors, and knows nothing else about it. These rules
keep it that way. Each names its contract and, where there is one, the test
that guards it. **A failing guard means the change is wrong, not the test:
loosening or exempting a guard is a spec change, and needs approval like any
other.**

1. **Nothing layer-specific lives in the host.** Construction, the paint
   bridge, re-adding after `style.load`, pushing non-GeoLibre settings,
   visibility and demand, and teardown all live in the layer's `mount.ts`
   (`src/lib/mount/specs/spec.md`). `useMapEngine` only chooses which layers,
   their mount and stack order, and what the UI does with status, probes and
   exports. A new `useEffect` in the host that calls a setter on one layer is
   the pattern this rule forbids. *Guards: `lib/mount/structure.test.ts` (the
   host imports no layer class, DAG node or deps, calls no `addLayer`, paint
   bridge or `graph.add`, and its runtime imports from layers are an
   allowlist), and each mount test's "exposes exactly its members", so a
   mount cannot grow a setter without a spec change.*
2. **The host applies every `update` before any `prepareSync`, mounts in
   dependency order, and disposes in reverse.** One layer's settings can change
   another's records through DAG demand (temperature's `visible` makes
   sunlight's record visible). *Guard: `temperature/mount.test.ts`.*
3. **Layers talk only through the DAG, value and state alike.** A layer never
   holds a reference to another, and the host never forwards one layer's
   status to another (`src/lib/dag/specs/spec.md`). A derived layer adds its
   own node in its mount. *Guards: `temperature/mount.test.ts` ("follows the
   direct-sun state through the DAG alone"), and rule 1's guards, which leave
   the host no setter to forward through. Passing one mount's `probe` result
   into another's `update` is still possible and is caught only by review.*
4. **No layer holds an endpoint.** Where a dataset is served is a descriptor
   (`TreeSource`, `BuildingSource`) passed in by the host. The app's values live
   only in `src/sources.ts` (`src/lib/tiles/specs/spec.md`). *Guard:
   `lib/tiles/structure.test.ts`.*
5. **One reading per dataset, in its owner's `schema.ts`.** `treeOf` is the only
   reading of a tree. The buildings rule keeps its MapLibre form and its JS form
   (`buildingHeight`, `meetsMinHeight`) side by side. A new consumer reuses
   these and never re-reads properties by hand. *Guard:
   `buildings/schema.test.ts` evaluates the filter with MapLibre's own
   `featureFilter`.*
6. **A layer's interface is in its own terms, never another layer's settings.**
   What it needs from a sibling is a type it owns (AO's `ShadedExtrusion`),
   which the host maps onto. It may read a sibling's *data* through that
   sibling's schema. *Guard: `lib/mount/structure.test.ts`: no layer imports
   another layer's `…Settings` type.*
7. **Every three.js layer extends `ThreeLayer`** (`src/lib/three/specs/spec.md`).
   It never makes a renderer, calls `resetState`, or reads `mainMatrix` itself,
   and it wraps its drawing in `pass`. It declares `prerender` only when it has
   offscreen work, because MapLibre gives any layer with one an offscreen pass.
   *Guard: `lib/tiles/structure.test.ts`, plus each layer's mount test.*
8. **No layer or shared module names the city.** Time zone, home view and
   daylight range are `PLACE` in `src/place.ts`; record names and dataset facts
   (such as the fallback tree height) are descriptor fields
   (`src/lib/place/specs/spec.md`). *Guard: `lib/tiles/structure.test.ts`.*
9. **The shared modules (`src/lib/tiles`, `mount`, `dag`, `three`, `place`,
   `usd`, and the single-file `colour.ts` and `sceneExport.ts`) import
   nothing from `src/layers/`.** `useMapEngine.ts` is the one exception,
   because it is the host. *Guard: `lib/tiles/structure.test.ts`.*

Moving the app to another city should touch `src/sources.ts` and
`src/place.ts`, and nothing under `src/layers/` or `src/lib/`. If a change
needs more than that, it is breaking one of these rules. The known exception
is the species tables (`tree/forms.ts`, `sunlight/transmittance.ts`); see the
place spec, *Out of scope*.

### How a layer reaches the map

Settings flow one way: `App.tsx` holds the state → `useMapEngine.ts` hands
each layer's mount its settings (`update`) → each mount returns its
`GeoLibreLayer` records (`prepareSync`) → `useMapEngine.ts` passes them to
GeoLibre's `sync()` (skipped when the records are unchanged). Only
`useMapEngine.ts`, the mounts (for their own custom layer) and `layers/basemaps`
touch the MapLibre map directly.

Commands (run from `app/`): `npm run dev` (port 5173), `npm run build`,
`npm run preview`, `npm test` (vitest). There is no linter configured.

`npm test` covers what runs without a map or a GL context:
- the species table, the geometry builders and `normalizeModel`;
- the pure modules of the sunlight, temperature and ambient-occlusion layers;
- the derived-layer DAG and the local-time helpers;
- each layer's mount, on the fake map in `src/lib/mount/fakeMap.ts`, which
  never calls `onAdd`;
- `ThreeLayer`'s lifecycle, on a fake renderer;
- the tile store (on a fake `fetch`) and building prisms;
- the schemas, with MapLibre's own filter evaluator;
- the USD writers (`.usda`, zip, `.usdz`, the frame, the root) and each
  layer's USD package, built from fake features;
- assertions about the source tree itself (`lib/tiles/structure.test.ts`,
  the guards for the portability rules above);
- assertions about the served model folder (every `.glb` is CC-BY, prepared,
  and credited).

There is no jsdom and no headless GL. So anything needing a real map or GL
context, including whether a model actually loads or a pass still draws the
same pixels, is checked in the browser. For a change to a GL pass, compare a
GeoTIFF export or a screenshot against the previous commit. Two runs are only
comparable when they settled on the same occluder count, which varies between
runs (`ai/DECISIONS.md`).

## Documentation

The app carries its own AI/contributor documentation set under `ai/`
(orientation beyond the spec and the commands here): `DESIGN.md`,
`ARCHITECTURE.md`, `CONVENTIONS.md`, `DECISIONS.md`, `WORKFLOWS.md`, `STACK.md`,
`VISUAL_DESIGN.md`. Start at `ai/README.md`.

The `specs/spec.md` in each `src/layers/<name>/` folder remains the source of
truth for that layer's behavior; the `ai/` docs explain the product, structure,
and process around it. A change that changes a color, type, spacing, or
component rule is incomplete until `ai/VISUAL_DESIGN.md` is updated with it.

## Workflow rules

The root `CLAUDE.md` carries the repo-wide rules (spec first and approved, no
drift, tests, docs current). These are the app's own:

- **Read the relevant spec before changing anything.** The `specs/spec.md` in the
  layer folder you are touching (`src/layers/<name>/specs/spec.md`) is the source
  of truth for intended behavior, not just background reading — check the
  applicable section(s) before touching layer, engine, or app code. The shared
  contracts are specs too, and a layer change usually touches one:
  `src/lib/mount` (how a layer attaches), `dag` (how layers feed each other),
  `tiles` (data sources and schemas), `three` (the GL rules) and `place` (what
  the app knows about where it is).
- **Every new layer, plugin, or extension ships a spec.** A new
  `src/layers/<name>/` folder is incomplete without its `specs/spec.md`, written
  and approved before the layer's implementation lands.
- **Tests live beside the code, inside the layer folder** (or beside the
  `src/lib` module they cover). `<module>.test.ts`, not a parallel `test/` tree. A test may import a layer's internals directly —
  the one exception to the `index.ts`-only rule, because it is inside the folder
  rather than reaching into it.
