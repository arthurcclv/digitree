# Temperature layer — spec

Source of truth for the ground PET overlay. Behaviour changes here require this
file to change first.

Modules: `src/layers/temperature/` — `index.ts` (record, settings, exports),
`temperatureLayer.ts` (the custom layer), and the pure modules `pet.ts` (the
formula, the ramp, the comfort classes) and `state.ts`, and `usd.ts` (the USD
package, `src/lib/usd/specs/spec.md`).

## Purpose

For each ground point in view, the **physiological equivalent temperature**
(PET, °C) a person standing there would feel at the set moment, derived from
the direct-sun layer's light penetration index. It is drawn as a colour
overlay, read at a clicked point, and exported as a GeoTIFF: the same outputs,
on the same grid, as the direct-sun layer. It follows every change to the
direct-sun result through the derived-layer DAG (`src/lib/dag/specs/spec.md`).

## Definition

```
PET(p) = 0.0126 · (G0 · (0.5986 · LPI(p) + 0.0116)) + 1.2537 · Ta − 2.5537 · V − 1.6374
```

| symbol | meaning | unit | source |
| --- | --- | --- | --- |
| `LPI(p)` | light penetration index at `p`, in [0, 1] | — | the `sunlight.lpi` node: `exp(−Σ τ)`, the direct-sun index |
| `G0` | global irradiance | W/m² | panel |
| `Ta` | air temperature | °C | panel |
| `V` | wind speed | m/s | panel |

- **One formula, one place.** `petOf(lpi, { g0, ta, v })` in `pet.ts` is the
  CPU form. The overlay shader's form is generated from the same coefficient
  table (`PET_COEFFS`), so the two cannot drift; a test asserts they agree.
- **PET is affine in LPI.** For fixed `G0`, `Ta`, `V` it runs from
  `PET(0)` (full shade) to `PET(1)` (full sun), with slope `0.0126 · 0.5986 · G0`.
- **G0, Ta and V are uniform** over the whole view. Only LPI varies by point.
- **G0 is not derived from the sun.** It is what the panel says, whatever the
  sun time. The sun time still drives LPI.
- **Every cell the direct-sun layer has no value for, this layer has none for
  either**: roof, outside coverage, outside the grids, and incomplete cells.

### What PET is not

- **Not air temperature.** Labels say "PET" or "felt temperature", never
  "temperature" alone.
- **Not a model of the scene's surfaces.** No surface temperature, no
  long-wave radiation from walls, no humidity beyond what the regression
  absorbed.
- **Not a time integral.** One moment, as for LPI.

## The PET node

The layer owns the DAG node `temperature.pet`, with deps `["sunlight.lpi"]`.

- It **publishes** a `PetField` when it has drawn a result: `{ lpi, params,
  petRange }`, where `lpi` is the `LpiField` it used, `params` is
  `{ g0, ta, v }`, and `petRange` is `[PET(0), PET(1)]`. A downstream layer gets
  PET at any texel as `petOf(lpi, params)`, from the LPI textures it already
  has. No PET texture is kept.
- It **clears** when it has no result (any state but `ready`).
- It re-publishes on every upstream publish (a new LPI) and every parameter
  change.
- **Demand.** The overlay's visibility sets the node's own demand. Because
  `sunlight.lpi` is upstream, turning the temperature overlay on makes the
  direct-sun layer compute, **even with the Direct sun overlay off**. Turning
  it off releases that demand.

## Rendering

The layer is a MapLibre custom layer with its own `WebGLRenderer` on
MapLibre's context. It extends `ThreeLayer` (`src/lib/three/specs/spec.md`):
`autoClear = false`, `resetState()` before and after its pass, and
`PREMULTIPLIED_OVER` blending. Its `prerender` only publishes its node and
draws nothing, so it does not use `pass`. It has no `viewSettled`, so it is
never subscribed to `idle`.

**It runs no light pass and fetches no tiles.** It draws one ground quad over
the far domain of the current `LpiField`, sampling the sunlight layer's near
and far render targets. They reach this layer's renderer as
`THREE.ExternalTexture`s wrapping the `WebGLTexture`s the `LpiField` carries;
both renderers share one GL context, so no copy is made. It never samples a
target after the `LpiField` that carried it is cleared.

For each fragment it:
1. samples the near target inside the near domain, else the far target;
2. discards roof, outside-coverage and outside-domain cells;
3. computes `LPI = exp(−R)`, then PET from the uniforms `uG0`, `uTa`, `uV`;
4. maps PET through the ramp (below);
5. hatches incomplete cells, exactly as the direct-sun overlay does;
6. emits premultiplied colour at `opacity`, with **uniform alpha** (unlike the
   direct-sun ramp, no value here is "empty").

It is drawn in the translucent pass with `renderingMode: "3d"`, tests against
MapLibre's depth buffer and never writes depth, like the direct-sun overlay.

A parameter change updates three uniforms and repaints. It does not touch the
upstream node.

### Ramp

A **fixed** scale, so a colour means the same PET whatever `G0`, `Ta` and `V`
are set to. Stops sit on the Taiwan-calibrated PET thermal perception classes
(Lin & Matzarakis 2008), which is the population this map is of:

| PET (°C) | class | colour |
| --- | --- | --- |
| ≤ 22 | cool and below | `#3b6fb6` |
| 26 | slightly cool / neutral | `#7fb8d6` |
| 30 | neutral / slightly warm | `#f2e6a0` |
| 34 | slightly warm / warm | `#f5b35c` |
| 38 | warm / hot | `#e56b3a` |
| 42 | hot / very hot | `#b8283a` |
| ≥ 46 | very hot | `#6b0f3a` |

Linear between stops, clamped outside. `PET_CLASSES` in `pet.ts` carries the
class boundaries (`< 14` very cold, 14–18 cold, 18–22 cool, 22–26 slightly
cool, 26–30 neutral, 30–34 slightly warm, 34–38 warm, 38–42 hot, `≥ 42` very
hot) and `classOf(pet)` names one; the probe readout shows it.

## State

`TemperatureState` is `off`, or else the upstream sunlight state, read from
the DAG as `graph.state("sunlight.lpi")` whenever that node notifies. Nothing
outside the graph forwards it:

| state | when |
| --- | --- |
| `off` | the overlay is off |
| `zoom`, `low-sun`, `unsupported`, `waiting` | the direct-sun layer is in that state |
| `ready` | an `LpiField` is published and this layer has drawn from it |

`temperatureState(visible, sunlightState)` in `state.ts` decides it.

## Readouts, probe and export

`status()` returns `{ state, params, petRange }`.

`probe(lng, lat)` asks the `LpiField` for the LPI at that point (the direct-sun
layer's own readback, see the sunlight spec) and resolves to:
- `{ kind: "value", pet, lpi, cls }`, with `pet = petOf(lpi, params)` and `cls
  = classOf(pet)`;
- or the LPI probe's `roof`, `incomplete`, `outside` or `none`, unchanged.

`exportGeoTiff()` returns the same GeoTIFF as the direct-sun export — the
whole near grid, EPSG:3857, strip readback — with each value mapped through
`petOf` instead of written as LPI. It uses the `LpiField`'s
strip reader, with a per-value transform; this layer reads no pixels of its
own. The GDAL metadata carries the sun time, azimuth and elevation, the cell
size, `g0`, `ta`, `v`, and a `definition` naming the quantity (PET, °C), the
formula, and pointing at this spec. **NoData is `-9999`**, not the direct-sun
export's `-1`: at the panel's extremes (`G0 = 0`, `Ta = 15`, `V = 10`) PET is
−8.4 °C, so `-1` is a real value here.

`exportUsd(frame)` (the mount's) returns this layer's USD package: the PET grid
over the frame, through the ramp (`petRampAt`), as a ground texture 4 cm up,
above the direct-sun one, with the PET GeoTIFF beside it. It asks the
`LpiField` for `readFrame(frame, petOf, -9999, …)`, so it reuses the direct-sun
layer's export pass for that frame and sun time, and covers exactly the same
cells. It rejects as `not-ready` without a field. See
`src/lib/usd/specs/spec.md`.

## The GeoLibre record

`temperatureRecord(settings)`, on the direct-sun record's pattern:
- `id: "temperature"`;
- `metadata.customLayerType: "threejs"`;
- `nativeLayerIds: ["threejs-temperature-native"]`;
- `paintMode: "plugin"`;
- `source: {}`;
- `visible`: whether `temperature.pet` is demanded. Today nothing derives
  from PET, so that is `TemperatureSettings.visible`.

Opacity reaches the layer through the paint bridge; visibility, as for the
direct-sun layer, through `ThreeTemperatureLayer.setVisibility`, called by the layer's mount in
`update` (the bridge's `setVisibility` is a no-op). See
the sunlight spec, *The GeoLibre records*, for why.

`mountTemperature` (`mount.ts`, see `src/lib/mount/specs/spec.md`) adds the
node with deps `["sunlight.lpi"]`, so it must be mounted after `mountSunlight`
on the same graph.

The sync order becomes buildings → ambient occlusion → sunlight →
**temperature** → tree points → tree mesh, so with both overlays on, PET is
drawn over LPI.

## Settings

`TemperatureSettings`, with `DEFAULT_TEMPERATURE_SETTINGS`:

| field | default | panel range | step | meaning |
| --- | --- | --- | --- | --- |
| `visible` | `false` | toggle | — | overlay on or off |
| `opacity` | `0.8` | 10–100 % | 5 % | overlay opacity |
| `g0` | `800` | 0–1,200 W/m² | 10 | global irradiance |
| `ta` | `32` | 15–40 °C | 0.5 | air temperature |
| `v` | `1.0` | 0–10 m/s | 0.1 | wind speed |

The defaults are a clear Taipei summer midday. At them PET runs from 36.0 °C
(shade) to 42.1 °C (sun).

The panel is a new **Felt temperature (PET)** card, below Direct sun:
- the Overlay toggle and opacity slider;
- the three sliders `G0`, `Ta`, `V`, with units;
- readouts: the range `PET shade → sun` for the current parameters; the state
  when not `ready`; the last probe (`38.4 °C · hot`), cleared when a parameter,
  the sun time or either overlay changes;
- a line that the sun time is set in the Direct sun card;
- an **Export GeoTIFF** button, enabled only when `ready`.

Clicking the map probes each overlay that is on; the two readouts are
independent.

## Invariants

1–5 are asserted by vitest; 6–8 are checked in the browser.

1. `petOf` matches the formula: at `G0 = 800, Ta = 32, V = 1`, `petOf(0)` is
   36.04 and `petOf(1)` is 42.08, within 0.01. It is affine in LPI with slope
   `0.0126 · 0.5986 · G0`.
2. The GLSL expression built from `PET_COEFFS` evaluates (in a JS port of the
   generated expression) to `petOf` for a grid of inputs.
3. `classOf` returns the table's class at each boundary and between them. The
   ramp's stops rise evenly in PET (the shader indexes them by
   `(PET − 22) / 4`), it hits each stop's colour, and it clamps outside
   22–46 °C.
4. `temperatureState` is `off` when hidden, and the sunlight state otherwise.
5. With the temperature overlay on and Direct sun off, `sunlight.lpi` is
   demanded; with both off it is not (DAG invariant 4, on the real node ids).
6. With the Direct sun overlay **off** and this one on, the PET overlay draws,
   and moving the sun time changes it.
7. A point's PET probe equals `petOf` of the same point's LPI probe.
8. Changing `G0`, `Ta` or `V` repaints without a new light pass (the sunlight
   `rebuildMs` and its tile counts do not move).

## Out of scope

- Deriving `G0` from the sun position, date or cloud cover.
- Spatially varying `Ta` or `V` (a wind field, an urban heat-island map).
- Mean radiant temperature, humidity, surface materials.
- Night-time PET: below the direct-sun layer's minimum sun elevation there is
  no LPI, and so no PET.
- A PET render target of its own.
