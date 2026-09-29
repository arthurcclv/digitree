# Layer mount — spec

Source of truth for how a layer with a custom (three.js) half is attached to a
map. Behaviour changes here require this file to change first.

Module: `src/lib/mount/` — `index.ts` (the `LayerMount` interface, the shared
`nativeLayer` helper and `changed`), `fakeMap.ts` (test support) and
`nativeLayer.test.ts`. Each such layer folder implements it in its own
`mount.ts`, exported from its `index.ts`. The folder's record builders live in
`records.ts`, so that `mount.ts` and `index.ts` never import each other.

## Purpose

A layer folder should be enough to run the layer in **any** GeoLibre
application: one that owns a MapLibre map and a `LayerSync`
(`createLayerSync` from `@geolibre/map`), not only this app.

Before this module, a layer folder held its record builder and its custom-layer
class. What made the layer work lived in `useMapEngine.ts`, and a second host
would have had to copy it:

- constructing the class, and registering and clearing its paint bridge;
- re-adding the custom layer after every `style.load`, because `setStyle`
  destroys it and GeoLibre only moves native layers that already exist;
- pushing each non-GeoLibre setting to the class (`setHeightScale`, `setKind`,
  `setMeshSource`, `setSunTime`, `setParams`) and skipping unchanged values;
- routing overlay visibility around the paint bridge, and reading DAG demand
  into the record (sunlight, temperature);
- adding the layer's DAG node, with its deps;
- disposing in dependency order.

A mount holds all of that inside the folder. The host decides only which
layers it runs, their stacking order, and what its UI does with their status,
probes and exports.

## The interface

```ts
interface MountContext {
  map: MapLibreMap;   // the host's map; its style need not be loaded yet
  graph: Graph;       // the host's one derived-layer DAG for this map
}

interface LayerMount<S> {
  update(settings: S): void;
  prepareSync(): GeoLibreLayer[];
  dispose(): void;
}
```

Each layer exports a factory `mount<Name>(ctx, settings, hooks?)`. It returns a
`LayerMount<S>` plus that layer's own readbacks:

| factory | `S` | hooks | extra members |
| --- | --- | --- | --- |
| `mountTree` | `TreeSettings` | `onModelStatus(ModelStatus)` | — |
| `mountSunlight` | `SunlightSettings` | `onStatus(SunlightStatus)` | `probe(lng, lat)`, `exportGeoTiff()` |
| `mountTemperature` | `TemperatureSettings` | `onStatus(TemperatureStatus)` | `probe(lng, lat)`, `exportGeoTiff()` |
| `mountAmbientOcclusion` | `{ ao: AmbientOcclusionSettings; buildings: Pick<BuildingSettings, "visible" \| "heightScale" \| "minHeight"> }` | `onStatus(AoState)` | — |

`buildings` gets no mount. Its record builder already needs nothing else, and
a mount around it would only pass settings through.

### `mount<Name>(ctx, settings, hooks)`

- Constructs the custom-layer class and applies `settings` to it.
- Registers the layer's paint bridge (`setExternalNativePaintBridge`) under
  its GeoLibre record id.
- Adds the layer's DAG node to `ctx.graph`, if it owns one, with its deps.
  A dependent must therefore be mounted **after** what it depends on, on the
  same graph. Mounting `temperature` without `sunlight` throws the DAG's own
  `depends on unknown "sunlight.lpi"`.
- Does not touch the style. It may be called before `style.load`.

### `update(settings)`

- Takes the whole settings object, every time. The mount compares it with the
  last one and pushes to the class only what changed.
- Applies the overlay's drawn visibility to the class (sunlight, temperature),
  which sets the node's own demand. This happens here and not in
  `prepareSync`, because `prepareSync` runs in stack order and sunlight comes
  before temperature.
- Returns nothing. A change that alters the records (visibility, opacity,
  filters, demand) shows up at the next `prepareSync`, so after any update the
  host must sync again.
- May change DAG demand, and so another mount's records. Temperature's
  `visible` makes `sunlight.lpi` demanded. This is why the host must apply
  **every** pending update before calling **any** `prepareSync`.

### `prepareSync()`

Call it only once the style is loaded, immediately before `sync`, once per
mount, and in stack order. In order, it:

1. re-adds the custom layer to the map if the style dropped it;
2. returns the layer's records, in their own stack order: the tree returns
   `[points, mesh]`, every other layer one record.

A sunlight record's `visible` reads `graph.demanded("sunlight.lpi")` at step 2.
Because every host update has already run, it sees the final demand.

### `dispose()`

For map teardown only. It clears the layer's node (the class already does),
clears its paint bridge, and disposes the class. The host disposes mounts in
**reverse mount order**, so a dependent never samples an upstream that is
already gone. Removing one mount from a live map is out of scope.

## The shared helper

`nativeLayer(map, recordId, custom, bridge)` holds the part all four custom
layers share. It returns `{ ensureAdded(), dispose() }`:

- On creation, it registers `bridge` under `recordId`.
- `ensureAdded()` adds `custom` if `map.getLayer(custom.id)` is missing. It
  does nothing when the layer is present.
- `dispose()` clears the bridge. Disposing the custom layer itself is the
  mount's job, because each class has its own teardown.

## What stays in the host (`useMapEngine.ts` in this app)

- Creating the map, the worker configuration, `installMapTransformCompat`,
  `createLayerSync`, and the one `Graph`.
- The mount order and the sync order:
  `buildingsLayer(buildings)`, then ambient occlusion, sunlight, temperature,
  and tree (points, mesh).
- On `style.load`: `hideBasemapBuildings`, `setLight`, then sync. Re-adding
  custom layers is no longer the host's job.
- After any settings change: every mount's `update`, then one pass of
  `prepareSync` in stack order, then `sync`. `sync` re-applies every layer it
  is given, so the host skips it when the records are identical to the last
  ones it synced. After a `style.load` it always syncs, because `setStyle`
  wiped the style.
- Anchoring under labels (`labelsOnTop`). Stacking belongs to the host, and so
  does the list of style-layer ids anchored with the buildings.
- The click handler: which overlays a click probes, and where results go.
- Camera, basemap swaps, `ready` and `error`.

## Invariants

All asserted by vitest, with a fake map (`src/lib/mount/fakeMap.ts`:
`getLayer`, `addLayer`, `on`, `off`, `triggerRepaint`, `getZoom`, `getCenter`)
and a real `Graph`. No
GL context is needed: every class creates its `WebGLRenderer` in `onAdd`,
which the fake never calls.

1. `nativeLayer.ensureAdded` adds the custom layer exactly when it is missing.
2. Each mount registers its paint bridge on mount and clears it on `dispose`.
3. `prepareSync` returns the same records as the layer's record builders for
   the same settings (and, for sunlight, the same demand).
4. Temperature's `visible: true` makes the next sunlight `prepareSync` return
   `visible: true` even with sunlight's own `visible: false`. Setting it back
   to `false` makes that record hidden again.
5. `mountTemperature` before `mountSunlight` on one graph throws.
6. `update` with an unchanged setting calls no setter on the class.
7. After a simulated style reset (the fake's `getLayer` returns undefined),
   the next `prepareSync` re-adds the custom layer.

## Out of scope

- Unmounting one layer from a live map, and mounting one twice on a map.
- Moving `buildings` or `basemaps` behind a mount.
- Data sources, AO's dependency on building settings, and the GL setup the
  four classes duplicate. Those are candidates 3–5 of the 2026-09-29
  architecture review, and each is a separate change.
