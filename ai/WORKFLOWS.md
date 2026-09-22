# WORKFLOWS — how work gets done

## Commands

```bash
npm install
npm run dev       # vite, http://localhost:5173
npm run build     # tsc -b && vite build  →  dist/
npm run preview   # serve dist/
```

`npm run build` is the only automated gate in the repo: there is no test runner,
no linter, no CI. It is a real gate though — `tsc -b` runs under `strict` with
`noUnusedLocals`/`noUnusedParameters`, so dead code fails it.

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
   alone is not enough. There is no runner configured yet — introducing one is
   itself a decision that belongs in `DECISIONS.md` and `STACK.md`.
5. **Update the `ai/` docs in the same change** if the change alters module
   structure (`ARCHITECTURE.md`), adds or reverses a technical decision
   (`DECISIONS.md`, newest at top), introduces a coding convention
   (`CONVENTIONS.md`), changes a dependency (`STACK.md`), or changes a
   colour/type/spacing/component rule (`VISUAL_DESIGN.md`).
6. `npm run build`, then check it in the browser.

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

## Checking the tree

Fly to viewpoint `The Tree` (07) — 25.0431° N, 121.5374° E, Da'an. It is 13 m
tall by default and unfindable by panning. Verify occlusion by toggling
Extrusion off and on at a low bearing: the tree should be substantially hidden by
buildings when they are on.

## Git

Branch off `main`. Commit or push only when asked. Commits end with the
attribution line the session's instructions specify.
