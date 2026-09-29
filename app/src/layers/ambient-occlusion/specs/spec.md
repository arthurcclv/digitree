# Ambient occlusion layer — spec

Source of truth for screen-space ambient occlusion (SSAO) on the buildings.
Behaviour changes here require this file to change first.

Modules: `src/layers/ambient-occlusion/`:
- `index.ts` holds the record, the settings and the exports.
- `aoLayer.ts` is the custom layer, with its G-buffer, AO, blur and composite
  passes.
- `kernel.ts`, `geometry.ts` and `state.ts` are the pure parts: the sample
  kernel and composite factor, tile planning and prism placement, and the
  state gate.

Tile fetching, the z14 grid, per-tile triangulation and the ground footprint
come from `src/lib/tiles/`, shared with the sunlight layer.

## Purpose

Darken the drawn buildings where ambient light would be blocked:
- inner corners where two walls meet;
- narrow gaps between buildings;
- the ground along the foot of every wall (contact shading).

MapLibre 6.10's `fill-extrusion` has no ambient-occlusion property. GeoLibre
3.0.0 exposes only `fill-extrusion-vertical-gradient`, which it hardcodes to
`true`. So the occlusion is computed by a three.js custom layer and multiplied
over the frame.

**This is decoration, not physics.** Unlike the sunlight index, the layer
follows the drawn scene. It uses the buildings' height exaggeration and
minimum-height filter, and it disappears when the buildings are hidden. The
point is for the shading to sit on what is drawn.

## Geometry

The layer cannot read MapLibre's depth buffer: the default framebuffer's depth
cannot be sampled in WebGL. So it redraws the buildings itself, into its own
G-buffer, using the same data MapLibre uses.

- **Source.** z14 building tiles from the `BuildingSource` passed to
  `mountAmbientOcclusion` (in this app `BUILDINGS`, `src/sources.ts`), decoded
  by the buildings layer's `buildingTiles`. These are the same tiles
  the sunlight layer fetches, through the same `TileStore` class
  (`src/lib/tiles`), in an instance of its own that holds buildings only. The
  two layers do not share a cache: one store has a single wanted set and a
  single change callback, so sharing would mean one layer's plan cancelling
  the other's. The browser's HTTP cache answers the second request.
- **Which tiles.** Every z14 tile meeting the bounding box of the visible
  ground footprint, plus one ring of neighbouring tiles. The footprint is the
  sunlight layer's (`groundFootprint` in `src/lib/tiles`). The box is clipped
  to `AO_FETCH_HALF_M` = 4,096 m around the map centre, so a pitched view's
  horizon does not plan the whole city. Beyond that, a building is a few
  pixels and is drawn without occlusion. There is no sun margin: occlusion
  reaches `radiusM`, not a shadow length.
- **Filter.** A feature is dropped when `hide_3d` is true, or when its
  `render_height` is below the buildings' `minHeight`. This is the same test
  the extrusion's `filterExpression` applies.
- **Height.** Each footprint becomes a prism from 0 to
  `render_height × heightScale`. The height is exaggerated here, as drawn.
  That is the reverse of the sunlight rule.
- **Ground.** The G-buffer also holds a ground plane at z = 0, a square of
  half-width `AO_FETCH_HALF_M` around the centre, so walls can occlude the
  ground.
- **Frame.** A local frame in metres, as in the sunlight layer: `x` east, `y`
  north, `z` up, origin at the map centre when the tiles were planned.
- **Zoom floor.** `AO_MIN_ZOOM` = 14. From z14 up, MapLibre draws the same
  z14 tiles (overzoomed), so the redrawn prisms match the drawn extrusions
  vertex for vertex. Below z14, MapLibre draws simplified z13 tiles and the
  two would disagree. Below z14 the layer draws nothing.

Trees neither cast nor receive occlusion.

## Rendering

The work is split across two MapLibre callbacks. `prerender` runs the offscreen
passes (1–3). `render` runs the composite (4). Each frame is drawn with
MapLibre's own camera matrix for that frame, so the result never lags a moving
camera.

1. **G-buffer.** The prisms and the ground plane are drawn into two RGBA
   float targets (one draw, two outputs) with their own depth buffer, at
   `AO_SCALE` = 0.5 of the canvas resolution:
   - the **position relative to the eye**, in local metres (RGB), with A = 1
     where there is a surface and 0 for sky;
   - the **normal** (RGB), from the screen-space derivatives of the position
     and turned to face the eye. Every face is flat, so this is exact.

   The eye is recovered from the frame's matrix as the point where clip `w`
   vanishes. Eye-relative positions keep full precision close to the camera,
   where the occlusion is seen.
2. **AO.** A full-screen pass takes `AO_SAMPLES` = 16 samples per pixel. The
   samples are hemisphere-oriented, drawn from a fixed kernel (`kernel.ts`),
   and rotated per pixel by a 4 × 4 noise tile.
   - **Radius.** `radiusM` is in ground metres, and the samples are placed
     in the metric local frame. The occlusion therefore keeps its size on the
     ground at every zoom.
   - **Occluded** means that the G-buffer surface at a sample's pixel is
     nearer the eye than the sample, by more than a small bias
     (`0.02 × radiusM + 0.001 ×` the distance to the eye).
   - **Range check.** A sample whose depth differs from the centre by more
     than `radiusM` contributes nothing. This keeps a dark halo from forming
     where a roof edge is seen against the distant ground.
   - The pass outputs `ao ∈ [0, 1]`, where 1 means unoccluded.
3. **Blur.** A 4 × 4 depth-aware blur. A tap is weighted down as its depth
   departs from the centre's, so the occlusion does not bleed across
   silhouettes.
4. **Composite.** The prisms and the ground plane are drawn again, with
   MapLibre's matrix, in the translucent pass (`renderingMode: "3d"`). Each
   fragment reads the blurred occlusion at its own screen position (filtered,
   since the target is half resolution).
   - **Depth.** A polygon offset pulls the redrawn surfaces towards the camera
     (factor −1, units −4), and they are tested against MapLibre's depth
     buffer. Where something MapLibre drew lies in front of the redrawn
     surface, the fragment fails and that pixel is not darkened. Sky is never
     drawn, so it is never touched.
   - **Prisms** test `LESS` and write depth. The tile buffer repeats a
     building in each tile it overlaps, and a repeat must not darken a pixel
     twice: the second copy meets the first copy's offset depth and fails.
   - **Ground** tests `LEQUAL` and never writes depth. The direct-sun overlay
     drawn after it then still meets the ground's own depth.
   - **Blend.** Multiplicative (`DST_COLOR, ZERO` for colour; alpha kept),
     emitting `clamp(1 + (ao − 1) × intensity, 0, 1)`: `mix(1, ao, intensity)`,
     extended past 1 and clamped. An `intensity` of 0 leaves the frame
     unchanged, and 1 multiplies by `ao` itself. Above 1 the darkening is
     steeper and saturates: at 2, any pixel with `ao ≤ 0.5` goes black.

   A redrawn surface, rather than a full-screen pass writing `gl_FragDepth`,
   is what gets the depth right: MapLibre sets its own depth range for 3D
   layers, and a rasterised surface lands in it exactly as the extrusion did.

### Stacking

The sync order is:

buildings → **ambient occlusion** → sunlight → tree points → tree mesh

Everything drawn after the composite is not darkened. That covers:
- the direct-sun overlay, which is data and must read true;
- the tree circles;
- the tree meshes.

When the buildings' `labelsOnTop` is true, the composite is re-anchored under
the labels with them (`anchorUnderLabels`), so labels are not darkened either.

### GL rules

The layer follows the tree layer's *Shared GL context* rules, as the sunlight
layer does:
- it owns its own `WebGLRenderer` on MapLibre's context;
- `autoClear = false`;
- `resetState()` runs before and after each pass;
- `setRenderTarget(null)` runs after the offscreen passes.

**Unsupported GPUs.** When the renderer lacks `EXT_color_buffer_float`, the
layer draws nothing and reports `unsupported`.

**Resize.** The targets are reallocated when the canvas size changes. They are
never rebuilt per frame.

## Recompute

On `idle`, the layer plans its tiles and requests the ones it lacks. It
rebuilds the prism mesh when:
- the planned tiles change;
- a requested tile arrives (coalesced, at most one rebuild per 150 ms, as in
  the sunlight layer);
- `heightScale` or `minHeight` changes.

It reuses the per-tile triangulation described in the sunlight spec. A tile
that has not arrived yet is simply absent from the G-buffer, so its buildings
are drawn without occlusion until it lands. They are never drawn darkened
wrongly.

**Nothing is planned, fetched or drawn** while the layer is off, or below
`AO_MIN_ZOOM`. The layer is off when `enabled` is false or the buildings are
hidden.

## The GeoLibre record

`ambientOcclusionRecord(settings, buildings)` follows the external-native
pattern of the sunlight record:
- `id: "ambient-occlusion"`;
- `metadata.customLayerType: "threejs"`;
- `nativeLayerIds: ["threejs-ambient-occlusion-native"]`;
- `paintMode: "plugin"`;
- `source: {}`.

`visible` is `settings.enabled && buildings.visible`, and reaches the layer
through the paint bridge; `opacity` is fixed at 1 and unused. Height is not a
GeoLibre concept, so the layer's mount (`mountAmbientOcclusion`, `mount.ts`,
see `src/lib/mount/specs/spec.md`) sets `intensity`, `radiusM` and the
buildings' `heightScale` and `minHeight` on the layer directly (`setParams`),
from the `{ ao, buildings }` settings the host hands its `update`.

## Settings

`AmbientOcclusionSettings`, with `DEFAULT_AO_SETTINGS`:

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | occlusion on or off |
| `intensity` | `1` | how strongly occlusion darkens, from 0 to 2; 0 has no effect, 1 multiplies by `ao`, 2 doubles the darkening (clamped at black) |
| `radiusM` | `6` | the reach of the occlusion, in ground metres |

The Buildings section of the panel gains:
- an **Ambient occlusion** toggle;
- when it is on, an **Intensity** slider (0–200%, in 5% steps) and a
  **Radius** slider (2–20 m, in 1 m steps);
- when it is on, the buildings are shown and nothing is drawn, a readout of
  why: "zoom in to z14", or "GPU lacks float targets".

## Invariants

The pure invariants (1–4) are asserted by vitest. The GPU ones (5–9) are
checked in the browser.

1. **Kernel.** `aoKernel()` returns `AO_SAMPLES` samples.
   - Every sample lies in the unit +Z hemisphere, with length ≤ 1.
   - The samples are denser towards the origin, so each sample's length is
     non-decreasing in its index.
   - The kernel is deterministic, so the same seed gives the same kernel.
2. **Geometry.**
   - `hide_3d` features, and features without a positive `render_height`,
     are dropped at decode (`buildingHeight`). Features below `minHeight` (true
     metres) produce no prism.
   - A prism's roof is at `render_height × heightScale`.
   - Every prism is closed: each edge is shared by exactly two triangles.
3. **Record and state.** `visible` is false whenever either `enabled` or the
   buildings' `visible` is false. The ids and metadata are as listed above.
   `aoState` returns `off`, `unsupported`, `zoom` in that order, and `ready`
   only from `AO_MIN_ZOOM` up. Tile planning covers the footprint's tiles plus
   one ring, and nothing beyond `AO_FETCH_HALF_M` plus one tile.
4. **Composite factor.** At intensity 0 the factor is 1 for every `ao`. At
   intensity 1 it equals `ao`. At intensity 2 it is `max(0, 2·ao − 1)`, so it is
   never negative. It is 1 wherever `ao` is 1, at any intensity.
5. The inside corner of an L-shaped building, and the ground at a wall's foot,
   read visibly darker than an open roof. An open roof reads unchanged.
6. The occlusion fades to nothing about `radiusM` from a wall. Its size on the
   ground does not change between z15 and z18.
7. No dark halo appears around a building's silhouette against the ground
   behind it, at any pitch.
8. The tree meshes, the tree circles and the direct-sun overlay are never
   darkened.
9. With the layer off, or below z14, no tile is requested and no pass runs.
   The frame is then pixel-identical to the frame without the layer.

## Out of scope

- Occlusion by or on trees.
- Terrain.
- Higher-order methods (HBAO, GTAO) and temporal accumulation.
- Baking occlusion into tiles.
- Changing GeoLibre's `fill-extrusion-vertical-gradient`, which stays as
  GeoLibre sets it.

## Decisions

Settled at approval (2026-09-24), recorded in `ai/DECISIONS.md`:

1. `TileStore`, the z14 grid, the building triangulation and the ground
   footprint moved from `sunlight/` into `src/lib/tiles/`. The store gained a
   per-source switch, and this layer holds buildings only.
2. The layer ships on (`enabled: true`).
