# DECISIONS

Append new decisions at the **top**. Each entry: what was decided, what it
rules out, and what would make us revisit it. A decision that is reversed gets a
new entry — the old one stays, marked superseded.

---

## 2026-09-23 — Surveyed height has no upper bound

**Decision.** `trees.height_m` is kept whenever it is positive. The `(0, 40]`
range that `01_schema.sql` enforced and `02_load.sql` applied is gone; only a
zero or negative height still becomes `NULL`. Diameter's `(0, 400]` range is
untouched. This supersedes the cleaning rule introduced with the tree layer.

**Why.** The 40 m cut was calibrated on the two values that are obviously junk —
2023.0 in the street file, a survey year typed into the height field, and 797.0
in the park file — but it could not tell those apart from a genuinely tall tree,
so it took 22 rows with them. Discarding a real height is the more expensive
error: a `NULL` renders as the 9.1 m median and reads as ordinary, whereas an
absurd spike reads as bad data at a glance and points at the row that needs
fixing upstream. The threshold also could not survive contact with drop-in data,
where the plausible range is whatever the supplier's trees happen to be.

**What it rules out.** The map now draws a 2,023 m and a 797 m tree, and the
mesh half keeps the **tallest** instances when it exceeds `MAX_INSTANCES`, so
those two are the rows least likely to be culled — they are permanent fixtures
of any view that contains them. Anything wanting a bounded height range (a
colour ramp keyed to height, a height histogram, an auto-fitted camera) must
clamp for itself rather than trusting the column. Rows with a `NULL` height fall
from 78 to 56.

**Revisit when.** Per-row provenance exists — a way to say *this* value is a
keying error without also indicting every tall tree. A confidence column, or a
correction file under `data/custom/`, would let the junk be nulled by name
instead of by threshold, which is the thing a threshold was standing in for.

---

## 2026-09-23 — Custom tree data is a third `kind`, not a second source

**Decision.** Trees that are not the city's open data — anything dropped into
`infra/data/custom/` as `TreeID,TreeType,Diameter,TreeHeight,LAT,LON` — load
into the same `trees` table with `kind = 'custom'`, and reach the app through
the same Martin source, the same tile URL and the same properties. The app gains
one union member, one colour and one segment in the Tree kind control. It gains
no second source, no second GeoLibre record and no code path of its own.

**Why.** A custom tree is the same object as a surveyed one: a point with a
species, a height and a diameter. The parts of the layer that are hard — one
source feeding two renderers, dedup by `tree_id`, the paint bridge, the bounds
and zoom floor — are indifferent to where a row came from, and duplicating them
for a second source would double the surface while changing nothing on screen.
`kind` already existed as the discriminator for exactly this reason.

**What it rules out.** Custom rows carry no district, place or survey date —
the drop-in schema has no columns for them — so `district` lost its `NOT NULL`
and a NULL district is now how a custom row is recognised. Per-dataset styling,
per-dataset visibility and per-dataset attribution are all out of reach without
revisiting this: there is one `custom` bucket, not one bucket per file.

Two couplings are accepted rather than solved. `TREES_BOUNDS` is still a
hand-measured constant, so custom trees outside it render nothing until it is
widened — `infra`'s load prints the extent per kind so the cause is visible.
And `TreeKindFilter` in `index.ts` is still mirrored by `TreeKind` in
`treeLayer.ts`, so a fourth kind means editing both.

**Revisit when.** A drop-in needs its own colour, its own toggle or its own
attribution line — at that point `kind` is being asked to carry dataset
identity, which it cannot, and the right move is a `source` column with the
filter driven from the loaded values rather than from a hardcoded union.

---

## 2026-09-22 — Tree data from local PostGIS + Martin, read back from MapLibre's own tiles

**Decision.** Taipei's 162,930-tree inventory is loaded into PostGIS and served
as vector tiles by Martin (`infra/`). The tree layer consumes it as **two**
GeoLibre records from **one** source: `tree-points`, an ordinary `vector-tiles`
record drawing circles city-wide from z14, and `tree-mesh`, the existing
external-native three.js record drawing instanced geometry in the viewport from
z16. The mesh half fetches nothing — it reads the tiles MapLibre already parsed,
via `querySourceFeatures`.

**Why.** 163k trees cannot all be three.js meshes, and circles alone waste the
surveyed heights. Two renderers over one source means the views cannot disagree,
and — the point that decided it — the app still makes **no `fetch()` of its
own**: no async state, no loading or error paths, no CORS surface beyond the tile
URL, despite now having a backend.

**What it rules out.** The app does not talk to Postgres, does not hold a second
endpoint, and does not gain a data-fetching layer. `source.tiles` is used rather
than Martin's TileJSON, whose tile URL is absolute and would bypass the Vite
proxy. And the two records are **not** independent: hiding `tree-points` would
starve the mesh layer of data, so it stays visible at zero opacity instead. That
coupling is the price of the design and is recorded as an invariant in the spec.

**What it reverses.** The tree layer was a single procedural tree at a hardcoded
coordinate, deterministic across reloads. The mesh *shape* is still
deterministic; the *scene* is not — it depends on the viewport. `TREE_LOCATION`
is retired and `TreeSettings.height` (absolute metres) becomes `heightScale`,
because an absolute height is meaningless once every tree carries its own.

**Revisit when.** The inventory needs per-species geometry (glTF), or a second
dataset wants the same treatment and the points/mesh pairing is worth extracting
into something reusable. Also if Martin ever has to be reachable from anywhere
but a developer's machine — none of this considers auth, caching or uptime.

## 2026-09-22 — Split the repo into `app/` and `infra/`

**Decision.** The Vite app moves from the repo root into `app/`, taking its
`ai/` documentation set with it, and a sibling `infra/` holds the local data
stack and the raw open-data extracts it loads. `CLAUDE.md` splits in two: the
root file carries the rules that govern every package (spec first and approved,
no spec/code drift, tests, docs current), `app/CLAUDE.md` carries the
layer-specific mechanics. The root `README.md` stays at the root and describes
both.

**Why.** The app is about to consume data from a PostGIS + Martin stack we run
ourselves. That stack is not a dependency of the app in any npm sense and must
not become one — but it does need a home, a schema, a loader and its own
documentation. Leaving the app at the root would have forced the backend to
either live inside the frontend package or float in an unnamed sibling
directory. Naming both packages makes the boundary explicit.

**What it rules out.** No workspaces and no root `package.json`:
`app/package.json` remains the only one, and every npm command is run after
`cd app`. `app/` must never import from `infra/` — it reaches the data over HTTP
like any other tile source, so the app still runs, minus those layers, with
nothing else running. This is what keeps `infra/` optional rather than required.

**What did not change.** No behaviour, and no build configuration.
`tsconfig.json` includes only `["src", "vite.config.ts"]` and `vite.config.ts`
holds no paths, so the move was six `git mv`s and nothing else. The three
load-bearing MapLibre worker settings are untouched.

**Revisit when.** A second frontend appears, or `infra/` grows something the app
genuinely needs to import (generated types from the schema would be the likely
trigger). At that point workspaces stop being overhead and start paying for
themselves.

## 2026-09-22 — Adopt the slate/blue desktop-tool visual language

**Decision.** Replace the app's visual system with the one described in
`new_visual_design.md`: a neutral slate palette on a `#14161a` ground, **one**
blue accent (`#2c66c9`), flat opaque cards on a 4/6/8/999 radius scale, the
system font stack with no web fonts, an 11/12/13/15px type scale, and a
three-column shell (36px top bar, 340px controls, viewport, 340px sidebar) in
place of chrome floating over a full-bleed map. Recorded in full in
[VISUAL_DESIGN.md](VISUAL_DESIGN.md).

**Why.** The app is a tool for judging a 3D scene, and the previous system — a
tinted instrument panel with a vignette, film grain, a 58px display wordmark and
staggered panel entrances — competed with the thing being judged. The new
language also brings a semantic discipline the old one had no room for: a
bright-on-dark badge pattern, a red/amber banner pair that distinguishes *empty*
from *incomplete*, and the rule that state is never carried by colour alone.

**What it reverses.**

1. **The chrome accent no longer tracks the basemap.** `--accent` was set per
   basemap so the interface re-tinted with the map. A single stable accent is
   what makes the semantic set mean anything (blue = active, green = fine, amber
   = not what it looks, red = broken), and the accent now holds structural roles
   — selection border, selected-row ground, checkmark column — that must survive
   a `setStyle()` teardown. The basemap's colour identity stays in the map, as
   `buildingColor`.
2. **Web fonts come out** of `index.html`; zh-TW now resolves through PingFang TC
   / Microsoft JhengHei in the system stack.
3. **Radius everywhere**, replacing a deliberately zero-radius interface.
4. **Opaque columns beside the map** rather than translucent panels over it —
   `backdrop-filter`, the vignette and the grain are removed, and decorative
   motion goes with them.

**Resolved with approval.** `accent` is **removed** from `Basemap`, from all four
catalogue entries and from the basemaps spec, which previously described it as
"the tint the custom chrome adopts, so the UI tracks the map". A basemap's colour
identity now reaches the app only as `buildingColor`.

**Status.** Landed. `src/styles.css` is rewritten, `src/App.tsx` restructured
into the three-column shell, `index.html` drops the web fonts, `ui/Panel.tsx`
carries the new primitives and `ui/LayerMenu.tsx` is new. Verified in a browser
at 1440px and 820px: layer sync live, the three.js tree still rendering and
correctly occluded after a full `setStyle()` teardown to another basemap.

**Outstanding.** The tree's hemisphere ground colour is the one thing the new
language condemns that this change did not fix — it alters rendered output, so it
needs a tree-spec amendment first. See `VISUAL_DESIGN.md`.

---

## 2026-09-22 — `ai/` docs live beside the specs, not inside them

**Decision.** Orientation documentation (`DESIGN`, `ARCHITECTURE`,
`CONVENTIONS`, `DECISIONS`, `WORKFLOWS`, `STACK`, `VISUAL_DESIGN`) lives in a
top-level `ai/` folder. Each layer's `specs/spec.md` remains the source of truth
for that layer's behaviour and is not duplicated here.

**Why.** The specs answer "what must this layer do"; they are the wrong place
for "why is the repo shaped like this" or "how do I run the thing". Mixing the
two makes the spec unreliable as a contract.

**Rules out.** Restating layer contracts in `ai/`. When the two disagree, the
spec wins and the `ai/` doc is the bug.

---

## 2026-09-22 — Every layer, plugin, or extension is a folder with a spec

**Decision.** `src/layers/<name>/` with a mandatory `specs/spec.md` and an
`index.ts` as the sole entry point. Adding a layer means adding a folder, never
a file in `src/lib`. `src/lib` is reserved for the shared engine (`useMapEngine`)
and its data (`viewpoints`).

**Why.** The app's whole subject is *layers*. Filing them as loose modules made
the boundary between "thing GeoLibre renders" and "app plumbing" invisible, and
left their contracts undocumented.

**Rules out.** Cross-folder deep imports. `buildings` may import
`../basemaps` (its `index.ts`) but not `../basemaps/something-internal`.

**Revisit when.** A layer grows a second consumer that needs internals — that is
a signal to promote the shared piece to `src/lib`, not to loosen the rule.

---

## 2026-09-22 — `basemaps` is an extension, not a layer

**Decision.** `basemaps` lives under `src/layers/` and carries a spec, but
produces no `GeoLibreLayer` record. It owns the MapLibre style the GeoLibre
layers are synced into and conditions it (`hideBasemapBuildings`,
`firstLabelLayerId`, `anchorUnderLabels`).

**Why.** It is the only module besides `useMapEngine` that legitimately touches
the map. Giving it a folder and a spec makes that exception explicit and
auditable rather than accidental.

**Constraint it carries.** Nothing in it may mutate a layer whose id starts with
`layer-` — that prefix is GeoLibre's.

---

## 2026-09-22 — The three.js tree rides in the same `sync()` call as the buildings

**Decision.** The tree is a `GeoLibreLayer` record on GeoLibre's external-native
path (`metadata.customLayerType: "threejs"`, `nativeLayerIds`,
`paintMode: "plugin"`), synced as `sync([buildings, tree])`. Visibility and
opacity reach three.js through `setExternalNativePaintBridge`; height does not,
because height is not a GeoLibre concept.

**Why.** The alternative — adding the custom layer beside GeoLibre and managing
its stacking by hand — would have proved nothing. The point of the app is that a
foreign renderer can be a first-class member of the layer list.

**Rules out.** Calling `tree.setOpacity` / `setVisibility` from the UI directly.
Those two must go through the bridge.

**Cost.** `map.setStyle()` destroys custom layers and GeoLibre only *moves*
native layers that already exist, so the custom layer must be re-added on every
`style.load`. That is now an invariant of the engine.

---

## 2026-09-22 — `renderingMode: "3d"`, sharing MapLibre's depth buffer

**Decision.** The custom layer declares `renderingMode: "3d"` so the OSM
extrusions occlude the tree rather than the tree always drawing on top.

**Evidence.** From bearing 180°, the tree's visible area drops 93% with
buildings on versus off. Losing that is a regression, not a style change.

**Cost.** Two rules follow from sharing one GL context: materials must be
`premultipliedAlpha: true` (MapLibre blends with `ONE, ONE_MINUS_SRC_ALPHA`), and
`renderer.resetState()` must run every frame with `autoClear = false`.

---

## 2026-09-22 — Project the tree with `defaultProjectionData.mainMatrix`

**Decision.** In `render(gl, options)`, use
`options.defaultProjectionData.mainMatrix` — the matrix taking unit Mercator
coordinates to clip space — and multiply it by a model matrix built from
`MercatorCoordinate`.

**Why it is worth an entry.** MapLibre v6 no longer passes the bare matrix that
every v2/v3-era three.js recipe destructures, and
`modelViewProjectionMatrix` is a *different world space*: using it puts the mesh
far outside the frustum **with no error of any kind**. The failure mode is a
silent blank map, so the wrong choice is easy to make twice.

---

## 2026-09-22 — Colour and the min-height filter read unexaggerated height

**Decision.** `heightScale` is applied only via
`style.extrusionHeightScale`. It must not appear in the colour expression or in
the filter, both of which read `["to-number", ["get", "render_height"], 0]`
directly.

**Why.** Exaggeration is a viewing aid. If it leaked into colour, the ramp would
lie about how tall a building is; if it leaked into the filter, "min height 30 m"
would mean something different at every exaggeration setting.

---

## 2026-09-22 — Buildings draw above the basemap labels by default

**Decision.** `createLayerSync` appends to the top of the stack and that is kept
as the default. The `labelsOnTop` setting opts into calling `anchorUnderLabels`
after each sync.

**Why.** Labels styled for a dark ground are unreadable over lit building faces.
The common case should look right without a control.

**Alternative rejected.** Asking GeoLibre for an insertion point — the sync API
does not offer one, and re-anchoring after the fact is honest about that.

---

## 2026-09-22 — One OSM snapshot for ground plane and extrusions

**Decision.** `OSM_TILEJSON` (`https://tiles.openfreemap.org/planet`,
OpenMapTiles schema, no API key) is owned by `basemaps` and imported by
`buildings`. Attribution (`OSM_ATTRIBUTION`) travels with it.

**Why.** Basemap and buildings can then never disagree about where a building
is. A second source would also mean a second attribution obligation.

**Obligation.** MapLibre's `AttributionControl` is disabled
(`attributionControl: false`), so the app's status bar **must** render
`OSM_ATTRIBUTION`. Removing it is a licensing regression.

---

## 2026-09-22 — Two MapLibre worker settings, kept deliberately

**Decision.** Keep `optimizeDeps.exclude: ["maplibre-gl"]` and
`worker.format: "es"` in `vite.config.ts`, and set
`maplibreConfig.WORKER_URL` from `maplibre-gl-worker.mjs?worker&url` at module
scope in `useMapEngine.ts`. Also `resolve.dedupe` for `maplibre-gl`, `react`,
`react-dom`.

**Why.** MapLibre resolves its worker as a sibling of its own module URL. Vite's
pre-bundler rewrites the module into `.vite/deps` without copying the worker
(dev 404), and in a production build the dynamic path means Rollup emits no
worker asset at all. Either way: no tile is ever parsed, and the map is a black
rectangle with a clean console. `dedupe` guarantees GeoLibre's sync and the map
instance come from the same copy of the library.

**Revisit when.** MapLibre ships a worker resolution that survives bundling.
Until then, treat these three lines as load-bearing.

---

## 2026-09-22 — Headless GeoLibre, hand-built chrome

**Decision.** Depend on `@geolibre/map` + `@geolibre/core` only. No React
bindings, no Zustand store, no Cesium, no GeoLibre controls, and no MapLibre
`NavigationControl`. The entire interface is hand-written against
`src/styles.css`, with no component library.

**Why.** The claim being demonstrated is that the engine is usable headlessly.
Bundled chrome would blur it, and a UI kit would make the app about the kit.

**Cost.** Panel, Slider, CheckboxRow, Segmented, the compass and the layer menu
are maintained by hand. Accepted.
