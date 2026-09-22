# Basemaps — spec

Source of truth for the basemap catalogue and for the style-level surgery every
GeoLibre layer in this app depends on. Behaviour changes here require this file
to change first.

Module: `src/layers/basemaps/index.ts`

## Purpose

`basemaps` is not a GeoLibre layer — it produces no `GeoLibreLayer` record. It is
an **extension**: it owns the MapLibre style the GeoLibre layers are synced into,
and it conditions that style so the GeoLibre-managed layers render correctly.

## Data source

One OpenStreetMap snapshot serves both the ground plane and the extruded
buildings, so the two can never disagree.

- `OSM_TILEJSON` = `https://tiles.openfreemap.org/planet` — OpenMapTiles schema,
  no API key, no registration.
- `OSM_ATTRIBUTION` = `© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap`.
  Attribution is required. MapLibre's own `AttributionControl` is disabled
  (`attributionControl: false`), so this string MUST be rendered by the app's
  status bar. Removing it from the UI is a licensing regression, not a style
  choice.

## Catalogue

`BASEMAPS` is an ordered list; `BASEMAPS[0]` is the app's initial basemap.

| id | label | light | buildingColor |
| --- | --- | --- | --- |
| `dark` | Midnight | no | `#3d4658` |
| `fiord` | Fiord | no | `#3b4a63` |
| `liberty` | Liberty | yes | `#c9c3b6` |
| `positron` | Paper | yes | `#d6d3cd` |

Each entry carries:

- `styleUrl` — the OpenFreeMap style the map loads.
- `buildingColor` — a flat building colour that reads against this ground. This
  is the only place a basemap's colour identity reaches the app: the interface
  chrome has one fixed accent and does **not** re-tint per basemap
  (`ai/VISUAL_DESIGN.md`). A basemap entry carries no `accent` field.
- `light` — whether the ground is light, so the UI can invert contrast.

A basemap swap goes through `map.setStyle()`, which **wipes the entire style**:
every GeoLibre layer and every custom layer is destroyed. Everything below must
therefore re-run on each `style.load`, not once at startup.

## Style conditioning

All three functions distinguish GeoLibre's own layers by the `layer-` id prefix
and MUST never touch them.

### `hideBasemapBuildings(map)`

Every basemap ships its own building layers (flat; extruded in Liberty). They
z-fight with the GeoLibre extrusion. Any non-GeoLibre layer whose id matches
`/building/i` is set to `visibility: none`, leaving GeoLibre the sole renderer of
buildings.

### `firstLabelLayerId(map)`

Returns the id of the first non-GeoLibre `symbol` layer, or `undefined` when the
style has no labels.

### `anchorUnderLabels(map, layerIds)`

Moves each given layer beneath the first label layer. No-ops when the style has
no labels or a layer is absent. `map.moveLayer` may throw while a style is
reloading mid-flight; that throw is swallowed deliberately — the next
`style.load` re-anchors.

This exists because `createLayerSync` always appends to the **top** of the stack.
Top is the app's default (labels styled for a dark ground are unreadable over lit
building faces), so this is only called when the user opts in.

## Invariants

1. Basemap and buildings always come from the same OSM snapshot.
2. No function here mutates a layer whose id starts with `layer-`.
3. Attribution is displayed whenever the map is.
