# CLAUDE.md — `app/`

Guidance for the Vite + React map application. The repo-wide rules live in the
root `CLAUDE.md`; this file covers what is specific to the app.

## What this is

A single Vite + React app (`taipei-3d`) — one `package.json`, no workspaces. A 3D
map of Taipei built on GeoLibre 3.0.0 over MapLibre, with a three.js custom
layer.

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
      index.ts        buildingsLayer() GeoLibre record, BuildingSettings, PALETTES
      specs/spec.md
    tree/
      index.ts        both GeoLibre records (treePointsLayer, treeMeshRecord),
                      TreeSettings
      treeLayer.ts    ThreeTreeLayer — the MapLibre custom layer + instanced mesh
      formGeometry.ts the eight procedural form shapes + the shared materials,
                      and canopyHullOf() — each form's convex canopy hull
      models.ts       FORM_MODELS, the glTF loader, normalizeModel — the other
                      mesh source; interchangeable with formGeometry.ts
      forms.ts        TreeForm, the species -> silhouette table, formOf()
      placement.ts    rotationOf() — each tree's yaw, hashed from its tree_id
      constants.ts    the Martin source contract, shared by the two above
      *.test.ts       vitest, beside the modules they cover
      specs/spec.md
    sunlight/
      index.ts        sunlightRecord() GeoLibre record, SunlightSettings
      sunlightLayer.ts ThreeSunlightLayer — light pass, overlay, probe, export
      sun.ts, state.ts, transmittance.ts, frame.ts, tileGrid.ts, geotiff.ts
                      the pure parts: sun position, state gate, α table,
                      grid/shear maths, tile planning/coverage, GeoTIFF writer
      *.test.ts
      specs/spec.md
    ambient-occlusion/
      index.ts        ambientOcclusionRecord() GeoLibre record,
                      AmbientOcclusionSettings
      aoLayer.ts      ThreeAoLayer — G-buffer, SSAO, blur, multiply composite
      kernel.ts, geometry.ts, state.ts
                      the pure parts: sample kernel + composite factor,
                      tile planning + prism placement, state gate
      *.test.ts
      specs/spec.md
    temperature/
      index.ts        temperatureRecord() GeoLibre record, TemperatureSettings,
                      PET_DEPS
      temperatureLayer.ts ThreeTemperatureLayer — PET overlay drawn from the
                      sunlight textures; probe and export through the LpiField
      pet.ts, state.ts
                      the pure parts: formula + its GLSL form, ramp, comfort
                      classes, state
      *.test.ts
      specs/spec.md
  lib/              shared engine + config, not layers
    useMapEngine.ts   map lifecycle, GeoLibre layer sync, camera; owns Camera/Viewpoint
    viewpoints.ts     the eight Taipei VIEWPOINTS
    dag/              the derived-layer DAG: one layer's output feeding
                      another's (sunlight.lpi → temperature.pet); pure, with
                      its own specs/spec.md
    tiles/            shared by the self-fetching layers (sunlight, AO): z14
                      grid, TileStore (fetch + decode + cache), building
                      prisms, ground footprint; *.test.ts beside them
  ui/
    Panel.tsx       Panel / Toggle / Slider primitives
    Compass.tsx     bearing rose
  App.tsx           the interface: control state, panel, viewpoints, telemetry
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
  (`buildings` imports the OSM tile URL and attribution from `basemaps`). It must
  not reach into another layer's internals.
- `specs/spec.md` is mandatory and must describe the layer's contract with
  GeoLibre, its settings, and its invariants.

### How a layer reaches the map

Settings flow one way: `App.tsx` holds the state → each layer's `index.ts` turns
settings into a `GeoLibreLayer` record → `useMapEngine.ts` passes the records to
GeoLibre's `sync()`. Nothing outside `useMapEngine.ts` and `layers/basemaps`
touches the MapLibre map directly.

Commands (run from `app/`): `npm run dev` (port 5173), `npm run build`,
`npm run preview`, `npm test` (vitest). There is no linter configured.

`npm test` covers only what is pure — the species table, the geometry builders,
`normalizeModel`, the sunlight, temperature and ambient-occlusion layers' pure
modules, the derived-layer DAG, the
shared tile store (on a fake `fetch`) and building prisms, and assertions about
the served model folder itself (every `.glb` is CC-BY, prepared, and credited). There is no jsdom and no headless GL,
so anything needing a map or a GL context — including whether a model actually
loads — is still checked in the browser.

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
  applicable section(s) before touching layer, engine, or app code.
- **Every new layer, plugin, or extension ships a spec.** A new
  `src/layers/<name>/` folder is incomplete without its `specs/spec.md`, written
  and approved before the layer's implementation lands.
- **Tests live beside the code, inside the layer folder** (or beside the
  `src/lib` module they cover). `<module>.test.ts`, not a parallel `test/` tree. A test may import a layer's internals directly —
  the one exception to the `index.ts`-only rule, because it is inside the folder
  rather than reaching into it.
