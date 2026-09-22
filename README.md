# Taipei 3D

A 3D map of Taipei built on **GeoLibre 3.0.0**, rendering OpenStreetMap building
footprints as extrusions. The entire interface is custom — none of GeoLibre's own
UI is used, and no MapLibre controls are added either.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
```

## How GeoLibre is used

GeoLibre publishes its map layer as a **headless** package: `@geolibre/map` is
"data loading, layer synchronization, and the style engine, without React, the
Zustand store, Cesium, or any map controls". That is the half this app uses, so
there is no GeoLibre chrome to strip out — it was never bundled.

The app describes the buildings as a plain GeoLibre layer record
(`src/lib/buildings.ts`) and hands it to GeoLibre's layer sync:

```ts
const sync = createLayerSync(map);
sync.sync([buildingsLayer(settings)]);   // diff-synced on every control change
```

GeoLibre reads that description and materialises the MapLibre `fill-extrusion`
style layer, its paint properties, and its filters. Every control in the sidebar
works by re-describing the layer and re-syncing — the app never calls
`map.addLayer` or `setPaintProperty` for the buildings itself.

| Package | Role |
| --- | --- |
| `@geolibre/map` | `createLayerSync`, `installMapTransformCompat` |
| `@geolibre/core` | `DEFAULT_LAYER_STYLE`, the `GeoLibreLayer` / `LayerStyle` types |
| `maplibre-gl` | the renderer GeoLibre drives |

## Data

Both the basemap and the buildings come from one OSM snapshot served by
[OpenFreeMap](https://openfreemap.org) (OpenMapTiles schema, no API key). The
`building` source layer carries `render_height`, which drives the extrusion
height, and `hide_3d`, which is filtered out.

The basemaps ship their own flat building layers; those are hidden on
`style.load` so GeoLibre owns the building rendering outright.

Attribution is required and is rendered in the custom status bar rather than by
MapLibre's default control.

## Interface

Hand-built, no component library. Basemap switch, extrusion toggle, height
exaggeration, opacity, a minimum-height filter, three height colour ramps plus a
flat mode, seven Taipei viewpoints, a pitch rail, zoom pads, a compass that
tracks bearing, and a live telemetry strip.

Buildings draw **above** the basemap labels by default — labels styled for a dark
ground are unreadable over lit building faces. The *Labels over* toggle puts them
back underneath.

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
  lib/
    basemaps.ts      basemap catalogue, building-layer suppression, label anchoring
    buildings.ts     the GeoLibre layer record + colour ramps
    useMapEngine.ts  map lifecycle, layer sync, camera
    viewpoints.ts    Taipei viewpoints
  ui/
    Panel.tsx        panel shell, toggle, slider
    Compass.tsx      bearing rose
  App.tsx            the interface
  styles.css         the design system
```
