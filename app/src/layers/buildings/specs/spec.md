# OSM Buildings layer — spec

Source of truth for the extruded-building layer. Behaviour changes here require
this file to change first.

Module: `src/layers/buildings/index.ts`

## Purpose

Describes OSM building footprints to GeoLibre as a plain `GeoLibreLayer` record.
`createLayerSync` reads that description and materialises the MapLibre
`fill-extrusion` style layer, its paint properties and its filters.

**The app never calls `map.addLayer` or `map.setPaintProperty` for buildings.**
Every control works by re-describing the layer and re-syncing. A change that
reaches for MapLibre directly violates this spec.

## Identity

- `BUILDINGS_LAYER_ID` = `osm-buildings` — the record id passed to `sync()`.
- `BUILDINGS_STYLE_LAYER_IDS` = the style-layer ids GeoLibre derives:
  `layer-osm-buildings-vector-extrusion` and `layer-osm-buildings-vector`.

These derived ids are needed to re-anchor the layer under the basemap labels.
They follow `@geolibre/map`'s naming for a single-source-layer vector-tile
extrusion; if GeoLibre's naming changes, this list must change with it.

## Source

`buildingsLayer(settings, source)` takes a `BuildingSource` descriptor from the
host (`src/lib/tiles/specs/spec.md`). The layer holds no endpoint.

- `url` — `source.tileJson`
- `sourceLayer` — `source.sourceLayer`
- `attribution` — `source.attribution`
- `name` and `metadata.sourceKind` — `source.name`, `source.sourceKind`
- Zoom range: `minZoom: 13`, `maxZoom: 24`

This app's descriptor is `BUILDINGS` in `src/sources.ts`: `OSM_TILEJSON` and
`OSM_ATTRIBUTION` from the basemaps extension, `sourceLayer: "building"`,
`name: "OSM Buildings"` and `sourceKind: "osm-openfreemap"`.
Building it from the basemaps constants keeps one OSM snapshot for ground and
extrusions.

### Schema

The OpenMapTiles `building` layer carries `render_height` (drives extrusion
height) and `hide_3d` (features OSM marks as unsuitable for 3D). `schema.ts`
holds both forms of the rule:
- the MapLibre form this record uses: `BUILDING_SHOWN_FILTER`,
  `BUILDING_HEIGHT_EXPRESSION`, `minHeightFilter(m)`;
- the JS form the self-fetching layers decode with: `buildingHeight(props)`,
  which is `null` for `hide_3d: true` or a non-positive height, through
  `buildingTiles(source)`. Beside it is `meetsMinHeight(heightM, m)`, the JS
  form of `minHeightFilter(m)`, which ambient occlusion applies to its decoded
  heights.

Every building the JS form keeps, the extrusion draws. The one difference: with
no minimum height, the filter keeps a footprint with no positive
`render_height` and draws it flat, while `buildingHeight` drops it, because it
has no volume to shade or occlude. A test evaluates the filter to pin exactly
this.

## Settings

`BuildingSettings`, with `DEFAULT_BUILDING_SETTINGS`:

| field | default | meaning |
| --- | --- | --- |
| `visible` | `true` | layer on/off |
| `heightScale` | `1` | vertical exaggeration applied to `render_height` |
| `opacity` | `0.94` | extrusion opacity |
| `paletteId` | `null` | height ramp; `null` = flat colour |
| `flatColor` | `"#d6d3cd"` | the one colour used when `paletteId` is `null` |
| `minHeight` | `0` | hide buildings shorter than this, in real metres |
| `labelsOnTop` | `false` | draw basemap labels above the extrusions |

## Colour

Three ramps in `PALETTES`, each six stops keyed to height in metres
(`0, 12, 30, 70, 140, 260`):

- `ember` — slate → amber → cream
- `jade` — deep teal → green → pale
- `neon` — indigo → violet → magenta → pink

A ramp compiles to a MapLibre `interpolate`/`linear` expression over
`["to-number", ["get", "render_height"], 0]`, set on `extrusionColorExpression`
with `extrusionAdvancedStyleEnabled: true`.

**Colour always uses the true, unexaggerated height** — `heightScale` must not
enter the colour expression, so the legend stays honest when exaggeration is on.

When `paletteId` is `null` (or matches no palette), advanced styling is disabled
and `extrusionColor: flatColor` paints every building one colour. `flatColor`
defaults to `BASEMAPS[0].buildingColor` and is re-patched on every basemap
change, so the flat colour always belongs to the ground under it.

**No UI exposes `paletteId`.** The ramps remain part of this layer's contract and
a caller may still set `paletteId` — the expression above is live, tested code —
but the app ships `null` and never changes it. The panel that chose a ramp is
gone (`ai/DECISIONS.md`, 2026-09-24). Against Paper the flat colour already
separates building from ground, and a height ramp was answering a question the
app no longer asks.

## Filtering

`filterExpression` is built from:

1. Always: `["!=", ["get", "hide_3d"], true]`
2. When `minHeight > 0`: `[">=", ["to-number", ["get", "render_height"], 0], minHeight]`

One clause is emitted bare; two or more are wrapped in `["all", ...]`. Like
colour, the minimum-height filter compares against **real** metres, not scaled.

## Stacking

Buildings draw **above** the basemap labels by default: labels styled for a dark
ground are unreadable over lit building faces. `labelsOnTop: true` calls
`anchorUnderLabels` after each sync to put them back underneath.

## Opacity

The record's own `opacity` is fixed at `1`; the user-facing opacity is
`style.extrusionOpacity`. The two are distinct in GeoLibre and must not be
conflated.

## Invariants

1. No direct MapLibre calls for this layer — only the record plus `sync()`.
2. Colour and the minimum-height filter read unexaggerated `render_height`.
3. `hide_3d` features are never drawn.
4. Every source field of the record comes from the descriptor passed in.
5. Every building `buildingHeight` keeps, the extrusion filter keeps; they
   differ only on non-positive heights at no minimum height.
6. For every positive height and minimum, `meetsMinHeight` agrees with
   `minHeightFilter`, as MapLibre evaluates it.
