# three.js Tree layer — spec

Source of truth for the three.js plugin layer. Behaviour changes here require
this file to change first.

Modules:
- `src/layers/tree/treeLayer.ts` — the MapLibre custom layer (owns the pixels)
- `src/layers/tree/index.ts` — the GeoLibre record (owns the description)

## Purpose

Draws a low-poly tree with three.js inside the MapLibre GL context, registered
**with** GeoLibre rather than bolted on beside it. The split above is the point:
GeoLibre owns stacking order, visibility and opacity; three.js owns rendering.

## Identity and placement

- `TREE_LAYER_ID` = `threejs-tree` — the GeoLibre record id.
- `TREE_NATIVE_LAYER_ID` = `threejs-tree-native` — the MapLibre custom-layer id
  GeoLibre is told to manage.
- `TREE_LOCATION` = `[121.5374, 25.0431]` — 25.0431° N, 121.5374° E, Da'an,
  Taipei. MapLibre order is `[lng, lat]`.
- `TREE_BASE_HEIGHT_M` = `13` — the modelled height; the height control scales
  from it.

A 13 m tree in Taipei is unfindable by panning, so viewpoint `tree` must exist
and fly to `TREE_LOCATION`.

## The GeoLibre contract

`treeLayerRecord(settings)` returns a record whose `metadata` opts into
GeoLibre's external-native path:

```ts
metadata: {
  customLayerType: "threejs",        // flag syncExternalNativeLayer branches on
  nativeLayerIds: [TREE_NATIVE_LAYER_ID],
  paintMode: "plugin",               // GeoLibre must not apply paint properties
}
```

On this path GeoLibre only **moves and shows** the named native layer. It does
not create it and does not paint it. That is what lets the tree travel in the
same `sync([buildings, tree])` call as the OSM buildings.

`type: "3d-tiles"` is inert — the external-native branch never reads `type`. It
is the closest `LayerType` for an externally rendered 3D mesh.

Opacity and visibility reach three.js through GeoLibre's paint bridge, registered
once per map with `setExternalNativePaintBridge(TREE_LAYER_ID, { setOpacity,
setVisibility })` and cleared on teardown. The panel's two GeoLibre-modelled
controls MUST go through the bridge, never straight to the class.

`setHeight` is deliberately **not** on the bridge: height is not a GeoLibre
concept, so the app drives it directly.

## Lifecycle

GeoLibre only moves and shows native layers that already exist, and
`map.setStyle()` destroys custom layers. Therefore, on **every** `style.load`,
the custom layer must be re-added before the next sync.

The `ThreeTreeLayer` instance outlives style changes:

- `onAdd` keeps the existing `WebGLRenderer` when the GL context is unchanged; a
  basemap swap re-adds the layer against the same canvas and context.
- `onRemove` drops only the map reference.
- `dispose` tears the renderer down, on map teardown only.

## Rendering

`renderingMode: "3d"` shares MapLibre's depth buffer, so the OSM extrusions
occlude the tree instead of it always drawing on top. Measured: from bearing
180°, the tree's visible area drops 93% with buildings on versus off. Losing
depth-buffer sharing is a regression.

### The projection matrix

MapLibre v6 calls `render(gl, options)` — **not** the bare
`render(gl, matrix)` that v2/v3-era three.js recipes destructure.

The field to use is **`options.defaultProjectionData.mainMatrix`**. It is the
matrix taking unit Mercator coordinates (what `MercatorCoordinate` produces) to
clip space. `modelViewProjectionMatrix` is a different world space and puts the
mesh far outside the frustum **with no error of any kind** — a silent blank map.
The MapLibre d.ts says so directly: *"If you just need a projection matrix, use
`defaultProjectionData.mainMatrix`."*

### The model matrix

Mercator is X-east / Y-south / Z-up in fractions of the world; three.js is Y-up
and the mesh is modelled in metres. `buildModelMatrix` composes, in order:
translate to the anchor → scale metres into Mercator units with **Y negated** for
the flipped axis → rotate three's Y-up frame onto Mercator's Z-up frame.

### Shared GL context

Two rules follow from three.js and MapLibre sharing one context:

1. Materials set `premultipliedAlpha: true` — MapLibre uses
   `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` and expects premultiplied colours, or
   the tree washes out at partial opacity.
2. `renderer.resetState()` runs every frame, handing the context back in a known
   state. `autoClear` is `false` so three.js never clears MapLibre's buffer.

## The mesh

Procedural, so the app carries no model asset and no loader: a 9-sided cylinder
trunk plus four overlapping flat-shaded icosahedra as canopy, lit by a hemisphere
light and a directional light. Offsets and rotations are **fixed constants, never
`Math.random`** — the tree must be identical on every reload.

Swapping `buildTree()` for a glTF load is the intended extension point.

## Settings

`TreeSettings`, with `DEFAULT_TREE_SETTINGS`:

| field | default | route |
| --- | --- | --- |
| `visible` | `true` | GeoLibre record → paint bridge → `setVisibility` |
| `opacity` | `1` | GeoLibre record → paint bridge → `setOpacity` |
| `height` | `TREE_BASE_HEIGHT_M` (13) | app → `setHeight` directly |

`setOpacity` flips `material.transparent` only when it actually changes, and sets
`needsUpdate` when it does. Every setter calls `map.triggerRepaint()` — the map
is otherwise idle and the change would not appear until the next interaction.

## Invariants

1. The tree is synced in the same `sync([...])` call as the buildings.
2. The custom layer is re-added on every `style.load`.
3. Only `defaultProjectionData.mainMatrix` is used for projection.
4. Visibility and opacity reach three.js through GeoLibre's paint bridge.
5. The mesh is deterministic across reloads.
