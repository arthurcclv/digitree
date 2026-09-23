# STACK — dependencies and what they are for

Every dependency is here on purpose; this file records the purpose. Adding or
removing one means editing this file in the same change (and usually
`DECISIONS.md` too).

## Runtime dependencies

| Package | Version | Role |
| --- | --- | --- |
| `@geolibre/map` | `3.0.0` (pinned) | `createLayerSync`, `installMapTransformCompat` — the headless half of GeoLibre |
| `@geolibre/core` | `3.0.0` (pinned) | `DEFAULT_LAYER_STYLE`, the `GeoLibreLayer` / `LayerStyle` types, `setExternalNativePaintBridge` / `clearExternalNativePaintBridge` |
| `maplibre-gl` | `^6.7.0` | the renderer GeoLibre drives; also `MercatorCoordinate`, `CustomLayerInterface` |
| `three` | `^0.186.0` | draws the tree inside a MapLibre custom layer |
| `react` / `react-dom` | `^19.2.0` | the chrome |

The two GeoLibre packages are **pinned exactly**. They are the subject of the
app, their external-native path is the seam the tree depends on, and
`BUILDINGS_STYLE_LAYER_IDS` encodes their layer-id naming
(`layer-<id>-vector-extrusion`). A minor bump is a deliberate migration, not a
`^` away.

`maplibre-gl` is a major-version-sensitive dependency for a different reason:
v6 changed the custom-layer render signature to `render(gl, options)`. See the
projection-matrix entry in `DECISIONS.md` before upgrading.

## Dev dependencies

| Package | Version | Role |
| --- | --- | --- |
| `vite` | `^7.1.0` | dev server and bundler |
| `@vitejs/plugin-react` | `^5.0.0` | Fast Refresh, JSX transform |
| `typescript` | `~5.9.0` | `tsc -b` in the build; tilde-pinned |
| `@types/react`, `@types/react-dom` | `^19.2.0` | |
| `@types/three` | `^0.186.0` | kept in lockstep with `three` |
| `vitest` | `^5.0.1` | `npm test`; runs the tree layer's form tests under Vite's own transform |

## Not used, deliberately

- **No GeoLibre React bindings, Zustand store, or Cesium.** `@geolibre/map` is
  published as the headless half — "data loading, layer synchronization, and the
  style engine" — and that is the half being demonstrated. There is no GeoLibre
  chrome to strip out; it was never bundled.
- **No MapLibre controls.** `attributionControl: false`; the status bar carries
  attribution instead. No `NavigationControl` — the zoom buttons, the compass and
  the pitch slider are hand-built.
- **No UI or component library, no CSS framework, no CSS-in-JS.** All styling is
  in `src/styles.css`.
- **No state manager, no router, no data-fetching library.** Control state is
  `useState` in `App.tsx`, and the app still makes **no `fetch()` call of its
  own** — all network traffic is tiles. The tree layer's 3D half reads back the
  vector tiles MapLibre already parsed (`querySourceFeatures`) rather than
  fetching anything, which is what keeps that true now that the app has a
  backend.
- **No linter, no formatter, no CI.** `npm run build` and `npm test` are the
  gates. A test runner *is* now configured — `vitest`, added with the tree form
  classes; see `DECISIONS.md`. It was chosen for costing nothing: it reuses the
  Vite config and needs no DOM, because what it tests is pure.
- **No jsdom, no browser-mode runner, no headless GL.** The tests cover the
  parts that can be tested without a map — the species table and the geometry
  builders. Anything needing a GL context or a live MapLibre map is still
  verified in the browser, and `WORKFLOWS.md` says so.

## External services

| Service | Used for | Key required |
| --- | --- | --- |
| OpenFreeMap — `https://tiles.openfreemap.org/planet` | OSM vector tiles, OpenMapTiles schema, both basemap and `building` source layer | no |
| OpenFreeMap styles — `/styles/{dark,fiord,liberty,positron}` | the four basemaps | no |
| Martin — `/tiles/trees/{z}/{x}/{y}`, proxied to `localhost:3000` | Taipei's tree inventory as MVT, from the PostGIS stack in `infra/` | no |

Martin is **local and optional**: it is not a deployed service but a container
started with `infra/load.sh`, and the app runs without it — the tree layers
simply render nothing. It is reached through a Vite dev proxy so tile requests
stay same-origin; see `src/layers/tree/specs/spec.md` for why the layer uses
`source.tiles` rather than Martin's own TileJSON.

**No web fonts.** The interface uses the system stack (`-apple-system`,
`BlinkMacSystemFont`, Segoe UI, Roboto, with PingFang TC / Microsoft JhengHei
named explicitly for zh-TW), so tiles are the only third-party request the app
makes.

No API keys, no registration, no `.env`. Two attributions are required and both
are rendered by the status bar: `© OpenStreetMap contributors · OpenMapTiles ·
OpenFreeMap` for the basemap and buildings, and Taipei City's for the tree
inventory.

## Build configuration

`vite.config.ts` carries three settings that exist only to get MapLibre's worker
to the browser — `optimizeDeps.exclude: ["maplibre-gl"]`, `worker.format: "es"`,
and `resolve.dedupe: ["maplibre-gl", "react", "react-dom"]` — paired with
`maplibreConfig.WORKER_URL` at module scope in `useMapEngine.ts`. Without them
the map renders as a black rectangle with no console error. Full reasoning in
`DECISIONS.md`.

`tsconfig.json`: ES2022 target, `bundler` module resolution, `strict`,
`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
`isolatedModules`, `noEmit`. `tsc -b` writes `tsconfig.tsbuildinfo`.

Dev server port is 5173. Build output is `dist/` (gitignored).
