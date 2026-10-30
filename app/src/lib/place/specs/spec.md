# Place — spec

Source of truth for what the app knows about *where it is*, as opposed to the
data it shows. Behaviour changes here require this file to change first.

Modules:
- `src/lib/place/`: `index.ts` (`Place`, `Viewpoint`, and the local-time
  helpers) and `localTime.test.ts`. It is generic and names no city.
- `src/place.ts`: the app's own `PLACE`, the only file that knows it is
  Taipei. It sits next to `src/sources.ts` (see `src/lib/tiles/specs/spec.md`),
  which names the datasets.

## Purpose

After the data-source change, the layers named no endpoints. They still named
a city:
- the sunlight layer exported Taipei-time helpers (`taipeiDate`,
  `taipeiMinutes`, `fromTaipei`, `defaultSunTime`) and the panel's
  05:00–19:00 range, and defaulted its moment to "today, 12:00 Asia/Taipei";
- the tree record was named "Taipei Trees", and both dataset records carried
  a `sourceKind` naming their server;
- the tree layer held `TREE_FALLBACK_HEIGHT_M` = 9.1, which its spec calls
  "a fact about the *data*: the measured median of the inventory";
- the engine held `HOME`, the Xinyi viewpoint.

None of these are how a layer works. They are the host's place and the host's
data. After this change, a layer's interface is physics, geometry and epoch
milliseconds. Moving the app to another city means editing `src/place.ts` and
`src/sources.ts`, and nothing else.

## `Place`

```ts
interface Viewpoint {          // moves here from useMapEngine.ts
  id: string; label: string; sub: string;
  center: [number, number]; zoom: number; pitch: number; bearing: number;
}

interface Place {
  name: string;                 // for labels: "Time (Taipei)"
  timeZone: string;             // for labels only: "Asia/Taipei"
  utcOffsetMin: number;         // fixed; see *Fixed offsets*
  home: Viewpoint;              // the initial camera
  daylight: { fromMin: number; toMin: number }; // the panel's time range, local minutes
}
```

## Local time

The helpers take the place (only its `utcOffsetMin` is read) and are the old
Taipei ones with the offset as a parameter:

| helper | was | returns |
| --- | --- | --- |
| `localDate(ms, place)` | `taipeiDate` | `YYYY-MM-DD` at the place |
| `localMinutes(ms, place)` | `taipeiMinutes` | minutes past local midnight |
| `fromLocal(date, minutes, place)` | `fromTaipei` | epoch ms |
| `noonToday(place, now?)` | `defaultSunTime` | today, 12:00 local, as epoch ms |
| `offsetLabel(place)` | the literal `+08` | `+08`, `-05`, `+05:30` |

**Fixed offsets.** `Place` carries a fixed UTC offset, not a DST-aware zone.
Asia/Taipei has had no daylight saving since 1979, so this is exact for the
app. A place that observes DST needs a zone-aware form of these helpers (via
`Intl`). That is out of scope until such a place exists.

## The app's place (`src/place.ts`)

| field | value |
| --- | --- |
| `name` | `"Taipei"` |
| `timeZone` | `"Asia/Taipei"` |
| `utcOffsetMin` | `480` |
| `home` | `id` `"daan"`, `label` `"Da'an"`, `sub` `"大安 · Taipei"`; `[121.539873, 25.039784]`, z17.36, pitch 66, bearing 0 (facing due north). Moved from the Xinyi view on 2026-10-30 (`ai/DECISIONS.md`) |
| `daylight` | `{ fromMin: 300, toMin: 1140 }` (05:00–19:00, the old `SUN_TIME_MIN`/`MAX`) |

`useMapEngine` starts the camera at `PLACE.home`. `App.tsx` builds the sunlight
settings as `{ ...DEFAULT_SUNLIGHT_SETTINGS, sunTime: noonToday(PLACE) }` and
labels the panel from `PLACE`:
- "Time (Taipei)";
- the tooltip "Local time in Asia/Taipei (UTC+8).";
- the readout `HH:MM +08`.

The 15-minute slider step is the panel's own, so `SUN_TIME_STEP` moves into
`App.tsx`. The extraction itself changed nothing the user sees; `home` moved
later, as its own decision (2026-10-30, `ai/DECISIONS.md`).

## What the layers give up

- **Sunlight.** `DEFAULT_SUNLIGHT_SETTINGS` becomes
  `Omit<SunlightSettings, "sunTime">`. The layer has no default moment,
  because which noon counts as "today" depends on where the host is. It
  exports no local-time helper and no panel range.
- **Tree.** `TreeSource` gains three fields:
  - `name`: the points record's `name`, `"Taipei Trees"` in `TREES`;
  - `sourceKind`: the points record's `metadata.sourceKind`,
    `"postgis-martin"` in `TREES`;
  - `fallbackHeightM`: the height a tree with no surveyed height is drawn
    and cast at, 9.1 in `TREES`.

  `TREE_FALLBACK_HEIGHT_M` is removed. The meshes (`mountTree`) and the
  direct-sun layer (`mountSunlight`) both read it from the descriptor they
  are given, so they still agree.
- **Buildings.** `BuildingSource` gains `name` (`"OSM Buildings"`) and
  `sourceKind` (`"osm-openfreemap"`) for the extrusion record.

A `sourceKind` is a free label. GeoLibre acts only on specific values
(`annotation`, `pmtiles-url`, `duckdb-query`, …), and neither of ours is one.

## Invariants

All asserted by vitest.

1. The local-time helpers round-trip a date and a minute of day at +08:00,
   at −05:00 and at +05:30. A late-evening UTC instant is already tomorrow at
   +08:00. `noonToday` is noon of the local date.
2. `offsetLabel` gives `+08`, `-05` and `+05:30`.
3. `PLACE` holds the Taipei values above, `home` and `daylight` included, so
   any change to them shows up as a test change.
4. The records take `name` and `sourceKind` from their descriptor. A fixture
   descriptor's values appear unchanged in the record.
5. No non-test file under `src/layers/` or `src/lib/` contains a quoted
   string literal naming the place (`Taipei`, `Asia/`). A test reads the
   files. `basemaps` is not exempt, since it names none.
6. `DEFAULT_SUNLIGHT_SETTINGS` has no `sunTime`.

## Out of scope

- **The species tables.** The tree layer's species → form table
  (`forms.ts`) and the sunlight layer's species → transmittance overrides
  (`transmittance.ts`) are keyed by Taipei's species names. They are the
  largest Taipei-specific content left. They are the layers' reviewed
  judgement, specified in their specs, and there is only one inventory to
  judge. Making them a host input is a separate change, worth doing when a
  second inventory exists to design it against. Until then, another city's
  trees draw as `generic` forms with the default transmittance, which is the
  layers' specified fallback.
- **The temperature defaults** (G0 800 W/m², Ta 32 °C, V 1 m/s, "a clear
  Taipei summer midday"). They are settings that a host can override, not a
  fixed part of the layer.
- **Zone-aware local time**, as above.
- **Prose in the specs** that uses Taipei as its worked example.
