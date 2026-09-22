# Taipei 3D

A 3D map of Taipei built on **GeoLibre 3.0.0**, rendering OpenStreetMap building
footprints as extrusions, with a low-poly tree drawn by three.js. The entire
interface is custom — none of GeoLibre's own UI is used, and no MapLibre controls
are added either.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
```

## Where the behaviour is documented

Each GeoLibre layer, plugin, or extension owns a folder under `src/layers/`, and
its `specs/spec.md` is the source of truth for how it behaves. This README covers
only what sits *between* those layers.

| Layer | Spec | What it covers |
| --- | --- | --- |
| `basemaps` | [`src/layers/basemaps/specs/spec.md`](src/layers/basemaps/specs/spec.md) | the basemap catalogue, the OSM tile source and its required attribution, and the style surgery every GeoLibre layer depends on |
| `buildings` | [`src/layers/buildings/specs/spec.md`](src/layers/buildings/specs/spec.md) | the OSM extrusion record, its settings, the colour ramps, filtering, and stacking |
| `tree` | [`src/layers/tree/specs/spec.md`](src/layers/tree/specs/spec.md) | the three.js custom layer, its GeoLibre external-native contract, and the projection matrix that actually works |

Beyond the specs, `ai/` carries the contributor documentation set — [`DESIGN`](ai/DESIGN.md),
[`ARCHITECTURE`](ai/ARCHITECTURE.md), [`CONVENTIONS`](ai/CONVENTIONS.md),
[`DECISIONS`](ai/DECISIONS.md), [`WORKFLOWS`](ai/WORKFLOWS.md), [`STACK`](ai/STACK.md)
and [`VISUAL_DESIGN`](ai/VISUAL_DESIGN.md). Start at [`ai/README.md`](ai/README.md).

## How GeoLibre is used

GeoLibre publishes its map layer as a **headless** package: `@geolibre/map` is
"data loading, layer synchronization, and the style engine, without React, the
Zustand store, Cesium, or any map controls". That is the half this app uses, so
there is no GeoLibre chrome to strip out — it was never bundled.

Layers are *described*, never imperatively built. Each layer folder turns its
settings into a plain `GeoLibreLayer` record, and `src/lib/useMapEngine.ts` hands
the whole list to one diff-sync:

```ts
const sync = createLayerSync(map);
sync.sync([buildingsLayer(settings), treeLayerRecord(treeSettings)]);
```

Every control in the sidebar works by re-describing the layers and re-syncing.
The three.js tree rides in that same call as the OSM buildings rather than being
bolted on beside GeoLibre — see the tree spec for the contract that allows it.

| Package | Role |
| --- | --- |
| `@geolibre/map` | `createLayerSync`, `installMapTransformCompat` |
| `@geolibre/core` | `DEFAULT_LAYER_STYLE`, the `GeoLibreLayer` / `LayerStyle` types |
| `maplibre-gl` | the renderer GeoLibre drives |
| `three` | draws the tree inside a MapLibre custom layer |

## Interface

Hand-built, no component library: a dark tool UI of a 36px top bar over three
columns — controls left, the map viewport centre with its own icon toolbars and
attribution plate, viewpoints and a live camera readout right. Basemap switch,
extrusion toggle, height exaggeration, opacity, a minimum-height filter, three
height colour ramps plus a flat mode, a three.js panel (mesh toggle, opacity,
height), eight Taipei viewpoints, a layer menu, zoom buttons, a compass that
tracks bearing, and a pitch slider. Every bounded scalar's value is an editable
field, not just a drag. See [`ai/VISUAL_DESIGN.md`](ai/VISUAL_DESIGN.md).

Panel state lives in `App.tsx` and flows one way: state → layer record → `sync()`.
Nothing in the UI reaches for the MapLibre map.

## Two non-obvious build settings

Both live in `vite.config.ts` and `src/lib/useMapEngine.ts`; without them the map
renders as a black rectangle with no error in the console.

1. **`optimizeDeps.exclude: ["maplibre-gl"]`** — MapLibre resolves its worker as a
   sibling of its own module URL. Vite's dependency pre-bundler rewrites the
   module into `.vite/deps` without copying the worker, so the worker 404s in dev
   and no tile is ever parsed.
2. **`config.WORKER_URL`** set from `maplibre-gl-worker.mjs?worker&url`, with
   `worker.format: "es"` — in a production build the worker path is computed
   dynamically, so Rollup emits no worker asset at all. Importing it through Vite
   emits the bundled worker (and the shared chunk it imports) and yields its
   hashed URL.

## Layout

```
src/
  layers/
    basemaps/
      index.ts       basemap catalogue, building-layer suppression, label anchoring
      specs/spec.md
    buildings/
      index.ts       the GeoLibre layer record + colour ramps
      specs/spec.md
    tree/
      index.ts       the GeoLibre record for the three.js layer
      treeLayer.ts   the three.js custom layer + procedural mesh
      specs/spec.md
  lib/
    useMapEngine.ts  map lifecycle, layer sync, camera
    viewpoints.ts    Taipei viewpoints
  ui/
    Panel.tsx        panel card, slider, checkbox row, segmented, badge, stat line
    Compass.tsx      bearing rose
    LayerMenu.tsx    viewport layer-visibility popover
  App.tsx            the interface
  styles.css         the design system
```

Other modules import a layer through its folder (`./layers/tree`), never through
a file inside it.
