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
| `three` | `^0.186.0` | draws the trees inside a MapLibre custom layer; `examples/jsm` supplies `mergeGeometries`, the `ConvexGeometry` the canopy hulls are built with, and the `GLTFLoader` the modelled mesh source uses |
| `react` / `react-dom` | `^19.2.0` | the chrome |
| `@mapbox/vector-tile` | `^3.0.0` | decodes the MVT tiles the sunlight layer fetches for itself; the same decoder MapLibre uses internally, which does not export it |
| `pbf` | `^5.1.2` | the protobuf reader `@mapbox/vector-tile` reads through |
| `@sparkjsdev/spark` | `2.3.1` (pinned) | draws the Gaussian splat captures (`SparkRenderer`, `SplatMesh`); peer `three >= 0.180`, deduped onto the app's one copy. Imported dynamically, so it is its own ~2.6 MB chunk, fetched only when a capture is due to load |

The two GeoLibre packages are **pinned exactly**. They are the subject of the
app, their external-native path is the seam the tree depends on, and
`BUILDINGS_STYLE_LAYER_IDS` encodes their layer-id naming
(`layer-<id>-vector-extrusion`). A minor bump is a deliberate migration, not a
`^` away.

Spark is **pinned exactly** too. The splat layer reads its shader's
assumptions (view space, focal length from `P[0][0]`/`P[1][1]`, a `w` row of
`(0, 0, −1, 0)`) through `decomposeCamera`; a new Spark is re-checked in the
browser against `src/layers/splat/specs/spec.md` before it lands.

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
| `@gltf-transform/cli` | `^4.5.0` | meshoptimizer `weld` + `simplify`, driven by `tools/prepare-tree-models.py` to build each rung of a model's detail ladder (`<name>.L1.glb` and up). Build-time only — nothing imports it |
| `@types/node` | `^26.6.2` | `node:fs` in `models.test.ts`, which asserts against the real `public/models/trees/` rather than against a module's claims about it |
| `vitest` | `^5.0.1` | `npm test`; runs the tree layer's form tests under Vite's own transform |
| `@maplibre/maplibre-gl-style-spec` | `26.4.4` (exact) | `featureFilter` in `buildings/schema.test.ts`, which evaluates the extrusion's filter the way MapLibre does, against `buildingHeight`. Already installed as `maplibre-gl`'s own dependency; declared so the test doesn't rely on hoisting. Pinned to the version `maplibre-gl` resolves, and must move with it |

## Not used, deliberately

- **No GeoLibre React bindings, Zustand store, or Cesium.** `@geolibre/map` is
  published as the headless half — "data loading, layer synchronization, and the
  style engine" — and that is the half being demonstrated. There is no GeoLibre
  chrome to strip out; it was never bundled.
- **No MapLibre controls.** `attributionControl: false`; the attribution plate
  over the map carries it instead. No `NavigationControl` — the zoom buttons, the
  compass and the status bar's coordinate readout are hand-built.
- **No UI or component library, no CSS framework, no CSS-in-JS.** All styling is
  in `src/styles.css`.
- **No state manager, no router, no data-fetching library.** Control state is
  `useState` in `App.tsx`. The app makes **no `fetch()` call of its own by
  default** — all network traffic is tiles. The tree layer's 3D half reads back
  the vector tiles MapLibre already parsed (`querySourceFeatures`) rather than
  fetching anything. There are two opt-in exceptions:
  - the **modelled** mesh source makes `GLTFLoader` fetch eight files from the
    app's own `public/`;
  - the **direct-sun overlay** fetches its own z14 tree and building tiles,
    with plain `fetch`, because it needs ground MapLibre never loads.

  Neither needed a data-fetching library.
- **No linter, no formatter, no CI.** `npm run build` and `npm test` are the
  gates. A test runner *is* now configured — `vitest`, added with the tree form
  classes; see `DECISIONS.md`. It was chosen for costing nothing: it reuses the
  Vite config and needs no DOM, because what it tests is pure.
- **No glTF pipeline in the build.** The models under `public/models/trees/` are
  prepared once, out of band, by `tools/prepare-tree-models.py` — Python and
  Pillow for the textures, `@gltf-transform/cli` shelled out to for the
  geometry — and committed through **Git LFS**. Vite copies `public/` verbatim
  and is never asked to understand a `.glb`. Keeping the prep manual is what
  keeps `npm run build` free of a mesh-and-image toolchain, for an input that
  changes about never; the cost is that re-preparing is a documented step rather
  than an automatic one, and `WORKFLOWS.md` carries it.
- **No jsdom, no browser-mode runner, no headless GL.** The tests cover the
  parts that can be tested without a map — the species table and the geometry
  builders. Anything needing a GL context or a live MapLibre map is still
  verified in the browser, and `WORKFLOWS.md` says so.

## External services

| Service | Used for | Key required |
| --- | --- | --- |
| OpenFreeMap — `https://tiles.openfreemap.org/planet` | OSM vector tiles, OpenMapTiles schema, both basemap and `building` source layer | no |
| OpenFreeMap styles — `/styles/{dark,fiord,liberty,positron}` | the four basemaps | no |
| Martin — `/tiles/trees/{z}/{x}/{y}`, proxied to `TILES_PROXY_TARGET` (default `http://localhost:3000`) | Taipei's tree inventory as MVT, from the PostGIS stack in `infra/` | no |
| Martin — `/tiles/splats/{z}/{x}/{y}`, same proxy | the splat captures' placements, solved from control points in `infra/` | no |
| infra `files` (nginx) — `/files/3dgs-lod/<scan>-lod.rad`, proxied to `FILES_PROXY_TARGET` (default `http://localhost:3080`) | the splat captures' paged LoD trees: a `.rad` header (read by byte range) and its `<scan>-lod-<n>.radc` chunk files; the `.spz` themselves are at `/files/3dgs/` | no |

Every endpoint above except the basemap styles is configured in one file,
`src/sources.ts`. The layers take descriptors and name none of them.

Martin is **local and optional**: it is not a deployed service but a container
started with `infra/load.sh`, and the app runs without it — the tree layers
simply render nothing. It is reached through a Vite proxy, on the dev and the
preview server alike, so tile requests stay same-origin; see
`src/layers/tree/specs/spec.md` for why the layer uses `source.tiles` rather
than Martin's own TileJSON. Where the proxy forwards is the one deploy-time
setting, `TILES_PROXY_TARGET`, read from the environment or `app/.env*` and
never shipped to the bundle (`src/lib/tiles/specs/proxy.md`).

**No web fonts.** The interface uses the system stack (`-apple-system`,
`BlinkMacSystemFont`, Segoe UI, Roboto, with PingFang TC / Microsoft JhengHei
named explicitly for zh-TW), so tiles are the only third-party request the app
makes.

The `files` service is local and optional in the same way, and has its own
setting, `FILES_PROXY_TARGET` (`src/lib/tiles/specs/proxy.md`).

No API keys, no registration, and no `.env` is required. **Three** attributions are always or
conditionally required, plus the splat captures' credit while one is drawn
(`SPLATS.attribution`, a placeholder until the credit is known), and
all are rendered by the status bar: `© OpenStreetMap contributors ·
OpenMapTiles · OpenFreeMap` for the basemap and buildings, Taipei City's for the
tree inventory, and `Tree models: evolveduk · CC BY 4.0` for the glTF models.

The third is the only **conditional** one — it appears while the modelled mesh
source is drawing and not otherwise, because that is when the obligation exists.
Per-file detail (title, author, licence, source URL) is in
`public/models/trees/CREDITS.md`, generated from each model's own `asset.extras`
block by the prep script and never typed by hand.

## Build configuration

`vite.config.ts` carries three settings that exist only to get MapLibre's worker
to the browser — `optimizeDeps.exclude: ["maplibre-gl"]`, `worker.format: "es"`,
and `resolve.dedupe: ["maplibre-gl", "react", "react-dom"]` — paired with
`maplibreConfig.WORKER_URL` at module scope in `useMapEngine.ts`. Without them
the map renders as a black rectangle with no console error. Full reasoning in
`DECISIONS.md`.

It also builds the `/tiles` proxy from `src/lib/tiles/proxy.ts`, on `server`
and `preview` both, which is why the config is the function form
(`loadEnv` needs the `mode`).

`tsconfig.json`: ES2022 target, `bundler` module resolution, `strict`,
`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
`isolatedModules`, `noEmit`. `tsc -b` writes `tsconfig.tsbuildinfo`.

Dev server port is 5173. Build output is `dist/` (gitignored).
