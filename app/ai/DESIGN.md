# DESIGN — what Taipei 3D is for

Product orientation. Behaviour of any individual layer lives in that layer's
`specs/spec.md`; this file explains *why* the app exists and what it must feel
like to use.

## The one-line premise

A 3D map of Taipei that demonstrates **GeoLibre 3.0.0 used headlessly** — every
visible thing on screen is either OpenStreetMap data described to GeoLibre as a
layer record, or hand-built chrome. Nothing is GeoLibre's own UI, because the
headless package ships none.

## Who it is for

Someone evaluating GeoLibre as an engine rather than as an application. The
questions they arrive with:

- Can I drive it without React bindings, its Zustand store, or Cesium?
- Can I put *my own* renderer (three.js) into its layer stack, or do I have to
  bolt it on beside the map?
- What does a control surface look like when every control is a re-description
  of a layer rather than an imperative map call?

The app answers all three by being a working thing, not a README.

## What it shows

| Surface | Purpose |
| --- | --- |
| OSM building extrusions | the payload — real city data, coloured by height |
| Four basemaps | that a full `setStyle()` teardown is survivable |
| The three.js tree | that a foreign renderer can ride in the same `sync()` call |
| The direct-sun overlay | that the scene is data, not decoration: the same trees and buildings, analysed live |
| The PET overlay | that one analysis can build on another: felt temperature derived from the direct-sun result, recomputed whenever it changes |
| Eight viewpoints | that Taipei is legible from ground level, not just overhead |
| Camera readout | that the camera is real and the data has a source |

## Product principles

1. **Describe, never command.** Every control in the panel changes a settings
   object; the settings become a `GeoLibreLayer` record; the record goes to
   `sync()`. A control that calls `map.setPaintProperty` would defeat the entire
   demonstration. Camera movement is the sole exception — GeoLibre does not
   model a camera, so `flyTo`/`easeTo` go straight to MapLibre.

2. **One OSM snapshot.** The ground plane and the extruded buildings come from
   the same OpenFreeMap tile source, so they can never disagree about where a
   building is. This is why the basemaps module owns the tile URL and the
   buildings layer imports it.

3. **Honest numbers.** Height exaggeration is a *view* control: it must never
   leak into the colour ramp or the minimum-height filter. A 40 m building stays
   the colour of a 40 m building at 4× exaggeration, and "min height 30 m" means
   30 real metres. The camera card shows the true camera, not a rounded
   marketing version of it.

4. **Attribution is not decoration.** MapLibre's `AttributionControl` is
   disabled, so the status bar carries `OSM_ATTRIBUTION`. Removing it is a
   licensing regression. See the basemaps spec.

5. **Findable.** A 13 m tree in a city of towers cannot be found by panning, so
   the tree is a viewpoint. Anything the app renders must be reachable in one
   click.

6. **No component library, no map controls.** The chrome is hand-built because
   the point is that the engine is headless. Adding a UI kit or a MapLibre
   `NavigationControl` would blur the claim.

## Non-goals

- Not a basemap editor, a data-upload tool, or a GIS. There is no project
  concept and no persistence. There *is* now a server — the local PostGIS +
  Martin stack in `infra/` that serves the tree inventory — but it is a data
  source the app reads over HTTP, not a backend the app owns: no accounts, no
  writes, no session, and the app runs without it.
- Not a GeoLibre feature tour. Only the parts that prove the three questions
  above are wired up.
- Not mobile-first. Below 900px the shell becomes one scrolling column with the
  map on top (see `VISUAL_DESIGN.md`), but the target is a desktop browser with a
  GPU.
- No accounts, no analytics, no network calls beyond tiles and the tree models.
  The app made no `fetch()` call of its own for a long time, including after it
  gained a data source of its own — the 3D trees read back the vector tiles
  MapLibre had already parsed. Two exceptions exist, and both are opt-in:
  - the **modelled** mesh source loads eight glTF files from the app's own
    `public/`;
  - the **direct-sun overlay** fetches tiles itself, the same trees and
    buildings from the same endpoints, beyond the viewport.

  With both off — the default — nothing is fetched but what MapLibre asks
  for, so the sentence above still describes the app you get on load.

## Where the design pressure is

The interesting tension is **stacking order**. `createLayerSync` always appends
to the top of the MapLibre stack. Buildings on top is right by default (basemap
labels styled for a dark ground are unreadable over lit building faces), so the
"Labels over" toggle is opt-in and implemented by re-anchoring after each sync
rather than by asking GeoLibre for an insertion point it does not offer.
