# VISUAL_DESIGN — the design system

This is the app's visual language, and the values below are the ones actually in
`src/styles.css` — treat it as the reference when adding UI, and keep it in sync
with the CSS.

The app is a **dark, dense, desktop tool UI**: a neutral slate palette, one blue
accent, flat cards, and small semantic status colours — chrome that stays out of
the way of the map viewport. Everything CSS lives in `src/styles.css`; there is
no component library and no CSS framework, by design.

See [CONVENTIONS.md](CONVENTIONS.md) for the code side and [DESIGN.md](DESIGN.md)
for product intent.

## Colour

Values live on `:root` in `src/styles.css`. The governing rule: **if a value
recurs, it is a `:root` custom property.** In this app that is nearly everything,
so the token set below is complete rather than partial — a deliberate
strengthening of the source language, which tokenised only its most-repeated
border.

### Surfaces & structure

| Role | Hex | Token | Used for |
| --- | --- | --- | --- |
| App background | `#14161a` | `--bg` | `body`, the shell, number inputs |
| Side column | `#1b1e24` | `--column` | left control column, right sidebar, top bar (`#191b20`) |
| Panel card | `#20242b` | `--panel` | `.panel` |
| Row hover / menu | `#262b33` | `--raised` | viewpoint row hover, popover menus |
| Border (subtle) | `#2a2e36` | `--border-subtle` | panel and column borders, `.btn.secondary`, footer rules |
| Border / control (raised) | `#384252` | `--border-raised` | scrollbar thumb, disabled button, menu border |
| Border hover | `#55606f` | `--border-hover` | scrollbar hover |

Cards are **flat and opaque**. No `backdrop-filter`, no translucency, no
vignette, no film grain: the side columns are solid surfaces beside the map, not
glass floating on top of it. Depth comes from the surface ladder
(`--bg` → `--column` → `--panel` → `--raised`) and from one border colour, not
from blur.

### Text

| Role | Hex | Token |
| --- | --- | --- |
| Primary text | `#e6e8eb` | `--fg` |
| Secondary body | `#c4cad3` | `--fg-secondary` |
| Muted label / hint | `#9aa3b0` | `--fg-muted` |
| Dimmer label (axis letters, units) | `#7c8592` | `--fg-dim` |
| Faint (counts, carets) | `#7a828f` | `--fg-faint` |

### Accent & semantic

| Role | Hex | Notes |
| --- | --- | --- |
| Primary accent (blue) | `#2c66c9` → hover `#3574e0` | buttons, active toggles, selection border `#3a5ba0`, selected row background `#24304a` |
| Accent text / numeric | `#7fb8e6` | readout values, spinner, neutral badges |
| Success (green) | `#4de08a` on `#123a2b` | "sync live" badge |
| Warning / stale (amber) | `#ffb84d` on `#4a3410` | tile-error badge, stale hints, `.warning-banner` |
| Error (red) | `#ff7d7d` on `#4a1414` | `.error-banner` |

**Semantic colours always pair a bright foreground with a dark, desaturated
background of the same hue** — the badge pattern. Reuse it for any new status
chip rather than inventing a surface.

### One accent, and it does not follow the basemap

The accent is **always** `#2c66c9`. It does not change with the basemap.

This reverses the previous system, where `--accent` was set per basemap so the
chrome re-tinted with the map (amber over Midnight, teal over Fiord, and so on).
Two reasons the new language cannot keep it:

1. A single accent is what makes the semantic set legible. Blue means *active or
   selected*, green *fine*, amber *something is not what it looks*, red *broken*.
   If blue can become amber when the user picks Liberty, the amber badge stops
   meaning anything.
2. The accent now appears in structural roles — a selection border, a selected
   row ground, a checkmark column, a spinner. Those must be stable across a
   `setStyle()` swap that already destroys and rebuilds the whole map.

The basemap's colour identity survives **in the map, where it is data**: each
entry's `buildingColor` is still the flat building fill, and the basemap's own
ground styling is untouched. What is gone is the chrome tint. See the last
section — the `accent` field in the basemaps spec needs an approved change.

## Map viewport (not CSS)

The map and the three.js mesh are coloured by data and by light, not by the UI
palette. **Do not reuse chrome tokens here**, and do not restate these numbers:
they live in exactly one place each, because three copies of a colour table is
three places for it to drift.

| Element | Where the values live |
| --- | --- |
| Building height ramps (`ember`, `jade`, `neon`) | `PALETTES` in `src/layers/buildings/index.ts`, described in its spec |
| Flat building colour per basemap | `BASEMAPS[].buildingColor`, in the basemaps spec table |
| Tree circle colour per kind (street / park / custom) | `COLOR_*` in `src/layers/tree/index.ts`, described in its spec |
| Tree bark / leaf materials | `buildTree()` in `src/layers/tree/treeLayer.ts` |
| Tree light rig (hemisphere + directional) | `buildLights()` in the same file |
| MapLibre extrusion light | the `map.setLight` call in `useMapEngine.ts` |

**The ramps deliberately do not reuse the chrome palette.** A ramp answers a
question — *how tall is this building* — and a ramp drawn in interface blues
invites reading a tall building as a selected one. The ramps share only the
direction: cold is low, hot is high. They are the one place in the app where a
colour is chosen for what it encodes rather than for palette consistency, and
the swatch beside each ramp name in the panel is the ramp itself, not a chrome
token.

### Viewport lighting

**Legibility beats realism.** The user orbits freely to judge the city, and a
face that renders black cannot be judged at all. The tree's rig is a
`HemisphereLight` for sky/ground bounce plus a `DirectionalLight` key; MapLibre
lights the extrusions itself from `setLight` with a viewport anchor, so the
building faces stay lit the same way whatever the bearing.

**A light colour is not a surface colour.** Picking a light for palette
consistency is what makes downward-facing faces read as unlit holes — a
hemisphere *ground* colour wants a mid grey, not the near-black of a panel
surface. The tree's current ground bounce (`0x1b222c`) is almost exactly the
side-column surface, which is the mistake this rule names; correcting it is part
of the migration and is a change to the tree layer's spec, not to this file.

### Text drawn over the map

There is one piece: the **attribution line**, which must be visible whenever the
map is (a licensing obligation — see the basemaps spec). It takes a **plate**:
an 11px `--fg-muted` line on the `--panel` surface with a `--border-subtle`
border, anchored bottom-right inside the viewport.

A plate rather than the outlined-glyph treatment the source language uses for
scene labels, because the cases are opposite: that treatment exists for ~100
transient labels where a plate each would be a grid of rectangles over the
render. This is one persistent, non-negotiable line of legal text over arbitrary
imagery, where a plate is the only thing that guarantees it stays readable.

Anything else ever drawn over the map follows the source language instead —
white glyphs with a 2px black outline, no plate, constant screen size — rather
than inventing a third treatment.

## Typography

- **Font:** system stack — `-apple-system, BlinkMacSystemFont, 'Segoe UI',
  Roboto, 'PingFang TC', 'Microsoft JhengHei', sans-serif`. **No web fonts**, so
  the Google Fonts preconnect and stylesheet come out of `index.html`. The two
  CJK names are explicit rather than left to the browser's sans-serif fallback,
  so the viewpoint subtitles (`信義 · Taipei 101`, `臺北車站 · 中正`) get a
  specific Traditional Chinese face on both macOS and Windows.
- **Scale:** 11px (badges, hints, counts, attribution) · 12px (default UI text,
  labels, rows, readouts) · 13px (buttons) · 15px (the top bar's title). The map
  is the focus, so text stays small and dense.
- **Weights:** 400 body, 500 group rows, 600 emphasis (buttons, badges, panel
  titles, stat values).
- **Panel titles:** 12px, 600, `text-transform: uppercase`,
  `letter-spacing: 0.04em`, `--fg-muted` — the standard section header.
- **Numerics:** always `font-variant-numeric: tabular-nums` for every value,
  coordinate and count, so digits do not jitter while the camera moves. This is
  the one rule carried over unchanged from the previous system, and the camera
  readout is the reason it exists.

There is no display face and no 58px wordmark. The app's name is a 15px/600
label in the top bar; a page-level bar earns a legible label, not a poster.

## Spacing, radius, layout

- **Rhythm:** multiples of ~4/6px. Column and panel padding `12px`; panel card
  padding `10px 12px`; `12px` between panels, `6–8px` within a row.
- **Grouping by gap:** the viewport's icon toolbars are flex rows of
  `.toolbar-group` children — `12px` between groups, `6px` within one. The gap
  *is* the grouping: no divider rule, so nothing extra is painted over the map.
  Add a tool to the group it belongs to, or open a new group; never hang a margin
  off one button.
- **Radius:** `4px` (inputs, menu items, small chips) · `6px` (buttons, rows,
  banners, menus) · `8px` (panel cards) · `999px` (pill badges). The previous
  system had none; the whole interface is now softened on this scale.
- **Layout:** a full-viewport flex **column** (`.app-shell`) — a `36px` fixed top
  bar above a flex **row** (`.app`, `flex: 1`) of three columns:

  ```
  ┌──────────────────────────────────────────────────────────┐
  │ top bar  36px   TAIPEI 3D                     Settings   │
  ├────────────┬──────────────────────────┬──────────────────┤
  │ controls   │ viewport (flex: 1)       │ sidebar          │
  │ 340px      │  ⌐ nav toolbar  layers ¬ │ 340px            │
  │            │                          │                  │
  │ Basemap    │        the map           │ Viewpoints       │
  │ Buildings  │                          │ Camera           │
  │ Ramp       │                          │                  │
  │ Trees      │         attribution ▒▒▒▒ │                  │
  └────────────┴──────────────────────────┴──────────────────┘
  ```

  Both side columns scroll; neither the shell nor `.app` scrolls
  (`overflow: hidden`). The viewport is `min-width: 0` so a narrow window shrinks
  the map rather than overflowing the columns. Side columns reserve scrollbar
  space with `scrollbar-gutter: stable`.
- **Scrollbars:** custom 8px thin thumbs (`--border-raised`, hover
  `--border-hover`), WebKit via `::-webkit-scrollbar` and Firefox via a
  `@supports` block, kept apart deliberately.

The map is no longer a full-bleed backdrop with chrome floating on it. That
change is the point of the new language: a tool UI with a viewport in it, rather
than a poster with controls over it.

## Component patterns

- **Panel** (`.panel`): the base card — `--panel` surface, `--border-subtle`
  border, 8px radius, an uppercase `.panel-title`, then rows. No numbered index,
  no hatched header, no entrance animation. `.panel-title.subhead` is a
  subsection heading inside a body; `.panel-title .badge` trails the title text
  by 8px. `.panel__rule` is a hairline that sets a card's readouts off from the
  controls that drive them. Spacing lives in `styles.css`, never in inline styles.
- **Row** (`.row`): 12px label left, control right, space-between.
- **Slider** (`Slider.tsx`): the reusable control for every bounded scalar —
  height exaggeration, opacity, minimum height, tree height, pitch. Its readout
  is a `.slider-value` **editable text input** (56px, `--bg` field,
  `--border-subtle` border, right-aligned tabular-nums, `#3a5ba0` focus border),
  not a read-only chip: typing `2.5` for height exaggeration is something the old
  drag-only rail could not do. Commits on blur/Enter, reverts on Escape. When the
  row is too narrow, **the range shrinks** (`min-width: 0`) while the label and
  the value box keep their size, so a row never overflows its column. A label
  carrying a unit the user may not know takes the component's `title`, which
  becomes both the hover text and the `aria-label` — one string reaching a pointer
  and a screen reader.
- **Checkbox row** (`.checkbox-row`): inline checkbox + 12px label. This is the
  form every flag takes — Extrusion, Labels over, Tree mesh. It replaces the
  sliding lamp toggle; a flag is a checkbox, and the lamp was a bespoke control
  carrying no information the checkbox does not.
- **Segmented control** (`.segmented`): equal-width buttons in one group, for the
  four basemaps, the four ramp choices (three palettes plus Flat) and the four
  tree-kind choices (All / Street / Park / Custom). Selected is `.active`
  (blue) with `aria-pressed`. The ramp variant carries a small gradient swatch per segment,
  drawn from the palette's own stops — the one place a component shows a data
  colour. Column count is explicit — `--2`, `--3`, `--4` — and must match the
  item count, so a group never leaves a ragged empty cell.
- **Button** (`.btn`): 13px/600, 6px radius. Blue primary; `.secondary` neutral
  on `--border-subtle`; `.active` blue for a toggle that is on; disabled goes
  flat `--border-raised`. `.block` is the full-width stacked form. `.icon-btn` is
  the square viewport toolbar button.
- **Viewport toolbars**: absolutely positioned inside the viewport, top-left and
  top-right, built from `.icon-btn` in `.toolbar-group`s. Top-left is navigation
  — zoom in, zoom out, reset north, and the compass. Top-right is the layer eye
  menu. Icon-only with tooltips, which is the convention everywhere except the
  top bar.
- **Compass** (`.icon-btn.compass`): the hand-drawn SVG rose survives, resized
  onto the `.icon-btn` grid, its needle counter-rotated by the map bearing and a
  click resetting to north. The needle is `--accent`; north is also stated
  numerically in the Camera card, so rotation is never the only cue.
- **Layer menu** (`.layer-menu`, a `.menu` popover): the eye button opens a
  checklist of layer-visibility rows (checkbox + glyph + label) — **Buildings**,
  **Tree**, **Labels over**. Toggling keeps the menu open; it closes on
  outside-click, Escape, or re-click. The same flags also appear in their panels;
  the menu is the fast path, not a second source of truth.
- **Viewpoint row** (`.viewpoint-row`): the eight viewpoints as a `nav` of
  buttons inside one card — a 12px ✓ check column, the name (12px/600), the CJK subtitle
  (11px `--fg-muted`), and the target zoom right-aligned in a `.rate` slot with
  tabular numerals. Current is `.selected`: `#24304a` ground, `#3a5ba0` border,
  **and the checkmark**. Hover is `--raised`. The sweeping accent bar of the
  previous system is gone — selection is the ground plus a glyph, because colour
  alone may not carry state.
- **Camera card**: the live readout — latitude, longitude, zoom, pitch, bearing,
  and the data source — as a `.stat-line` definition list, one line per figure,
  no header row, tabular numerals, values in `--accent-text` (`#7fb8e6`) against
  `--fg-muted` labels. A table header would outweigh six figures. Pitch is a
  `Slider` row in this same card rather than a vertical rail in the corner: it is
  a bounded scalar like every other, and it gains an editable value.
- **Badge** (`.badge`): pill, 11px/600. Variants: `sync` (green on `#123a2b`, the
  layer sync is live), `loading` (neutral blue `#7fb8e6`), and `tile-error`
  (amber on `#4a3410`). The old blinking square is replaced by a labelled badge —
  a blink is motion carrying no more information than a word.
- **Spinner** (`.spinner`): 12px ring, blue top border, 0.7s spin. Shown beside
  the `loading` badge while the first tiles parse.
- **Warning banner** (`.warning-banner`): amber surface and border, for a map
  that is rendering but incomplete — the tile errors `useMapEngine` collects.
  This is the normal case for a network hiccup.
- **Error banner** (`.error-banner`): dark-red surface and border, for a map that
  is not rendering at all — a style that failed to load. **The colour is
  load-bearing: red means the thing below it is empty, amber means it is
  populated but incomplete**, so the two must never be styled alike. The previous
  system had one status chip doing both jobs.
- **Top bar** (`.top-bar`): a 36px strip, `#191b20` with a `--border-subtle`
  bottom rule, visible in every state. Carries the app title (15px/600), an 11px
  `--fg-dim` subtitle naming the data and the engine, and right-aligned: the
  status badge and, below 900px, the plain-**text** `Panels`/`Hide` button. Text
  rather than an icon is the deliberate exception to the icon-only toolbar
  convention — a page-level bar earns a legible label.

  The source language puts a Settings menu here. This app has nothing to put in
  one, and a trigger that opens an empty popover is worse than no trigger, so it
  is left out until there is a setting.
- **Numeric-input chrome** (`.slider-value`): `--bg` field, `--border-subtle`
  border, 4px radius, `#3a5ba0` focus border. A future `.select` or `.text-input`
  takes the same chrome; neither is defined yet, because nothing uses one and the
  stylesheet carries no rule without a consumer.

## Accessibility

- **Semantic roles on every interactive structure.** The viewpoint list is a
  `role="listbox"` of `option`s with `aria-selected`; the layer menu is
  `role="menu"`; the segmented controls carry `aria-pressed` per segment. Preserve
  these when editing components.
- **Never encode state in colour alone.** Every selected state pairs its ground
  with a glyph or a word: the viewpoint row has its ✓, the sync state is a
  labelled badge and not a coloured dot, the compass rotation is backed by a
  numeric bearing, and a tile problem is a sentence in a banner. The rule covers
  **opacity** too — a disabled control dims *and* carries its reason in `title`.
- **Disabled, not hidden.** A control that cannot be used right now dims to
  opacity 0.4 with the reason in `title`, rather than disappearing. An entry that
  vanishes teaches nothing.
- **Contrast.** `--fg` on the dark surfaces is high-contrast. The muted greys
  (`#9aa3b0`, `#7c8592`, `#7a828f`) are for secondary and hint text only — do not
  push a value or a label the user must read into them.
- **Pointer targets.** Thin affordances get larger hit areas than their visible
  bar. Maintain that split when adding a thin control.
- **Map gestures are the map's.** The chrome never covers the viewport except for
  the two toolbars and the attribution plate; drag, scroll-zoom and right-drag
  pitch all stay available across the rest of it.

## Motion

Minimal, and the list is short on purpose: the **spinner**, and a ~150ms opacity
fade on anything that appears or disappears over the map. Transitions on hover
and active states are 0.16s.

**Never ease a deliberate user action.** A checkbox applies instantly; a panel
does not animate in; a badge does not blink. The staggered panel entrance and the
drifting film grain of the previous system are both gone — decorative motion over
a map the user is reading is the most distracting thing static chrome can do.

The one long animation in the app is not chrome: `flyTo`'s 2.2s camera move,
which stays, because the easing is what shows you *where you went*. A cut to a
new viewpoint loses the spatial relationship the animation exists to convey.

`@media (prefers-reduced-motion: reduce)` disables every animation and transition
with `!important`, including the spinner and the fade. Do not write motion that
escapes that block.

## Narrow (≤ 900px)

The source language is desktop-only; this behaviour is the app's own extension,
kept because the app ships on the open web.

`.app` becomes a single scrolling column: the top bar stays fixed, the viewport
takes `order: -1` so the map comes first at `50vh`, and the two panel columns
stack beneath it at their natural height. **The page scrolls, not each column** —
three bounded scroll regions summing past the viewport height strand the last one
off-screen where nothing reveals it. `order` rather than a DOM change, so the
desktop source order stays left-to-right.

The `Panels`/`Hide` button in the top bar sets `data-collapsed` on the shell,
which hides both columns and gives the viewport the full height, leaving the map,
its two toolbars, the status badge and the attribution plate.

## What this replaced

Adopting this language reversed four documented choices; the entry in
[DECISIONS.md](DECISIONS.md) records them in full.

1. **The accent no longer tracks the basemap.** `Basemap.accent` has been removed
   from the interface, from all four catalogue entries and from the basemaps spec.
   A basemap's colour identity now reaches the app only as `buildingColor`.
2. **Web fonts are gone** from `index.html`. Traditional Chinese resolves through
   PingFang TC / Microsoft JhengHei in the system stack, verified rendering in the
   viewpoint subtitles.
3. **Radius everywhere**, on the 4/6/8/999 scale, replacing a deliberately
   zero-radius interface.
4. **The chrome stopped floating.** `backdrop-filter`, the vignette, the film
   grain, the staggered panel entrance and the blinking status dot are all gone,
   in favour of opaque columns beside the map.

**One thing the migration did not do.** The tree's hemisphere *ground* colour
(`0x1b222c` in `treeLayer.ts`) is almost exactly the side-column surface — the
"a light colour is not a surface colour" mistake named above, which makes
downward-facing faces read as unlit holes. Correcting it changes rendered output
and so belongs to the tree layer's spec, which has not been amended. It is
outstanding.

Deliberately **not** adopted from the source language: modals and their backdrop
(nothing here settles a reference to a file on disk — if a dialog is ever added,
it follows the source's rule that a modal is only for a genuinely blocking choice
where the viewport is not what is being judged), the hierarchy tree and its
drag-reorder, vector fields, submenus, comparison tables, and every gizmo family
that belongs to that app's domain. Import a pattern when the app grows the
problem it solves, not before.

## When adding UI

Reuse the palette and the `.panel` / `.row` / `.btn` / `.badge` / `.checkbox-row`
/ `Slider` primitives rather than introducing new colours, fonts, or bespoke
controls. A new semantic status follows the bright-on-dark-same-hue badge
pattern. A value that recurs becomes a `:root` custom property. A colour that
encodes *data* — a height ramp, a mesh material, a light — is chosen for what it
encodes and stays out of the chrome palette entirely.
