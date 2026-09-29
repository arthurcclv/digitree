# Data sources — spec

Source of truth for where the layers' data comes from and who decides it.
Behaviour changes here require this file to change first.

Modules:
- `src/sources.ts`: the app's configuration. It names the datasets this app
  points its layers at. It is the only file that knows the Taipei endpoints.
- `src/lib/tiles/`: `TileStore`, which is generic over its sources and knows no
  dataset, and `structure.test.ts`, which checks invariants 1 and 2.
- `src/layers/tree/schema.ts` and `src/layers/buildings/schema.ts`: each
  dataset's **schema**, meaning how a feature is read. Every consumer shares it.

## Purpose

A layer folder should run against any dataset that publishes its schema,
wherever that dataset is served. Before this change:
- the endpoints were constants inside the layers (`TREES_TILES`,
  `TREES_BOUNDS` in `tree/constants.ts`; `OSM_TILEJSON`, used by `buildings`);
- `src/lib/tiles/store.ts` imported them from `layers/tree` and
  `layers/basemaps`, so `lib` depended on `layers`;
- each reading rule was written twice. The rule for which buildings are drawn
  and how tall existed as the extrusion's MapLibre expression and as
  `buildingHeight` in the store. The rule for what counts as a tree and how
  tall existed in `treeLayer.ts` and in the store's `decodeTrees`.

After it, pointing the app at another city's trees means editing
`src/sources.ts`, and nothing under `src/layers/` or `src/lib/`.

## Source descriptors

A descriptor says **where** a dataset is. It is plain, serializable data, and
the host passes it in. A layer never imports one.

```ts
// layers/tree — the tree inventory
interface TreeSource {
  tiles: string;          // URL template with {z}/{x}/{y}; may be relative
  sourceLayer: string;    // the MVT layer inside each tile
  minzoom: number;        // the server's; below it nothing is served
  maxzoom: number;
  bounds: [number, number, number, number]; // west, south, east, north
  attribution: string;
}

// layers/buildings — building footprints
interface BuildingSource {
  tileJson: string;       // a TileJSON URL; its first `tiles` template is used
  sourceLayer: string;
  attribution: string;
}
```

Who takes which:

| consumer | takes |
| --- | --- |
| `treePointsLayer(settings, trees)` | the source fields of the record: `tiles`, `sourceLayer`, `minzoom`, `maxzoom`, `bounds` |
| `mountTree(ctx, { trees }, settings, hooks)` | the above; `sourceLayer` is also what the meshes query |
| `buildingsLayer(settings, buildings)` | `tileJson` as the record's `url`, `sourceLayer`, `attribution` |
| `mountSunlight(ctx, { trees, buildings }, settings, hooks)` | both, for its own `TileStore` |
| `mountAmbientOcclusion(ctx, { buildings }, settings, hooks)` | buildings, for its own `TileStore` |
| `mountTemperature(ctx, settings, hooks)` | nothing: all its input arrives through the DAG |

So a mount factory is `mount<Name>(ctx, sources, settings, hooks?)` when the
layer reads a dataset, and `mount<Name>(ctx, settings, hooks?)` when it does
not. Descriptors are fixed for a mount's life. Changing one means a new map,
as a new graph does.

**The self-fetching layers need z14.** `TileStore` fetches every source on
one z14 grid (`TILE_ZOOM`). A descriptor for sunlight or AO must therefore
serve z14. The store does not check this. A source that doesn't serve z14
shows up as failed tiles.

## Schemas

A schema says **how** a feature is read. It is part of the owning layer's
contract, fixed in its spec, and not configurable. Another city is served by
publishing the same property names. A remapping table is out of scope (see
*Out of scope*).

### Trees (`tree/schema.ts`; the tree spec, *Data source*)

Point features with `tree_id` (text, the identity), `kind`, `species`,
`height_m` (nullable).

- `treeOf(properties, geometry): TreeFeature | null`. This is the **one**
  reading of a tree. It returns `null` unless the geometry is a Point and
  `tree_id` is a string. `heightM` is `height_m` when it is a positive number,
  else `null`. It carries `kind` and `species` through unread.
- The meshes (`treeLayer.ts`, over `querySourceFeatures`) and the direct-sun
  layer (over its own tiles) both read trees with it. They then apply their
  own policy: the meshes deduplicate by `id`, filter by `kind`, and replace a
  `null` height with `TREE_FALLBACK_HEIGHT_M`, and the direct-sun layer does
  the same with the height. A tree is therefore the same tree in both.
- The points record's expressions (`["get", "kind"]`, `height_m` for the
  circle size) name the same properties, from the same module's constants.
- `TreeFeature` moves from `lib/tiles` to `layers/tree`.

### Buildings (`buildings/schema.ts`; the buildings spec, *Source*)

The OpenMapTiles `building` layer: `render_height`, and `hide_3d`.

- `buildingHeight(properties): number | null`. This is the JS form, moved from
  `lib/tiles/store.ts`. It returns `null` for `hide_3d: true` or a height that
  is not positive.
- `meetsMinHeight(heightM, m)` is the JS form of the minimum-height filter,
  which ambient occlusion applies to decoded heights.
- `BUILDING_SHOWN_FILTER`, `BUILDING_HEIGHT_EXPRESSION` and
  `minHeightFilter(m)` are the MapLibre forms the extrusion record uses. They
  sit beside the JS form in the same module, and a test asserts how the two
  relate.
- **They differ in one known case.** With no minimum height, the extrusion
  filter keeps a footprint whose `render_height` is 0 or missing and draws it
  flat. `buildingHeight` drops it, because a footprint with no volume has
  nothing to shade or occlude. Every building the JS form keeps, the
  extrusion draws. The difference is pinned by a test, so it cannot widen
  unnoticed.
- `BuildingFeature` (`{ heightM, polygons }`) stays in `lib/tiles`. It is
  schema-free geometry that `prisms.ts` consumes, and the buildings schema
  produces it.

## `TileStore`, generic

```ts
type TileLocation = { tiles: string } | { tileJson: string };

interface TileSource<T> {
  location: TileLocation;
  decode(buf: ArrayBuffer, tile: TileId): T[];
  mayHold?(tile: TileId): boolean;   // false: known empty without asking; default true
}

new TileStore(sources: Record<string, TileSource<unknown>>, fetchFn?)
store.featuresOf(name, tile)         // typed by the source under `name`
```

- A store holds exactly the sources it is given. There is no default set and
  no `TileSourceName`. A tile counts as covered once every held source has it.
  This keeps today's rule, and so AO's buildings-only store is simply
  `{ buildings }`.
- A `tileJson` location is resolved once, and retried after a failure, as the
  building TileJSON is today. A `tiles` location is used as it is.
- Everything else is unchanged and specified in the sunlight spec, *Data*:
  the z14 grid, the LRU of `TILE_CACHE_SIZE` per source, `FETCH_CONCURRENCY`,
  204 as an empty tile, failures as a state, and retries.
- Adapters: `treeTiles(source: TreeSource)` (in `layers/tree`) decodes with
  `treeOf`, and `mayHold` is the descriptor's `bounds`.
  `buildingTiles(source: BuildingSource)` (in `layers/buildings`) decodes
  with `buildingHeight`. The sunlight and AO layers import them from those
  layers' `index.ts`. `lib/tiles` imports nothing from `src/layers/`.

## The app's configuration (`src/sources.ts`)

| export | value |
| --- | --- |
| `TREES: TreeSource` | `tiles: "/tiles/trees/{z}/{x}/{y}"` (relative, for the reason in the tree spec, *Why `source.tiles`*), `sourceLayer: "trees"`, zoom 14–20, the inventory bounds, `"臺北市政府 · Taipei City open data"` |
| `TREES_SURVEYED` | `162_930`, the panel's "Surveyed trees", formerly `TREES_TOTAL` |
| `BUILDINGS: BuildingSource` | `tileJson: OSM_TILEJSON`, `sourceLayer: "building"`, `attribution: OSM_ATTRIBUTION` |

- `BUILDINGS` is built from `basemaps`' `OSM_TILEJSON` and `OSM_ATTRIBUTION`,
  so the basemap and the buildings still share one OSM snapshot (DECISIONS
  2026-09-22). The same descriptor goes to the extrusion record, the sunlight
  store and the AO store.
- `useMapEngine` passes `TREES` and `BUILDINGS` to the records and mounts.
  `App.tsx` reads the attributions, `TREES.minzoom` and `TREES_SURVEYED` from
  here.
- The infra contract comments (the names set in `infra/martin.yaml`) move
  with the values.
- `MODELS_ATTRIBUTION` stays in `layers/tree`. It is about the layer's own
  bundled models, not a dataset.

## Invariants

All asserted by vitest.

1. No shared module in `src/lib/` (`tiles`, `mount`, `dag`) imports from
   `src/layers/`. `useMapEngine.ts` is exempt, because it is the host and
   composing the layers is its job. A test reads the source files to check
   this.
2. No non-test file under `layers/tree`, `layers/buildings`, `layers/sunlight`,
   `layers/ambient-occlusion` or `layers/temperature` contains a URL-shaped
   tile endpoint: a quoted string literal starting with `/tiles/`, or containing
   `{z}` or `openfreemap.org`. `basemaps` owns the style
   catalogue and is exempt.
3. `treePointsLayer` and `buildingsLayer` take every source field from the
   descriptor they are given. A fixture descriptor with a foreign URL and
   bounds appears unchanged in the record.
4. `treeOf` rejects a non-Point geometry and a missing `tree_id`, and maps a
   non-positive or missing `height_m` to `null`.
5. Over a table of sample properties and minimum heights, evaluated with
   MapLibre's own filter evaluator (`featureFilter`): whenever
   `buildingHeight(p)` is at least `m`, the extrusion's filter for `m` keeps
   `p`, and a `hide_3d` feature is dropped by both. The one divergence (a
   non-positive height, kept flat by the filter at `m = 0` and dropped by
   `buildingHeight`) is asserted as such.
6. `TileStore` passes its existing tests on **fixture sources**, with no
   import from a layer: covered only when every held source has the tile, 204
   is empty, `mayHold` false is never requested, failures are retried, a
   TileJSON is retried, and concurrency is capped.
7. A store given one source never requests another.

## Dependency

Invariant 5 needs `@maplibre/maplibre-gl-style-spec`'s `featureFilter`.
It is already installed (26.4.4), as a dependency of `maplibre-gl`. It is
added to `devDependencies`, pinned to that version, and recorded in
`ai/STACK.md`. Nothing new is downloaded.

## Out of scope

- A property-name mapping, so that a dataset with a different schema (for
  example `height` instead of `render_height`) could be read. That would be a
  second schema adapter. Today there is one dataset per schema, so the seam
  stays hypothetical.
- Changing the tile grid's zoom per source.
- AO's dependency on building *settings* (review candidate 4), the shared GL
  host (candidate 5), and the remaining Taipei-isms: time zone, home view,
  record names (candidate 6).
