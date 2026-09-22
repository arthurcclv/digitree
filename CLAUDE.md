# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

Single Vite + React app (`taipei-3d`), not a monorepo — no workspaces, one
`package.json` at the root. A 3D map of Taipei built on GeoLibre 3.0.0 over
MapLibre, with a three.js custom layer.

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
      index.ts        GeoLibre record (treeLayerRecord), TreeSettings
      treeLayer.ts    ThreeTreeLayer — the MapLibre custom layer + procedural mesh
      specs/spec.md
  lib/              shared engine + config, not layers
    useMapEngine.ts   map lifecycle, GeoLibre layer sync, camera; owns Camera/Viewpoint
    viewpoints.ts     the eight Taipei VIEWPOINTS
  ui/
    Panel.tsx       Panel / Toggle / Slider primitives
    Compass.tsx     bearing rose
  App.tsx           the interface: control state, panel, viewpoints, telemetry
  main.tsx          React root
  styles.css        the design system (all styling lives here; no CSS modules)
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

Commands: `npm run dev` (port 5173), `npm run build`, `npm run preview`. There is
no test runner and no linter configured.

## Documentation

Each package carries its own AI/contributor documentation set under `ai/`
(orientation beyond the spec and the commands here):

- App — `ai/` — `DESIGN.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `DECISIONS.md`, `WORKFLOWS.md`, `STACK.md`. `VISUAL_DESIGN.md`.

The `specs/spec.md` in each `src/layers/<name>/` folder remains the source of
truth for that layer's behavior; the `ai/` docs explain the product, structure,
and process around it.

## Workflow rules

- **Read the relevant spec before changing anything.** The `specs/spec.md` in the layer folder you are touching (`src/layers/<name>/specs/spec.md`) is the source of truth for intended behavior, not just background reading — check the applicable section(s) before touching layer, engine, or app code.
- **Update the spec first, and get approval before implementing.** For any behavior change, write the spec edit describing the new/changed behavior and present it to the user for approval before writing implementation code. Don't code ahead of an approved spec change.
- **Keep the spec consistent with the implementation.** The spec and code must never drift — a diff that changes behavior without a corresponding (approved) spec update is incomplete.
- **Add tests for every new change.** New functionality or bug fixes need a corresponding test (unit, acceptance, WASM-parity, or WebGPU as applicable); don't rely on manual verification alone.
- **Every new layer, plugin, or extension ships a spec.** A new `src/layers/<name>/` folder is incomplete without its `specs/spec.md`, written and approved before the layer's implementation lands.
- **Keep the `ai/` docs current.** Each package's `ai/` set (`DESIGN.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `DECISIONS.md`, `WORKFLOWS.md`, `STACK.md`, and the app's `VISUAL_DESIGN.md`) is orientation, not folklore — it must track the code same as the spec does. A change that alters module structure, adds/reverses a technical decision, introduces a new coding convention, changes a dependency, or (app) changes a color/type/spacing/component rule is incomplete until the matching `ai/` doc is updated in the same change. New decisions append to `DECISIONS.md` (newest at top); don't let a doc silently go stale.
