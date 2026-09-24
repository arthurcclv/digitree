# WORKFLOWS — how work gets done

## Commands

```bash
npm install
npm run dev       # vite, http://localhost:5173
npm run build     # tsc -b && vite build  →  dist/
npm run preview   # serve dist/
npm test          # vitest run
npm run test:watch
```

`npm run build` and `npm test` are the automated gates; there is no linter and
no CI. The build is a real gate — `tsc -b` runs under `strict` with
`noUnusedLocals`/`noUnusedParameters`, so dead code fails it — and `tsc -b`
covers the test files too, since `tsconfig.json` includes all of `src`.

`npm test` covers what can be tested without a map: the species → form table,
the geometry builders and canopy hulls, and the sunlight layer's pure parts —
sun, frame, state gate, tile planning and coverage, the tile store (on a fake
`fetch`), α table, GeoTIFF writer, record and Taipei-time helpers. It cannot
cover a GL context, a MapLibre source or the
paint bridge, so it does not replace the browser check below.

**Always run `npm run build` before calling a change done**, especially any
change touching the worker settings or the tree layer: those fail at runtime, not
at compile time, and dev and production fail for *different* reasons (see
`DECISIONS.md`).

## The loop for a behaviour change

The spec is the gate, not the paperwork afterwards.

1. **Read the spec** for the layer you are touching —
   `src/layers/<name>/specs/spec.md`. Engine and app changes still need the specs
   of the layers they affect; `useMapEngine`'s style-load cycle is constrained by
   all three.
2. **Edit the spec first** to describe the new behaviour, and **present it for
   approval before writing implementation code.** Do not code ahead of an
   approved spec change.
3. Implement.
4. **Add a test.** New functionality and bug fixes need one; manual verification
   alone is not enough. `npm test` runs `vitest`; tests live beside the code as
   `*.test.ts` inside the layer folder. If the behaviour genuinely cannot be
   reached without a map, say so in the change rather than skipping the step.
5. **Update the `ai/` docs in the same change** if the change alters module
   structure (`ARCHITECTURE.md`), adds or reverses a technical decision
   (`DECISIONS.md`, newest at top), introduces a coding convention
   (`CONVENTIONS.md`), changes a dependency (`STACK.md`), or changes a
   colour/type/spacing/component rule (`VISUAL_DESIGN.md`).
6. `npm test`, `npm run build`, then check it in the browser.

A diff that changes behaviour without a corresponding approved spec update is
incomplete. So is one that silently invalidates an `ai/` doc.

## Adding a layer

1. `src/layers/<name>/specs/spec.md` — written and approved **before** the
   implementation lands. It must describe the layer's contract with GeoLibre, its
   settings, and its invariants. Copy the shape of an existing spec: Purpose,
   Identity, Source, Settings, then Invariants.
2. `src/layers/<name>/index.ts` — the only entry point. Export a
   `<Name>Settings` interface, a `DEFAULT_<NAME>_SETTINGS`, and a function that
   turns settings into a `GeoLibreLayer` record.
3. Add the record to the `sync([...])` array in `useMapEngine.applyLayers`.
   Later entries end up higher in the stack.
4. Add state and a `Panel` in `App.tsx`. Panels are numbered (`index="05"`) and
   staggered (`delay`); keep the sequence contiguous.
5. Update `ARCHITECTURE.md`'s module inventory, and the layout tables in
   `README.md` and `CLAUDE.md`.

If the new thing renders itself rather than being rendered by GeoLibre, follow
the tree: external-native metadata, a paint bridge for anything GeoLibre models,
re-add on `style.load`, and direct calls only for concepts GeoLibre lacks.

## Debugging

**The map is a black rectangle and the console is clean.** Almost always the
worker. Check the Network tab for a 404 on `maplibre-gl-worker`, and check that
the three settings from `DECISIONS.md` are intact. If the tree specifically is
missing, suspect the projection matrix — the wrong matrix puts the mesh outside
the frustum with no error at all.

**A control does nothing.** Confirm the settings object actually changed
identity (the `patch` helpers spread, so it should), then confirm
`styleReadyRef` is true — nothing syncs before `style.load`.

**Something breaks only after a basemap swap.** `setStyle()` wipes everything.
Whatever it is has to be re-established in `onStyleLoad`, not once at startup.

**A layer sits at the wrong height in the stack.** `createLayerSync` appends to
the top; order within the `sync([...])` array is the only other lever, plus
`anchorUnderLabels` afterwards.

In dev the map is exposed as `window.__map` for console poking. It is gated on
`import.meta.env.DEV`; do not depend on it in app code.

## Checking the trees

Fly to viewpoint `Trees` (07) — a vantage over a dense part of Da'an — and get
above z16, where the meshes start. Then:

- **Occlusion.** Toggle Extrusion off and on at a low bearing. The trees should
  be substantially hidden by buildings when they are on; if they always draw in
  front, the layer has lost `renderingMode: "3d"` and its share of MapLibre's
  depth buffer.
- **Both mesh sources.** Switch *Mesh source* between Generated and Modelled.
  The trees must change shape and nothing else — same count, same positions,
  same heights. A tree that moves or resizes means the model's `baseHeightM` is
  being declared somewhere instead of measured.
- **The models actually arrived.** With Modelled selected the panel shows
  `Modelled forms 8/8`. Anything less means a `.glb` 404ed and those forms are
  still drawing generated — which is the designed degradation, not a crash, so
  nothing in the console will tell you.
- **Level of detail.** Descend to z20 and the closest trees should gain
  detail while the distance does not change shape, jump height, or shift. Most
  trees draw level 1 at any zoom — at pitch 70 most of the visible ground is
  beyond 300 m — which is the design, not a bug. `MODEL_LODS` in `models.ts` is
  the ladder: each row is a rung, and adding one is a row there plus a row in
  `LEVELS` in the prep script.
- **Rotation.** Trees on one street must face different ways, and must face the
  *same* ways after a reload and after a source switch. A street that fans
  gradually rather than scattering means the `tree_id` hash has lost its
  finalizer and is leaking the ids' sequence — see `placement.ts`.
- **Opacity reaches them.** Pull Opacity down with Modelled selected. A model's
  own materials fade only if they made it into the layer's material registry;
  a part left opaque while the rest of the canopy fades is a registry bug.

## Checking the direct-sun overlay

Turn on **Direct sun → Overlay** at z12 or above. The first view at z12
fetches most of the city (about 80 tiles per source), so expect a few seconds
before *Tiles* stops showing "loading". The pure parts are tested; these are
the parts only a GPU can show:

- **Shadows fall away from the sun.** At 10:00 they point west, at 15:00 east.
- **The whole view is covered.** Once *Tiles* shows no "loading", every piece of
  ground in view is coloured, at any pitch and down to a 10° sun, out to ±8 km.
  Hatching now means a tile failed or is still loading, never "near the edge".
  Ground that stays uncoloured with nothing loading means the fetch plan missed
  it. The classic cause is a canvas corner above the horizon, where
  `unproject` returns a mirrored point behind the camera.
- **Probe values multiply.** Click a lone street tree's shadow: `0.500` with the
  placeholder α. Where two crowns overlap: `0.250`. Open pavement: `1.000`.
  Anything else under a lone crown means a crown is being counted more or less
  than once per ray.
- **Display controls change nothing.** Probe a point, then hide the buildings
  and the trees, change the kind filter and both exaggerations, and probe
  again: the number must not move. The overlay fetches its own tiles, so a
  change means it has started reading display state.
- **Export.** The GeoTIFF opens in QGIS or `gdalinfo` as EPSG:3857 with NoData
  `-1` and the sun time in its metadata.

A browser harness for all of this (Playwright, reading `window.__map`) is easy to
rebuild: the layer is reachable as
`__map.getLayer("threejs-sunlight-native").implementation`, whose `probe()` and
`status()` are the same calls the panel makes.

## Preparing tree models

The `.glb` files under `public/models/trees/` are not the files that were
downloaded — they are texture-downscaled, WebP-re-encoded copies, about a tenth
the size. To add or re-prepare one:

```bash
python3 tools/prepare-tree-models.py <dir-of-original-glb-files>
```

It writes **one file per rung of the detail ladder** — `<name>.glb` at level 0
and `<name>.L1.glb` above it — regenerates `CREDITS.md` from each file's
`asset.extras`, and **refuses** anything not under a CC-BY licence, since
`public/` is downloadable by definition. `npm test` asserts the same things from
the other end, so a model that slips in, or a rung that failed to decimate,
fails the suite.

It needs `@gltf-transform/cli`, so run `npm install` in `app/` first.

The models are committed through **Git LFS** (`.gitattributes` at the repo
root). A clone made without LFS installed gets pointer files: the models 404,
the panel reports fewer than 8 modelled forms, and the generated source carries
on unaffected. Run `git lfs install && git lfs pull` to fix it.

## Git

Branch off `main`. Commit or push only when asked. Commits end with the
attribution line the session's instructions specify.
