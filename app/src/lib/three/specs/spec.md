# three.js layer host — spec

Source of truth for how a three.js layer shares MapLibre's GL context.
Behaviour changes here require this file to change first.

Module: `src/lib/three/` — `index.ts` (`ThreeLayer`, `projection`,
`mercatorFrame`, `PREMULTIPLIED_OVER`) and `threeLayer.test.ts`. The four
custom-layer classes (`ThreeTreeLayer`, `ThreeSunlightLayer`,
`ThreeTemperatureLayer`, `ThreeAoLayer`) extend `ThreeLayer`.

## Purpose

Every three.js layer on a MapLibre map must follow the same rules. Getting one
wrong fails silently, as a blank or washed-out map (DECISIONS 2026-09-22:
*`renderingMode: "3d"`*, *`mainMatrix`*). Before this module, each of the four
classes wrote the rules out for itself:

- `renderingMode: "3d"`, to share MapLibre's depth buffer;
- one `WebGLRenderer` on MapLibre's canvas and context, with
  `autoClear = false`. It is kept across `setStyle` (a style change removes
  and re-adds the layer against the same context) and rebuilt only when the
  context changes;
- `resetState()` around every pass of three.js work;
- projection from `defaultProjectionData.mainMatrix`, never
  `modelViewProjectionMatrix`;
- a model matrix from a Mercator origin and a metre scale, with `y` flipped;
- premultiplied colour, because MapLibre blends with
  `ONE, ONE_MINUS_SRC_ALPHA`;
- `idle` bursts coalesced into one "the view settled" callback.

They had already drifted apart. Tree and sunlight reset state only **before**
`render`; temperature and AO reset before and after. The sunlight spec says
"before and after each pass". This module keeps the rules in one place, and
each layer implements only its own passes.

## `ThreeLayer`

An abstract base class that implements `CustomLayerInterface`:

```ts
abstract class ThreeLayer implements CustomLayerInterface {
  abstract readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "3d";

  protected map: MapLibreMap | null;
  protected gl: WebGL2RenderingContext | null;
  protected renderer: THREE.WebGLRenderer | null;

  onAdd(map, gl): void;      // owned by the base; see Lifecycle
  onRemove(): void;          // owned by the base
  dispose(): void;           // subclasses extend it and call super.dispose()

  // Optional hooks a subclass implements:
  protected contextChanged?(renderer): void; // a new renderer on a new context
  protected attached?(): void;               // after every onAdd
  protected viewSettled?(): void;            // idle, coalesced

  // Helpers:
  protected pass(fn: (renderer) => void): void;  // resetState before and after
  protected repaint(): void;                     // map?.triggerRepaint()
}
```

**`render` and `prerender` stay in the subclass.** MapLibre gives every
custom layer that *has* a `prerender` method an offscreen pass, with a state
setup and teardown every frame (`hasOffscreenPass()` is
`prerender !== undefined`). So the base defines neither. Sunlight, AO and
temperature declare a `prerender`, and tree does not, as today. Every block of
three.js drawing is wrapped in `this.pass(...)`. Temperature's `prerender`
only publishes its DAG node and draws nothing, so it does not use `pass`.

### Lifecycle

- **`onAdd(map, gl)`.** Stores `map`. If there is no renderer yet, or `gl` is
  not the context the renderer was made on, it disposes the old renderer,
  makes a new one (`canvas: map.getCanvas(), context: gl`,
  `autoClear = false`), and calls `contextChanged(renderer)`. There the layer
  drops GPU resources tied to the old context and probes capabilities: AO and
  sunlight drop their render targets and read `EXT_color_buffer_float`. If
  the layer implements `viewSettled`, it subscribes to `idle`. Last, it calls
  `attached()`: tree refreshes, and sunlight and AO replan.
- **`onRemove()`.** Unsubscribes from `idle` and drops `map`. It keeps the
  renderer, because a style change re-adds the layer against the same
  context.
- **`viewSettled()`.** A burst of `idle` events inside one task calls it
  **once**, on a microtask, as the three layers each did by hand. A layer
  that does not implement it is never subscribed to `idle` (temperature).
- **`dispose()`.** Disposes the renderer and forgets `gl`. It is for map
  teardown only, and is reached through the layer's mount.

### `pass(fn)`

Calls `fn(renderer)` between `renderer.resetState()` calls, **before and
after**. It does nothing when there is no renderer. Every block of three.js
drawing in `render` or `prerender` goes through it. A layer that must answer
without a renderer (sunlight resolving pending probes as `none`) does that
outside `pass`.

This is the one behaviour change: tree's and sunlight's `render` now also
reset **after** drawing. MapLibre marks its own state dirty after a custom
layer (`context.setDirty()`), so no visible change is expected. The reset
leaves nothing of three.js bound between frames, and it brings sunlight back
in line with its spec.

## Helpers

- **`projection(args, model): THREE.Matrix4`** is
  `args.defaultProjectionData.mainMatrix × model`. It is the one place the
  MapLibre v6 hand-off is written. The cast from gl-matrix's `mat4` is inside
  it. Tree, sunlight and temperature set their camera's `projectionMatrix`
  from it. AO multiplies it into its own shader uniforms.
- **`mercatorFrame(origin, metre): THREE.Matrix4`** is a translation to
  `origin` (a Mercator point: `x`, `y`, and `z`, default 0) times
  `scale(metre, −metre, metre)`. It maps a local frame in metres (`x` east,
  `y` north, `z` up) onto Mercator, whose `y` points south. Sunlight and
  temperature (from a domain's centre), AO (from its frame's origin) and tree
  (then rotated so its meshes' `y` is up) build on it.
- **`PREMULTIPLIED_OVER`** holds the blend parameters for a `ShaderMaterial`
  that emits premultiplied colour composited *over* the frame:
  `CustomBlending`, `ONE, ONE_MINUS_SRC_ALPHA` for colour and alpha. The
  sunlight and temperature overlays spread it. The tree's standard materials
  keep `premultipliedAlpha: true`, three's own form of the same rule. The
  sunlight light pass keeps its additive blend, because it accumulates
  optical depth and is not composited.

## Invariants

All asserted by vitest, on a fake map and a fake context. The base makes its
renderer through a protected `createRenderer(map, gl)`, which a test subclass
overrides, so no WebGL is needed.

1. Two `onAdd` calls with the same `gl` make one renderer and call
   `contextChanged` once. A different `gl` disposes the old renderer, makes a
   new one, and calls `contextChanged` again.
2. `onRemove` keeps the renderer and unsubscribes from `idle`.
3. Several `idle` events in one task call `viewSettled` once. A layer without
   `viewSettled` never subscribes to `idle`.
4. `pass` calls `resetState` before and after `fn`, and does nothing without a
   renderer.
5. `projection` reads `mainMatrix`. Given arguments whose `mainMatrix` and
   `modelViewProjectionMatrix` differ, the result follows `mainMatrix`.
6. `mercatorFrame(origin, metre)` maps local `(x, y, z)` to
   `(origin.x + metre·x, origin.y − metre·y, origin.z + metre·z)`.
7. No file under `src/layers/` constructs a `WebGLRenderer`, calls
   `resetState`, or reads `mainMatrix`. `lib/tiles/structure.test.ts` reads
   the source files, and it also adds `lib/three` to the shared modules that
   must not import a layer.
8. Each of the four classes is a `ThreeLayer` and declares `prerender`
   exactly when it did before: sunlight, AO and temperature do, tree does
   not.

## Out of scope

- Sharing one renderer between the four layers. Each still owns its own,
  because their render targets, state and lifetimes differ.
- The layers' own passes, shaders and render targets.
- Context-loss recovery beyond what `onAdd` already does on a new context.
