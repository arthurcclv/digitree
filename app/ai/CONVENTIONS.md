# CONVENTIONS — how code is written here

House style. Deviating is fine when there is a reason; say the reason in a
comment.

## TypeScript

- `strict`, plus `noUnusedLocals` and `noUnusedParameters`. `tsc -b` runs in
  `npm run build`, so an unused import fails the build, not just the editor.
- `verbatimModuleSyntax` is on: **type-only imports must say `type`.**
  `import type { GeoLibreLayer } from "@geolibre/core"` or
  `import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core"`.
- `isolatedModules` is on: re-export types with `export type`.
- No `any`. Where a foreign API forces a cast, cast narrowly and comment it.
  The model is the MapLibre matrix hand-off in `treeLayer.ts`; `sunlightLayer.ts`
  repeats it, and adds the one read of three.js's private
  `__webglFramebuffer`.
- Exported settings shapes are `interface`; unions and tuples are `type`.
- No default exports except the React page component (`App.tsx`).

## Naming

- Modules and folders: lowercase, one word where possible (`basemaps`,
  `buildings`, `tree`). Multi-word files are camelCase (`useMapEngine.ts`,
  `treeLayer.ts`); React components are PascalCase (`Panel.tsx`).
- Layer record ids are kebab-case and read like data: `osm-buildings`,
  `threejs-tree`.
- Constants that cross module boundaries are SCREAMING_SNAKE and exported from
  the folder's `index.ts`: `OSM_TILEJSON`, `BUILDINGS_LAYER_ID`, `TREE_LOCATION`,
  `TREE_BASE_HEIGHT_M`.
- Settings types are `<Thing>Settings` with a `DEFAULT_<THING>_SETTINGS`
  alongside. The defaults object is the single source of initial state — the app
  never spells defaults out inline.
- A function that builds a GeoLibre record is named for the layer, not for the
  act: `buildingsLayer(settings)`, `treeLayerRecord(settings)`.

## Imports

- Import a layer through its folder: `from "../layers/tree"`. Importing
  `../layers/tree/treeLayer` from outside that folder is a violation even when
  the symbol is exported.
- Relative paths only; no path aliases are configured.
- Import order as it falls out naturally: external packages, then `@geolibre/*`,
  then app modules. Not enforced by a tool — there is no linter.

## Comments

The codebase comments **why**, never what. The standard to match:

```ts
// `map.isStyleLoaded()` is false until every source settles, which is long
// after the style itself is usable; track the style.load event instead.
```

Rules of thumb:

- Every non-obvious constant carries a doc comment explaining the unit or origin
  (`/** Height of the mesh as modelled, in metres; the height control scales from it. */`).
- Every workaround states the failure it prevents, in the present tense, with
  the symptom. "Otherwise no tile is ever parsed and the map is blank" is worth
  more than "worker fix".
- A swallowed `catch` must say why swallowing is correct:
  `/* style reloading mid-flight */`.
- Doc comments (`/** */`) on exported API; line comments inside function bodies.
- Do not restate the spec in code comments — point at the mechanism, let
  `specs/spec.md` carry the contract.

## React

- Function components only. Hooks at the top, no custom hook other than
  `useMapEngine`.
- All control state lives in `App.tsx` as plain objects, mutated through small
  `patch` helpers:
  ```ts
  const patch = (next: Partial<BuildingSettings>) => setSettings((p) => ({ ...p, ...next }));
  ```
- `ui/` components are presentational: props in, callbacks out, no map access,
  no state beyond what a DOM element needs.
- Imperative escape hatches (`flyTo`, `zoomBy`, `setPitch`, `resetNorth`) are
  returned from `useMapEngine` as stable `useCallback`s; components never hold a
  map reference.
- `StrictMode` is on — effects run twice in dev. The map-creation effect is
  guarded by `if (!containerRef.current || mapRef.current) return;` and has a
  real cleanup. Keep both.

## Styling

- **All CSS lives in `src/styles.css`.** No CSS modules, no CSS-in-JS, no
  Tailwind. See `VISUAL_DESIGN.md` for the token set and component rules.
- Component state is expressed through ARIA attributes, and CSS selects on them:
  `aria-pressed="true"`, `aria-selected="true"`, `aria-expanded`,
  `data-collapsed`. There are no `is-active` classes.
- Inline `style` is only for values computed at runtime — a slider's `--fill`.
  It is **not** for spacing, and no longer for the accent: the accent is a fixed
  token, not a per-basemap value (see `VISUAL_DESIGN.md`).

## Accessibility

Not optional, and cheap here: every control is a real `<button>`, `<input>` or
`<label>`, icon-only controls carry `aria-label` and `title`, the layer popover is
a `role="menu"` of `menuitemcheckbox`es, banners carry `role="alert"` (error) or
`role="status"` (warning), and `prefers-reduced-motion: reduce` kills every
animation and transition.

State is never carried by colour alone — see `VISUAL_DESIGN.md`. The sync
state is a labelled badge, not a coloured dot; the compass rotation is backed by
a numeric bearing in its label.

## What does not exist

No linter, no formatter config, no CI. `npm run build` (which runs `tsc -b`)
and `npm test` (`vitest`) are the gates.

Tests sit beside the code they cover, as `<module>.test.ts` inside the layer
folder — not in a parallel `test/` tree. They may import a layer's internals
directly (`./forms`), which is the one exception to the `index.ts`-only rule,
because a test is inside the folder rather than reaching into it.

There is no jsdom and no headless GL: what is tested is what is pure. A module
that wants a test is a module worth keeping free of three.js and MapLibre —
`layers/tree/forms.ts` is the worked example.
