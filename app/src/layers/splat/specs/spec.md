# Gaussian splat layer — spec

> **Status: approved 2026-10-20, implemented. Revision 11 (a header-placed
> capture's height is its `offsetz` less its group's datum, the median
> `offsetz` of the captures grouped with it) — approved 2026-10-29;** see
> *Changes in revision 11*.
> Revision 10 (a capture is placed from its PLY header's georeference by
> default, height included; the control-point fit stays, behind
> `splats_placement`) — approved 2026-10-29.
> Revision 9 (`control_points.csv` gains `ALT`, the altitude of the capture
> file's origin) — approved 2026-10-25.
> Revision 8 (a capture's origin is read from exact `lng`/`lat` properties,
> not the tile's quantized point) — approved 2026-10-25.
> Revision 7 (the loader takes `.spz` only) — approved 2026-10-23.
> Revision 6 (fit on WGS 84, draw with per-axis metres) — approved 2026-10-23.
> Revision 5 (paged LoD: a tree built offline, streamed into a fixed page
> pool, and captures unloaded by distance and count) — approved 2026-10-23.
> Revision 4 (one frame for the file and its control points, which a scan
> takes from its PLY's georeference, not its poses) — approved 2026-10-22.

Source of truth for drawing 3D Gaussian splat captures (3DGS) on the map, and
for the infra that serves them. Behaviour changes here require this file to
change first.

Modules: `src/layers/splat/` — `index.ts` (`SplatSettings`, the entry),
`schema.ts` (`SplatSource`, `splatOf`, `lodUrlOf`, `splatTiles`, `splatsIn`,
`mercatorDistance`), `frame.ts` (`Anchor`, a `LocalFrame`; `rebased`,
`placeCapture`, `similarity`, `axesOf`), `residency.ts`
(`Residency`), `state.ts` (`SplatStatus`),
`records.ts` (`splatRecord`), `mount.ts` (`mountSplat`), `splatLayer.ts`
(`ThreeSplatLayer`), `stretch.ts` (`makeStretch`), `constants.ts` (ids and
constants), and `*.test.ts` beside them. Shared additions: `decomposeCamera`
in `src/lib/three`, `trueMetreAxes` in `src/lib/tiles/grid.ts`, and a second
proxy entry in `src/lib/tiles/proxy.ts`. Infra: a `splats` table, its loader, a Martin
source, a static file service, and `build-lod.sh` (`infra/specs/build-lod.md`).

## Purpose

Show the georeferenced Gaussian splat captures that infra holds, in place,
among the OSM buildings and the tree meshes. A splat is a view only. No other
layer reads it (sunlight, AO and temperature do not use it as an occluder), it
is not probed, and it is not exported.

## Renderer: Spark, inside a `ThreeLayer`

GeoLibre 3.0.0 lists `"gaussian-splat"` in `LAYER_TYPES` but draws nothing
for it in `@geolibre/map`. GeoLibre's own route, the `maplibre-gl-splat`
plugin, was rejected (`ai/DECISIONS.md`, entry added with this layer): it
brings a second three.js renderer and repaints every frame.

`ThreeSplatLayer extends ThreeLayer` and draws with **Spark**
(`@sparkjsdev/spark`, MIT, pinned exactly at `2.3.1`; peer `three >= 0.180.0`,
which the app's `three@^0.186.0` meets). It follows every rule of
`src/lib/three/specs/spec.md`, and portability rule 7 is unchanged:

- It uses the base's renderer. `SparkRenderer` is constructed with
  `{ renderer }` in `contextChanged`, and rebuilt when the context changes.
- All drawing happens inside `this.pass(...)` in `render`. The layer declares
  **no `prerender`**. Spark's own GPU work (sorting, accumulation, readback
  set-up) runs from `SparkRenderer.onBeforeRender`, which three calls inside
  `renderer.render`, which is inside `pass`.
- It reads `mainMatrix` only through `projection(args, model)`.
- Colour is premultiplied (`premultipliedAlpha: true`, Spark's default), which
  is what MapLibre's `ONE, ONE_MINUS_SRC_ALPHA` blend expects.
- Splats test depth and do not write it (Spark's defaults, `depthTest: true`,
  `depthWrite: false`).
- `blurAmount: 0.3`, Spark's setting for captures trained with anti-aliasing.
  All three current captures are (SPZ header flag `antialiased = 1`).
- **The host's canvas has no MSAA** (`antialias: false`). It is one context
  attribute for the whole map, and 4× multisampling costs Spark more than half
  its frame rate: rotating KY0917A in the app ran at 10 fps with it and 34 fps
  without (KY0917B in isolation: 16 → 38). The price is slightly stair-stepped
  building and tree-mesh edges at DPR 1; at DPR 2 they are not visible.

The layer draws each capture's **paged LoD tree**, a `.rad` that infra builds
from the capture's cleaned `.spz` (`infra/scripts/build-lod.sh`). Infra still
validates the capture's own file, which must be a `.spz`: it is the only format
`build-lod.sh` reads, so a row naming any other could never pass the LoD check.
The layer never fetches the file.

### Level of detail

Spark draws the captures through its **paged LoD**:

- Each `SplatMesh` is made with `{ url: lodUrlOf(source, splat), paged: true }`.
  The tree is built offline with `build-lod --quality --rad-chunked`
  (`bhatt-lod`), so nothing is built in the browser. It is **chunked**: the
  `.rad` is a small header, and each 64 K-splat chunk is its own file,
  `<stem>-lod-<n>.radc`, beside it, named in the header. `mesh.initialized`
  waits only for the header. Spark fetches each chunk file whole, as the view
  needs it, through the `/files` proxy. Each chunk carries its own ETag, so
  it can be revalidated on its own. Whether Spark's refetches hit the
  browser's cache was not measured.
- `SparkRenderer` is made with `enableLod: true`. Each frame it draws a
  budget of splats chosen from the trees of every loaded capture for the
  current view (Spark's platform default: 2.5 M on desktop, 1–1.5 M on mobile,
  `lodSplatScale` 1).
- **The page pool is Spark's platform default** (`maxPagedSplats` is not
  passed): 256 pages of 65,536 splats on desktop, 128 on other mobile, 96 on
  iOS. It is allocated once, on the GPU and as a CPU copy (256 MB each on
  desktop, at 16 B per splat without SH), and never grows. Pages are reused
  least recently used first, lazily: a page out of view stays resident until
  its slot is needed.
- **`lodCleanupTimeoutMs` is Spark's default, 3 s** (not passed). A capture
  unrendered that long, whether hidden, below `minZoom` or unloaded, has its
  worker-side tree dropped and its pages returned to the pool. Rendering it
  again fetches them again, which is cheap: nothing is rebuilt.
- **The budget is not capped at the pool.** At the default budget the pool is
  already full, because a chunk is only partly used by any one view. A budget
  beyond what the pool can serve only makes the view coarser
  (`SplatPager.driveFetchers` fetches no more pages than the pool has).
- LoD updates and page loads finish through `onDirty`, like sorts, so the map
  still goes idle (invariant 3).
- Spark's LoD sizes splats by angle per pixel only for a `PerspectiveCamera`.
  The layer's camera is a plain `THREE.Camera` (*The camera*), so its
  `pixelScaleLimit` is 0 and the traversal is bounded by the budget alone.
  This was already so before paging.

Measured with both KZ0918 captures (31.6 M splats; Apple M4, headless Chromium
on Metal, 2026-10-23), in a harness with Spark alone (no map), against the
load-time tree this revision replaces (`lod: true`,
`lodCleanupTimeoutMs: Infinity`):

| | first draw | fps orbiting | browser memory (2-min soak) | JS heap |
| --- | --- | --- | --- | --- |
| load-time tree | 25–35 s per capture | 37.6 | 6.8–6.9 GB | 1.5 GB |
| **paged, 128 pages** | ~0 s | 39 | 2.0–2.1 GB, flat | 220–290 MB |
| **paged, 256 pages** (chosen) | ~0 s | — | 2.4 GB, flat | 320–390 MB |

In the app itself, with the map and every other layer, the tab holds
4.9–5.1 GB, flat, with the splats on and 1.85 GB with them off. Measured
again with the chunked files, the same 2-minute run read both headers by range
(`206`) and fetched 464 chunk files (`200`), and no `.spz`. Panning 12 km away
unloaded both captures, and panning back loaded them again.

While the camera keeps moving, pages are refetched continuously: about 19
chunks a second with 128 pages and 11 with 256 (at about 1.1 MB each). In a
still view the pool settles within 5 s. The paged `.rad` lands within 0.26 px
(about 0.15 m) of the `.spz` drawn without LoD, so the control points hold.

History: the load-time tree (`lod: true`) was chosen on 2026-10-21 over no
LoD (7 fps on KY0917B) and over `"quality"` (76 s per load). It built the tree
from the whole file on every load (17.8 s for 6.45 M splats) and held every
splat.

**Spark is imported dynamically** the first time a capture is due to load. It
is ~2.6 MB minified, and a session that never zooms in on a capture never
downloads it.

## The camera — `decomposeCamera` (in `src/lib/three`)

Every other three.js layer sets `camera.projectionMatrix = projection(args,
model)` and leaves the view as identity. That works for meshes, but not for
Spark. Its vertex shader moves each splat centre into **view space** with the
view matrix and culls `z >= 0`. It takes the focal length in pixels from
`projectionMatrix[0][0]` and `[1][1]`, and it builds each splat's footprint
from the Jacobian of a **standard perspective**. A combined matrix breaks all
three. So the layer splits it again:

```ts
decomposeCamera(clipFromLocal: THREE.Matrix4): {
  projection: THREE.Matrix4;   // P: perspective, w row exactly (0, 0, −1, 0)
  view: THREE.Matrix4;         // V: rigid (rotation + translation), det +1
} // P · V == clipFromLocal × s, for one s > 0
```

- **Method.** Scale the input by `s = 1 / |w row's 3×3 part|`. The view's `z`
  row is minus the scaled `w` row, so the camera looks down −z and `w` keeps its
  sign. Gram–Schmidt on the `y` row, then the `x` row, against it gives the
  view's `y` and `x` rows and `P`'s focal lengths, skew and principal point.
  The view's translation follows by back-substitution, and `P`'s depth row
  `(0, 0, A, B)` is solved from the scaled `z` row.
- **Exact depth.** `P · V` reproduces the input's `z` row, so a splat tests
  the same depth MapLibre would. Buildings in front hide it.
- **It throws** when the input is not a perspective camera of this form:
  `det V < 0` (a reflection), a depth row with a component off the view's `z`
  axis (relative residual > 1e-9), or a non-finite input. A throw is a bug in
  the frame, not a state to recover from.
- **Pure, in `src/lib/three`.** It reads no map and imports no layer (rule 9).

**Spike result (2026-10-20).** Matrices were captured from MapLibre 6.10.0 (the
app's version) at pitch 0°, 30°, 60° and 85°, bearings 0°, −28°, 135° and 200°,
and with 360 px left and 120 px top padding. Each was multiplied by the
app's own `mercatorFrame(centre, metre)`. Every one decomposed with:
round-trip error ≤ 3e-18 relative, depth residual ≤ 5e-16, `det V = +1`, skew
≤ 1e-16. Padding only moves the principal point (`P[0][2] = −0.28`); Spark's
Jacobian does not read it, which is correct for an off-centre frustum.
KY0917A (2.8 M splats) rendered upright and undistorted at every view, hidden
by a test extrusion in front and drawn over it from behind, on an Apple M4. The
captured matrices become the test fixtures below.

### The frame

The model matrix is `mercatorFrame(centre, metre)` — the shared helper,
unchanged, with no extra rotation (the spike shows `det V = +1` with it as is).
It is built at an **anchor** (`Anchor` in `frame.ts`), not at the map centre.
The anchor is set when the layer first plans its tiles, as the frame at the
view centre (`frameAt` in `lib/tiles`). It moves
to the view centre only on `viewSettled`, and only if the centre is more than
`SPLAT_REBASE_M` (20 km) from it (`rebased`). Each capture's mesh sits in this frame at its own offset from the
anchor, computed in double precision on the CPU from its position and altitude,
once when it loads and again when the anchor moves. While navigating, the
camera is the only thing that changes.

**Why not recentre every frame.** Spark caches each mesh's world transform when
it updates, and that runs one tick after the draw (it is skipped while a sort
is running). The draw itself uses the live camera. Moving the origin every frame
changes every mesh's world transform, so mid-drag the captures were drawn at a
stale origin with the current camera. They slid against the buildings and
snapped back when the map came to rest.

**Precision.** Within 20 km of the anchor, float32 loses about 1 mm, and Spark's
cache is stored relative to the camera anyway. When the anchor moves, at most
one frame may draw the old cache; Spark's `onDirty` repaints straight away.

`metre` is taken at the anchor's latitude and moves only with it: a centre
latitude's metre would change every mesh's transform on a north–south drag.
Each capture is scaled by its own latitude's metre over the anchor's, so its
size in metres is exact wherever it sits relative to the anchor.

**True metres, per axis.** A capture is metric, in true (WGS 84) metres, and
infra fits it on the ellipsoid (*Control points CSV → `splats` table*). The
map is spherical Web Mercator: it draws a latitude/longitude as if on a sphere
of R = 6,371,008.8 m, so a true metre is drawn as `R / N(φ)` map metres east
and `R / M(φ)` north, N and M the prime-vertical and meridian radii of WGS 84
(`trueMetreAxes(lat)` in `lib/tiles/grid.ts`). At Taipei (25.04° N) that is
0.99828 east and 1.00381 north. No uniform scale matches both, so:

```
placement(splat) = diag(east, north, 1) · rotateZ(−heading) · scale(scale)
```

with `east, north = axesOf(splat) = trueMetreAxes(splat.lngLat[1])`, one value
per capture (they vary by under 10⁻⁷ across 300 m). Up is not stretched:
heights stay in metres as the map draws them. The mesh's whole transform is
`translation · k · placement`, with `k` the uniform latitude ratio above.

**Spark keeps one scale of a mesh's matrix.** Its default path reduces
`mesh.matrix` to translation, rotation and the mean of the three scales
(`SplatTransformer.updateFromMatrix`), so the per-axis part cannot ride in it.
`placeCapture(splat, anchor)` in `frame.ts` is the one place this transform is
computed. It returns `{ matrix, origin, axes }`, the whole transform split in
two, and the layer only copies them onto the mesh and its stretch:

- `mesh.matrix = translation · k · similarity(splat)`, where `similarity` is
  `rotateZ(−heading) · scale(scale)`, a rotation and one scale, which Spark
  carries exactly.
- The mesh's **world modifier** (`makeStretch` in `stretch.ts`, a dyno block)
  moves each splat's centre to `o + diag(east, north, 1)·(c − o)` in the
  layer's frame, with `o` the mesh's translation. Because `k` is uniform, this
  equals `translation · k · placement`. The layer sets `o` from `origin`
  whenever it places the mesh (on load and on a rebase) and calls
  `mesh.updateVersion()` so Spark regenerates with it.
- The Gaussians' shapes are not stretched. A 0.4% stretch of a splat is not
  visible.

Spark's `covSplats` mode would carry the full matrix, but it cannot be used
with paged meshes. In 2.3.1 a `paged: true` mesh never sets `extSplats`, so
`SplatMesh({ covSplats: true, paged: true })` throws `CovSplats requires
ExtSplats`.

## Repainting

`SparkRenderer`'s `onDirty` (a sort or a load finished) calls `this.repaint()`.
Nothing else requests a repaint. The spike confirms the map goes quiet: with a
capture loaded and the camera still, no frame was drawn over 4 s. So `idle`
still arrives, and sunlight and AO keep recomputing on `viewSettled`.

## Data — served by infra

### The captures

The files are `infra/data/3dgs/source/<scan>.spz`, and what the layer draws
is each one's LoD tree, `infra/data/3dgs/lod/<scan>-lod.rad` and its chunks
`<scan>-lod-<n>.radc`, built from it by
`infra/scripts/build-lod.sh` (*Level of detail*). The scans as
delivered sit in `infra/data/3dgs/original/<scan>/point_cloud.<ext>` and are
never modified (`infra/CLAUDE.md`); `infra/scripts/process-splat.sh` derives each served
file from its original by removing outlying, oversized and floating
Gaussians, and writes it as SPZ v3 (`infra/specs/process-splat.md`). Removing
Gaussians never moves the others, so the frame, and the control points, are
the original's.

The KY0917 captures this layer was built against were three, all SPZ v2,
metric, **z up** with the ground at z ≈ 0, SH degree 0, anti-aliased:

| file | splats | bytes | extent x · y · z (m, 1st–99th percentile) |
| --- | --- | --- | --- |
| `KY0917A.spz` | 2,835,204 | 40 MB | 101 · 108 · 13 |
| `KY0917B.spz` | 6,454,811 | 93 MB | 111 · 102 · 13 |
| `KY0917C.spz` | 6,559,715 | 94 MB | 170 · 97 · 15 |

None of them carries a georeference. Where each one sits comes from the
metadata CSV. Cleaned with the script's defaults they served KY0917A
2,685,252 splats (41 MB), KY0917B 6,216,275 (97 MB) and KY0917C 6,293,120
(97 MB); as SPZ v3 they were larger than the v2 originals despite the cut.

They are no longer in `original/`. The KZ0918 scans that replaced them
(KZ0918-075047: 19.3M Gaussians; KZ0918-090946: 13.8M) were first delivered
as SOG, stored y down and in no frame of their own. They are now delivered as
**georeferenced PLY**, metric and z up: the header names a UTM zone
(`comment epsg 32651`) and an offset (`comment offsetx/y/z`), and a point at
UTM (E, N, h) is stored at (E − offsetx, N − offsety, h − offsetz) — x east,
y north of the grid, origin the scan's first GNSS fix. Their poses are in
another frame (turned 21.9° and 91.3° from north), which nothing reads. (The positions as stored are what
`--stats` and splat-transform's library report; its `-V` filters and
generator see x and y negated.)

**The frame.** Every capture is drawn in **its file's frame**, as stored:
z-up, metric. Its control points are in that frame too (*One frame, no
conversion*). For a scan with a georeferenced PLY, `infra/scripts/control-points.mjs`
writes them from the header's georeference and the scan's RTK fixes
(`infra/specs/control-points.md`); hand-measured points are read in the file's
coordinates. Where a capture sits and which way it faces come from the control
points. A file stored any other way (y down, on its side) is a delivery to
fix, not something infra or the layer corrects.

The served file must be a **gzip-wrapped** SPZ (v2 or v3): Spark 2.3.1
recognises an SPZ by its gzip magic alone, so an SPZ v4 — splat-transform's
default output, not gzipped — does not load.

**`infra/data/3dgs/` is not gitignored today.** `infra/data/*.csv` and
`infra/data/custom/` are, so 228 MB of captures currently show as untracked.
This change adds `infra/data/3dgs/` to `.gitignore`.

### Placement: `splats_placement`

`sql/04_splats.sql` places the captures one of two ways, chosen by the psql
variable `splats_placement` (`load.sh` passes `SPLATS_PLACEMENT` through):

| value | reads | places a capture by |
| --- | --- | --- |
| `header` (default) | `infra/data/3dgs/georef.csv` only | its PLY header's georeference, height included (*Georeference CSV → `splats` table*) |
| `control_points` | `infra/data/3dgs/control_points.csv` only | the fit to its control points (*Control points CSV → `splats` table*) |

Any other value fails the splat load, naming it. Each way reads only its own
file: in `header` mode `control_points.csv` is not opened, and in
`control_points` mode `georef.csv` is not. Both fill the same `splats` table,
with the same file and LoD rules, so the tiles and the app do not know which
way a capture was placed.

### Georeference CSV → `splats` table

A scan's `point_cloud.ply` carries its own georeference: a UTM zone and an
offset (*The captures*). In `header` mode the loader places each capture from
that alone. The loader cannot read a PLY header (the served `.spz` has none,
and `original/` is not mounted), so `infra/scripts/georef.mjs` copies each
scan's header into a CSV first (`infra/specs/georef.md`).

**File:** `infra/data/3dgs/georef.csv`, one row per capture. The header is
matched exactly:

```
SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ
KZ0918-075047,KZ0918-075047.spz,32651,352796.8287235790048726,2770099.7470906949602067,26.9006000000000007
```

| column | meaning | rule |
| --- | --- | --- |
| `SplatID` | the capture's stable id | non-empty; unique |
| `File` | file name inside `data/3dgs/source/` | as in `control_points.csv`: no `/`; ends in `.spz`; the file exists; unique; its LoD exists |
| `EPSG` | the header's `epsg`: WGS 84 / UTM | an integer in 32601–32660 or 32701–32760 |
| `OFFSETX`, `OFFSETY` | the header's `offsetx`, `offsety`: the UTM easting and northing of the file's origin | finite |
| `OFFSETZ` | the header's `offsetz`: the height of the file's origin, in `gnss.csv`'s datum (WGS 84 ellipsoidal) | finite |

**The placement** (in `sql/04_splats_header.sql`, PostGIS, per capture),
with `O` the origin `(OFFSETX, OFFSETY)` in `EPSG` and `P` the point 100 m
grid-north of it, `(OFFSETX, OFFSETY + 100)`:

- `geom` = `O` transformed to WGS 84 (`ST_Transform`, PROJ's UTM). Local
  `(0, 0)` lands there.
- `heading_deg` = the geodesic azimuth from `O` to `P` on the WGS 84
  ellipsoid (`ST_Azimuth` on `geography`), in [0, 360). The file's +y is grid
  north, so this is 360° plus the grid convergence (359.38° for KZ0918). Over
  100 m the azimuth is exact to under 10⁻⁵°.
- `scale` = the geodesic distance from `O` to `P` (`ST_Distance` on
  `geography`), over 100: one file unit in true metres, 1/k, k UTM's point
  scale (1.00013 for KZ0918).
- `altitude_m` = `OFFSETZ − datum`, the datum of the capture's group (*The
  datum*, below). Local z = 0, the origin, is drawn that far above the map's
  ground.
- `rms_m` and `points` are NULL: nothing is fitted.

**The datum.** The map has no terrain, so an ellipsoidal height cannot be
drawn as it is: `OFFSETZ` alone puts every capture some 25 m in the air.
Instead the loader subtracts one height, the **datum**, from every capture
that may meet another, so their heights relative to each other stay exactly
RTK's. Only `OFFSETZ` is used: it is the RTK height the file's frame is
defined by, while a capture's ground and its antenna height are estimates.

1. **Groups.** Sort the captures by `OFFSETZ`. Where two neighbours in that
   order differ by more than `splats_datum_gap_m` (psql variable, default
   `5`), a new group starts (single linkage). On the 22 delivered scans the
   largest such gap is 0.37 m, so they form one group.
2. **The datum of a group** is the median `OFFSETZ` of its captures (the mean
   of the middle two for an even count), computed at every load: 26.60 m for
   the delivered scans. A capture added to a group can move every capture in
   it by up to its share of the median.
3. Every capture's origin is drawn `OFFSETZ − datum` above the map's ground
   (−0.44 to +1.32 m for the delivered scans). The origin is the antenna at
   the scan's first fix, so a capture's own ground lands about its antenna
   height below the map's (1.4–1.7 m). Nothing corrects that: no antenna
   height is assumed.

A gap over 5 m in `OFFSETZ` with nothing between is taken to mean captures
far apart, which share no seam. Grouping looks at height only, so two
captures that do overlap can still be split by a smaller
`splats_datum_gap_m`: KZ0918-093638 and KZ0918-101007-1 share an origin to
1 m and differ by 1.24 m in `OFFSETZ`. Split, they would meet with a step of
the difference of their groups' datums.

The load prints each capture's group, its datum and its `altitude_m`.

Through the same header, the control-point fit lands the same place: its
points are the scan's own fixes, put into the file through this offset, so
the two agree to the fit's residual (under 5 mm on KZ0918). Only the height
differs: the fit sets each capture's ground on the map's
(`mean(H − scale·Z)`), the header keeps the captures' heights relative to
each other.

**Row rules.** Every problem is collected and the whole splat load fails,
naming the CSV line or the capture: an empty `SplatID` or `File`; a `File`
that is a path, not `.spz`, or not in `data/3dgs/source/`; an `EPSG` that is
not an integer in the UTM ranges; an `OFFSET*` that is not a number; a
`SplatID` or a `File` on two rows; a capture without its LoD. A
`splats_datum_gap_m` that is not a positive number fails too. A missing
`georef.csv` loads an empty table and says so, as a missing
`control_points.csv` does.

### Control points CSV → `splats` table

In `control_points` mode. A capture that carries no georeference (the KY0917
captures this layer was built against) has no origin or heading to read.
Instead, each capture is placed from **control points**:
features recognisable both in the capture and on a map (a building corner, a
kerb, a lamp post base), each given in local coordinates and in latitude and
longitude. The loader solves the placement from them.

**File:** `infra/data/3dgs/control_points.csv`, one row per point, at least
three points per capture. The header is matched exactly
(`COPY … HEADER MATCH`, as for the custom trees), so swapped LAT/LON columns
are rejected rather than loaded:

```
SplatID,File,Point,X,Y,Z,LAT,LON,ALT,H,Note
KY0917A,KY0917A.spz,1,12.40,3.85,0.02,25.034512,121.560841,,0,NE corner of the low wall
KY0917A,KY0917A.spz,2,-18.10,-40.27,0.05,25.034790,121.560527,,0,lamp post base
KY0917A,KY0917A.spz,3,55.62,-22.90,0.11,25.034655,121.561212,,0,gate pillar, west side
```

(The values above are made up, to show the format.)

| column | meaning | rule |
| --- | --- | --- |
| `SplatID` | the capture's stable id; the rows of one capture share it | non-empty |
| `File` | file name inside `data/3dgs/source/` | same on every row of the capture; no `/`; ends in `.spz` (lower case); the file exists; one capture per file |
| `Point` | the point's label within the capture (`1`, `2`, `3`, or a name) | unique within the capture |
| `X`, `Y`, `Z` | the point in the capture's own coordinates, **as stored** (metres): z-up, the ground is X/Y. See *One frame, no conversion* | finite |
| `LAT`, `LON` | WGS84 of the same point, in decimal degrees | in range |
| `ALT` | the altitude, in metres, of the capture file's origin (local `(0, 0, 0)`): for a scan, its PLY header's `offsetz`, in `gnss.csv`'s altitude datum. The same on every row of the capture. A record only: not used to place the capture | blank, or a number, the same on every row of the capture |
| `H` | the point's height above the ground, in metres | finite; blank = 0 (a point on the ground) |
| `Note` | what the point is, for whoever checks it later | free text, ignored by the loader |

**Choosing points.** Three points spread across the capture, not in a line, on
features that are sharp in both the capture and the map imagery. Points on the
ground (`H` blank) are best. That is for points measured by hand. A scan's
generated points are its GNSS antenna, and their `H` is the antenna's
measured height above the capture's ground (`infra/specs/control-points.md`,
revision 8). A fourth or fifth point is accepted and makes
the fit more robust.

**One frame, no conversion.** A capture's file and its rows of
`control_points.csv` share one frame: the file's coordinates as stored, z-up,
the ground on x/y. A scan's `poses.csv` is not in it and is not read. `X, Y, Z` are read in it directly, and the
loader fits on them as they are:

```
file x = X     file y = Y     file z = Z
```

Nothing in the loader or the layer turns, mirrors or re-axes a capture, so a
file that is not stored in this frame renders wrong, and nothing catches it
(*The captures*). A point measured by hand is read in the file's stored
coordinates — not in a viewer that turns or tilts the file on open (the
PlayCanvas/SuperSplat family turns it 180° about up, and shows it y-up), which
would need undoing first.

A reading turned about up cannot be caught by the fit: turning every local
coordinate about up is itself a valid rotation, so the fit absorbs it and the
capture lands turned around its control points with a good RMS (found by eye
on KY0917A, 2026-10-20). A reading mirrored or tilted (a y-up one) does not
fit a rotation of the ground, and the fit checks below reject it.

**The solve** (in `sql/04_splats.sql`, set-based SQL, per capture):

1. Project each point's `LAT, LON` to true metres east and north of the
   points' centroid, equirectangular on the **WGS 84 ellipsoid** with the radii
   at the centroid's latitude φ0: `east = N(φ0)·cos φ0·Δλ`,
   `north = M(φ0)·Δφ`, with `a = 6378137` and `f = 1/298.257223563`, written
   once in the SQL. The capture is metric, so the fit is in true metres, and the
   app draws each axis with its own map-metres-per-metre (*The frame*). Over
   ~300 m the equirectangular error is under 5 mm. For a georeferenced scan the
   fit gives `scale` ≈ 1/k, k being the UTM point scale (0.99987 for KZ0918, so
   `scale` ≈ 1.00013), and `heading_deg` ≈ 360° plus the grid convergence
   (359.38°).
2. Fit a 2D similarity, `(file x, file y) → (east, north)`: a rotation about up, a uniform
   scale and a translation. Least squares, closed form (the 2D Helmert
   solution). Three points give six equations for four unknowns, so the fit
   has a residual to check.
3. The vertical offset is `mean(H − scale · file z)`: the capture's ground is set on
   the map's ground.
4. Store the capture's origin (where local `(0, 0)` lands), projected back
   through the same radii (`lat = φ0 + tN / M(φ0)`,
   `lon = λ0 + tE / (N(φ0)·cos φ0)`), as the point geometry, `heading_deg` (the angle of the capture's +y axis, clockwise from
   north), `scale`, `altitude_m` (the vertical offset), and `rms_m`, the
   horizontal RMS residual.

**Fit checks.** These make the whole splat load fail, naming the capture:

- fewer than 3 points, two points closer than 2 m, or points nearly in a line
  (the smallest singular value of the centred `file x, file y` under 2 m);
- `rms_m` above `splats_max_rms_m` (psql variable, default `1.0`). This is
  what catches a point typed wrong, a swapped pair, or a mirrored axis
  convention;
- `scale` outside [0.8, 1.25]. The captures are metric, so a scale far from 1
  means wrong points, not a real scale.

`load.sh` prints each capture's `rms_m`, `scale` and `heading_deg`.

All captures are assumed stored z-up, and their control points in the
file's own coordinates (*The frame*). A capture stored any other way is out of
scope; it is a delivery to fix.

`sql/01_schema.sql` adds the table (idempotent, dropped and recreated):

```sql
CREATE TABLE splats (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- MVT feature id
  splat_id    text NOT NULL UNIQUE,
  file        text NOT NULL UNIQUE,
  bytes       bigint NOT NULL,              -- from pg_stat_file at load
  altitude_m  real NOT NULL,                -- vertical offset of local z = 0
  heading_deg real NOT NULL,                -- of local +y, clockwise from north, [0, 360)
  scale       real NOT NULL,                -- local units → metres
  rms_m       real,                         -- the fit's horizontal RMS residual; NULL when placed by the header
  points      integer,                      -- control points used; NULL when placed by the header
  geom        geometry(Point, 4326) NOT NULL, -- where local (0, 0) lands
  lng         double precision GENERATED ALWAYS AS (ST_X(geom)) STORED, -- geom's, exactly
  lat         double precision GENERATED ALWAYS AS (ST_Y(geom)) STORED  -- (*Martin*, below)
);
```

`lng` and `lat` are generated from `geom`, so the loader writes only `geom` and
the two can never disagree.

A new `sql/04_splats.sql` loads it, with its inputs as psql variables like the
tree loader: `splats_placement` (default `header`), `splats_georef` (default
`/data/3dgs/georef.csv`), `splats_csv` (default
`/data/3dgs/control_points.csv`), `splats_dir` (default `/data/3dgs/source`),
`splats_lod_dir` (default `/data/3dgs/lod`), `splats_max_rms_m` (default
`1.0`), and `splats_datum_gap_m` (default `5`). The `header` way lives in `sql/04_splats_header.sql`, which
`04_splats.sql` includes; the `control_points` way stays in `04_splats.sql`.

- One transaction: truncate, `COPY` into a text staging table, validate, solve,
  insert.
- **Optional.** A missing CSV loads an empty table and says so; it is not an
  error (the custom-trees rule).
- **A bad row or a bad fit fails the whole splat load**, naming the CSV line or
  the capture and the rule. The tree load, which ran before, is unaffected.
- `load.sh` runs it after `03_checks.sql`. `test/run.sh` covers it with
  fixtures: an exact synthetic capture (known origin, heading 30°, scale 1,
  recovered within 1 mm and 0.01°), four points, missing CSV, wrong header,
  swapped LAT/LON header, two points, collinear points, coincident points, a
  mirrored capture (fails on `rms_m`), a scale of 1.5, a `File` that differs
  between rows, a missing file, a path in `File`, a `File` that is not `.spz`
  (a `.txt`, a `.ply`, an upper-case `.SPZ`), duplicate `Point`, blank
  `H` taking 0, a non-numeric `ALT`, an `ALT` that differs between a
  capture's rows, and the revision-8 header without `ALT` (refused like any
  wrong header). Blank `ALT` loads. For the exact synthetic capture it also checks that `lng`
  and `lat` equal `ST_X(geom)` and `ST_Y(geom)` exactly. These run with
  `splats_placement=control_points`.
- In `header` mode `test/run.sh` loads a `georef.csv` holding the `T1`
  fixture's header (KZ0918-075047's) and a southern-hemisphere one, and checks
  the placement against values computed outside PostGIS: `T1`'s origin is its
  first fix within 5 mm, `heading_deg` 359.3823° within 0.001°, `scale`
  1.000132 within 1e-5, `rms_m` and `points` NULL; that
  `control_points.csv` is not read (a broken one beside it loads); and that
  it rejects a wrong header, an empty `SplatID`, a non-numeric offset, an
  `EPSG` outside UTM, a missing file, a `.ply` `File`, an empty `File`, a
  `File` that is a path, a duplicate `SplatID`, a `File` on two rows (with
  the row's shape as the hint), and a capture without its LoD. A missing `georef.csv` loads nothing. An
  unknown `splats_placement` fails, and so does a `splats_datum_gap_m` of
  `0` or `abc`.
- The datum, in `header` mode: the two captures above, 16.9 m apart in
  `OFFSETZ`, form two groups of one, each at `altitude_m` 0. Five captures at
  `OFFSETZ` 10, 10.4, 11, 20 and 21 form two groups at the default gap, with
  datums 10.4 and 20.5 (an even count's median), so `altitude_m` is −0.4, 0,
  0.6, −0.5 and 0.5. At `splats_datum_gap_m=0.5` the first group splits
  between 10.4 and 11 (a gap of 0.6), and at `0.6` it does not (a gap equal
  to the threshold does not split); both split 20 from 21. The load's
  report gives each capture's group, datum and `altitude_m` with those values.
  `test/georef.sh` covers the generator (`infra/specs/georef.md`).

### Martin: the `splats` source

`martin.yaml` publishes the table, explicitly, as source id **`splats`** and
MVT layer **`splats`**: `id_column: id`, point geometry, `minzoom: 14`,
`maxzoom: 20`, properties `splat_id`, `file`, `bytes`, `altitude_m`,
`heading_deg`, `scale`, `lng` and `lat` (both `float8`). These names join the
published interface in `infra/CLAUDE.md`, next to `trees`.

**The point geometry is not the origin.** MVT stores geometry as integers on
the tile's `extent` grid. The layer reads the z14 tiles, and with
`extent: 4096` a z14 tile in Taipei is about 2.2 km wide, so the grid step is
about 0.54 m. A point snaps up to 0.27 m on each axis. Measured on the 22
captures, the snap moved each origin by 0.12–0.37 m, in a different direction
for each capture, so overlapping captures were drawn up to about 0.5–0.7 m
apart. `ST_AsMVT` writes `float8` properties as MVT doubles, so `lng` and
`lat` arrive exact. The geometry still decides which tiles hold a capture,
and nothing more.

### The files: a static `files` service

Martin serves tiles only. A new Compose service, `files` (`nginx`, pinned
image), serves `./data/3dgs/source` read-only at `/3dgs/`, and
`./data/3dgs/lod` at `/3dgs-lod/`, on `127.0.0.1:${FILES_PORT:-3080}`. Its config file is `infra/files.conf`:
`sendfile`, byte ranges, `Cache-Control: no-cache` with ETags (a replaced file
is refetched, an unchanged one is not), no directory listing, and no gzip (SPZ
is already gzip).

The app reaches it through a second same-origin proxy, exactly like `/tiles`
(`src/lib/tiles/specs/proxy.md` gains the entry): `/files/*` →
`FILES_PROXY_TARGET`, default `http://localhost:3080`, prefix stripped, the same
validation rules and failure messages. It passes `Range` through and the
`206` back: Spark reads a `.rad` header by range. The browser asks for
`/files/3dgs-lod/KZ0918-075047-lod.rad`, then its chunks,
`/files/3dgs-lod/KZ0918-075047-lod-<n>.radc`.

## `SplatSource` — the descriptor

Rule 4: the layer holds no endpoint. `src/sources.ts` gains `SPLATS`, and
`src/lib/tiles/specs/spec.md`'s *Source descriptors* gains its type:

```ts
// layers/splat — georeferenced Gaussian splat captures
interface SplatSource {
  tiles: string;          // "/tiles/splats/{z}/{x}/{y}"
  sourceLayer: string;    // "splats"
  files: string;          // "/files/3dgs/" — a capture's file is files + its `file`
  lodFiles: string;       // "/files/3dgs-lod/" — what the layer draws; see lodUrlOf
  attribution: string;    // in the map's credit line while a capture is drawn
  name: string;
}
```

`schema.ts` holds the one reading (rule 5):

- `splatOf(props)` reads one feature into a `Splat` (`id`, `file`,
  `lngLat`, `altitudeM`, `headingDeg`, `scale`, `bytes`). It returns
  `null`, never a guess, for a feature with a missing or invalid property.
  `lngLat` is `[lng, lat]` from the `lng` and `lat` properties, which must be
  finite with `lng` in [−180, 180] and `lat` in [−85.06, 85.06] (Web
  Mercator's range). It never comes from the feature's geometry, which is
  quantized (*Martin: the `splats` source*). The geometry is not read at all,
  so its type is not checked either.
- `lodUrlOf(source, splat)` is the capture's paged LoD tree, the one URL the
  layer fetches: `lodFiles + <stem>-lod.rad`, where `<stem>` is `file` less
  its last extension, encoded. This is the one place in the app that holds
  the name rule. `infra/sql/04_splats.sql` requires the same file under the
  same rule, so the published interface carries no second file name.
- `placement(splat)` returns its matrix in the local metre frame:
  `diag(east, north, 1) · rotateZ(−heading) · scale(scale)`, that is
  `diag(east, north, 1) · similarity(splat)` with `east, north = axesOf(splat)`.
  The translation from the anchor is added by the layer (*The frame*).
- `splatTiles(source)` is the `TileSource<Splat>` adapter for `TileStore`,
  like `treeTiles`.
- `splatsIn(perTile, centre)` merges the captures of several tiles, once each
  by `id` (a point in a tile's buffer arrives once per covering tile), nearest
  the view's centre first.

## Which captures load

These rules, everything below except the fetching, are `Residency` in
`residency.ts`. It is plain data: the queue, the loaded set, the one loading
and the errors, with distances from the view's centre. It holds no mesh and
does no I/O. The layer offers it what the tiles hold, asks `next` what to load
(and what that evicts), reports each load with `done` or `failed`, and
disposes what `next` evicts and `settle` unloads. `SplatStatus`'s counts come
from it.

- The layer keeps its own `TileStore` with `splatTiles(SPLATS)`, on the shared
  z14 grid. On `viewSettled`, and also when it is attached, shown, or its
  `minZoom` changes (so a capture appears without waiting for the next pan),
  and only while the layer is visible and the map zoom is at least `minZoom`,
  it asks the store for the z14 tiles covering the view.
- A capture whose anchor is in those tiles starts loading, one at a time,
  nearest the view's centre first (`splatsIn`). The tiles are those meeting the
  view's ground footprint, clipped to `SPLAT_FETCH_HALF_M` (2 km) around the
  centre, plus one ring (`planTiles` in `lib/tiles`, shared with AO).
- **Distance.** On `viewSettled`, while the layer is drawing, a loaded
  capture whose anchor is more than **`SPLAT_KEEP_M` (10 km)** from the view's
  centre is unloaded, and a queued one that far is dropped from the queue.
  10 km exceeds the farthest a capture can load from (the 2 km clip, a
  partial z14 tile and one ring: about 6.4 km per axis, 9.1 km on the
  diagonal; a test checks this at several latitudes). So a capture just
  loaded is never unloaded on the next settle, and one at the edge does not
  reload repeatedly.
- **Count.** At most **`SPLAT_MAX_CAPTURES` (16)** are loaded at once. When
  one more is due, the farthest loaded capture is unloaded if it is farther
  than the one due; otherwise the one due waits in the queue until the next
  plan. Each paged mesh needs at least its root page, and 16 is well under the
  smallest pool (96 pages).
- **Unloading** removes the mesh from the scene, disposes it, and forgets the
  capture (`loaded` and `known`). If its tile is planned again, it is found
  again and reloaded, which costs a header fetch and the pages the view
  needs. Spark returns its pages to the pool at its next LoD update once it
  has gone unrendered for `lodCleanupTimeoutMs`; `dispose` alone does not.
- Below `minZoom`, or when hidden, nothing new loads and nothing is unloaded
  by the layer. Spark frees an unrendered capture's pages and tree itself
  after 3 s, and fetches them again when it shows.
- **Memory** is bounded by Spark's page pool (256 MB on the GPU and 256 MB on
  the CPU, on desktop) and by `SPLAT_MAX_CAPTURES`. It does not depend on how
  many captures infra holds or on how long the map has been panned. In the
  app, with both KZ0918 captures in view, the tab held 4.9–5.1 GB, flat over
  a 2-minute orbit, against 1.85 GB with the splats off. In the Spark-only
  harness it held 2.4 GB (*Level of detail*).
- **When every capture is unloaded** the layer draws nothing, so Spark's
  cleanup does not run, and the last captures' worker trees and page
  assignments stay until a capture loads again. This holds no extra memory,
  because the pool is allocated either way, and it is bounded by
  `SPLAT_MAX_CAPTURES`.

## The mount — `mountSplat(ctx, { splats }, settings, hooks)`

Follows `src/lib/mount/specs/spec.md`, and adds one row to its table:

| factory | sources | `S` | hooks | extra members |
| --- | --- | --- | --- | --- |
| `mountSplat` | `{ splats: SplatSource }` | `SplatSettings` | `onStatus(SplatStatus)` | — |

A fifth argument, `deps`, replaces Spark, `fetch`, the footprint and the tile
adapter in tests. A host never passes it.

- Constructs `ThreeSplatLayer` and registers its paint bridge under
  `SPLAT_LAYER_ID`.
- `update` pushes only what changed. Visibility and opacity go through the
  bridge, never straight to the class.
- `prepareSync` re-adds the custom layer through `nativeLayer().ensureAdded()`
  if the style dropped it, then returns the one record.
- `dispose` clears the bridge and disposes the class: the `SplatMesh`es, the
  `SparkRenderer`, the store (`TileStore.dispose`, which aborts its in-flight
  tile fetches and drops its queue), then `super.dispose()`.
- **No DAG node.** Nothing depends on the splats.
- `SplatStatus`: `{ state: "idle" | "loading" | "ready" | "error"; known:
  number; loaded: number; loading: string | null; errors: { id: string;
  message: string }[]; platformBudget: number | null }`. `known` counts
  captures found in fetched tiles and not unloaded since; `loaded` counts the
  captures held now. `platformBudget` is Spark's
  `defaultSplatTarget()` once Spark has loaded, `null` before.
  `idle`: none known. `loading`: one is loading. `ready`: none loading, and
  at least one not failed. `error`: every known capture failed. One failure
  goes into `errors` and does not stop the others.

## The GeoLibre record — `splatRecord(settings)`

```ts
{
  id: SPLAT_LAYER_ID,                 // "threejs-splat"
  name: "Gaussian splats · three.js",
  type: "gaussian-splat",             // the real LayerType; inert on this path
  source: {},                         // the layer fetches its own tiles and files
  visible: settings.visible,
  opacity: settings.opacity,
  style: { ...DEFAULT_LAYER_STYLE },
  metadata: {
    customLayerType: "threejs",
    nativeLayerIds: [SPLAT_NATIVE_LAYER_ID],
    paintMode: "plugin",
  },
}
```

All captures share one record and one custom layer, because Spark sorts them
together in one draw. They are shown, hidden and faded together.

### Stacking

The host mounts and syncs `splat` **last**, after `tree`. Splats are
translucent and write no depth, so they draw after every opaque layer and are
tested against its depth: buildings and tree meshes in front hide them. AO's
composite multiplies what was drawn before it, so it never darkens a splat.

## Settings — `SplatSettings`

| field | type | default | UI |
| --- | --- | --- | --- |
| `visible` | `boolean` | `false` | panel "Gaussian splats", checkbox "Captures"; and the "Gaussian splats" entry in the map's layer menu |
| `opacity` | `number` in [0, 1] | `1` | slider "Opacity", 10–100 % in 2 % steps (as the tree meshes'), applied as `SplatMesh.opacity` |
| `minZoom` | `number` | `15` (`SPLAT_MIN_ZOOM`) | none; a constant the host may pass. The panel shows it, `StatLine` "Captures from" `z15`, as the trees show theirs |
| `lodSplatCount` | `number \| null` | `null` | checkbox "Platform budget" (checked = `null`), and when unchecked a slider "Budget", 0.25–10 M splats in 0.25 M steps |
| `lodSplatScale` | `number` in [0.1, 4] | `1` | slider "Budget scale", ×0.1–×4 in 0.05 steps |

`lodSplatCount` and `lodSplatScale` are `SparkRenderer`'s own fields
(<https://sparkjs.dev/docs/spark-renderer/>). Spark draws at most
`(lodSplatCount ?? its platform default) × lodSplatScale` splats per frame, from
every loaded capture's LoD tree together. The platform default is Spark's
`defaultSplatTarget()`: 2.5 M on desktop, 1.5 M on iOS, 1 M on Android, less on
headsets. `null` keeps that default, so the same setting suits every device.

- They are not GeoLibre concepts, so they are not on the paint bridge. The
  mount pushes them with `layer.setLod(lodSplatCount, lodSplatScale)`, only
  when one of them changed.
- The layer applies them to the `SparkRenderer` if there is one, and passes
  them to its constructor when Spark is first loaded or the context changes,
  so a value set before any capture loads is not lost.
- Spark compares the budget every frame and redoes the LoD when it changes, so
  a new value shows at the next frame. The layer requests that frame.
- The panel shows the effective budget, `StatLine` "Drawn per frame": e.g.
  `2.5 M × 1.00 = 2.5 M`. Before Spark has loaded, the platform default is not
  known, and it reads `auto × 1.00`.

Off by default, so nothing is fetched until it is asked for. The panel shows
the state (`zoom in to z15`, `none in view`, `loading <id> (n/m)`, `n/m
loaded · k failed`). The map's credit line shows `SPLATS.attribution` while a
capture is drawn, as it does the tree models' credit.

## Invariants

1. `ThreeSplatLayer` is a `ThreeLayer`, declares no `prerender`, and draws only
   inside `pass` (rule 7 and its guard, unchanged).
2. `decomposeCamera` returns a `V` with det +1 and `P · V` equal to its input
   up to a positive scale, and `P`'s `w` row is exactly `(0, 0, −1, 0)`.
3. Only `onDirty` and the base class's own events request a repaint. With the
   camera still and no load running, the map reaches `idle`.
4. Spark is never imported, and no tile or file is fetched, while the layer is
   hidden or below `minZoom` and nothing has been loaded before.
5. One reading of a capture (`splatOf`), in `schema.ts`. A capture's origin
   comes from its `lng`/`lat` properties, never from tile geometry.
6. The attribution is in the map's credit line whenever a capture is drawn.
7. One copy of `three` (`npm ls three` lists one version).
8. infra: a bad control-point row or a fit over its checks fails the whole
   splat load, and the tree load is unaffected by it. So does a capture
   without its `<stem>-lod.rad` header (`build-lod.sh` checks the chunks).
9. What the layer holds is bounded by Spark's page pool and
   `SPLAT_MAX_CAPTURES`, not by the captures in infra: no capture's whole file
   is ever fetched, and no more than 16 are loaded.

## Tests

- `lib/three/decomposeCamera.test.ts`: round-trip on synthetic perspective ×
  rigid matrices, including off-centre principal points; throws on a
  reflected input, a sheared depth row, and non-finite input. **Fixtures**: the
  18 `mainMatrix` captures from the spike (MapLibre 6.10.0), each times its
  `mercatorFrame`, decompose with relative round-trip error < 1e-12.
- `lib/tiles/grid.test.ts`: `trueMetreAxes` at 0°, 25.04° and 60° against
  values computed outside the app (to 1e-9), and the equator's closed forms
  (`R/a`, `R·a/b²`). For every latitude, east < 1 and east < north. North is
  not always over 1: M passes R near 48°.
- `lib/tiles/proxy.test.ts`: `FILES_PROXY_TARGET` gets the same five
  assertions as `TILES_PROXY_TARGET`; through a real Vite server, a `Range`
  request reaches the target unchanged and its `206` comes back.
- `splat/schema.test.ts`: `splatOf` on valid and on each kind of invalid
  feature, including a missing, non-finite or out-of-range `lng` or `lat`.
  Given a geometry 0.3 m from its `lng`/`lat`, `splatOf` takes the properties
  to the last bit. A real MVT carrying the `splats` layer's properties
  (`lng`/`lat` as doubles, written with `pbf`'s `PbfWriter` in the test,
  since no MVT encoder is a dependency), decoded through `decodeMvt` at z14, gives back `lngLat` equal to the
  encoded doubles; `lodUrlOf` (the stem, only the last extension, a stem already
  ending in `-lod`, encoding); `splatsIn` deduplicates. `planTiles` is tested in `lib/tiles/frame.test.ts`.
- `splat/frame.test.ts`, on plain numbers, with the stretch evaluated on the
  CPU: `similarity` maps a local point to the east/north the loader's solve
  predicts, for several headings, and keeps up as up and is a proper rotation
  (det > 0); `placeCapture`, matrix then stretch, maps local +x to
  `east·scale` and +y to `north·scale` at heading 0, equals `translation · k ·
  diag(east, north, 1) · similarity` off the anchor, keeps up unstretched,
  puts the origin at the capture's Mercator offset (north up, altitude times
  `k`), leaves the origin fixed under the stretch, keeps a capture's size in
  metres from anchors at different latitudes, and has det > 0 at any
  heading; `rebased` stays within `SPLAT_REBASE_M` and moves past it.
- `splat/residency.test.ts`, on plain captures and views: each capture is
  queued once, in the order offered; one load at a time; a failed capture
  stays known and counted, and is not retried; past `SPLAT_MAX_CAPTURES` a
  nearer capture evicts the farthest and a farther one waits, and the
  evicted one is found again; `settle` forgets loaded and queued captures past
  `SPLAT_KEEP_M` and keeps the rest; `clear` returns what was loaded.
- `splat/records.test.ts`: the record's shape.
- `splat/mount.test.ts` on the fake map, with Spark and the store stubbed:
  bridge registration and clearing, `update` pushes only changes,
  `ensureAdded` after a style drop, dispose order, dispose aborting a tile
  fetch still in flight, "exposes exactly its
  members", nothing fetched or imported while hidden or below `minZoom`,
  one-at-a-time loading, each mesh paged from its `.rad` with Spark's pool and
  cleanup timeout left at their defaults, and status for one failure among
  several. Unloading: a capture past `SPLAT_KEEP_M` on a settled view is
  removed, disposed and forgotten, one within it stays, and it loads again
  when its tile returns; nothing is unloaded while hidden; past
  `SPLAT_MAX_CAPTURES` a nearer capture unloads the farthest and a farther
  one waits; `SPLAT_KEEP_M` exceeds the farthest planned tile. The frame: across draws at different centres a mesh's matrix does
  not change, only the camera; `viewSettled` moves the anchor past
  `SPLAT_REBASE_M` and not within it, and the capture still lands where
  MapLibre projects it after the move. True metres: each mesh is created
  with a world modifier that stretches about its origin by its own latitude's
  `trueMetreAxes` and leaves up alone, and the end-to-end projection lands true
  metres (each point through the mesh matrix and then the modifier) where
  MapLibre puts the capture's lng/lat plus `east·`/`north·` true metres. The
  fake Spark's `dyno` evaluates the block on the CPU for this.
- Structure guards: the host allowlist gains `mountSplat` and `SplatSettings`
  only; `SPLATS` is the only place `/files/` appears outside `lib/tiles`.
- infra: `test/run.sh`, the fixtures listed under *The metadata CSV*, and a
  capture without its LoD; in `header` mode, the cases under *Georeference
  CSV → `splats` table*; `test/georef.sh` (`infra/specs/georef.md`);
  `test/build-lod.sh` (`infra/specs/build-lod.md`).

In the browser: each capture renders upright at its place and keeps its shape at
high pitch and any bearing; both KZ0918 captures match the OSM footprints at
zoom 19 at the four edges of each capture; buildings in front hide it; it survives a basemap
swap; after a pan the map goes idle and sunlight/AO recompute. Overlapping
captures (KY0917A over KY0917C, and KZ0918-093638, -095308 and -101007-1/-2)
show no seam where they meet: the same kerb, wall or pole lines up across
them. Against the live Martin, every capture's decoded z14 `lngLat` equals the
table's `lng`/`lat`.

## Documentation changes, with the implementation

- `app/CLAUDE.md` folder map (`splat/`), and the count of three.js layers.
- `src/lib/three/specs/spec.md`: `decomposeCamera`; the class list.
- `src/lib/mount/specs/spec.md`: the factory row; the host's mount order.
- `src/lib/tiles/specs/spec.md` and `specs/proxy.md`: `SplatSource`, `SPLATS`,
  the `/files` proxy.
- `ai/DECISIONS.md`: Spark in a `ThreeLayer` over `maplibre-gl-splat`;
  splat metadata in PostGIS and files from a static service.
- `ai/STACK.md`, `ai/ARCHITECTURE.md`, `ai/WORKFLOWS.md`: Spark, the `files`
  service, adding a capture (choosing and entering control points).
- `infra/CLAUDE.md`, `infra/README.md`: the table, the control-point CSV and
  its fit checks, the `splats` names, `FILES_PORT`.

## Open items

1. **The control points.** Three or more per capture, in
   `infra/data/3dgs/control_points.csv`, filled by hand.
2. **`FILES_PORT` default `3080`** (decided). Free on the development machine;
   it avoids `3000` and the remote host's `3001`. Check the remote host before
   deploying.
3. **`SPLATS.attribution`** is a placeholder (`3DGS captures`) until the
   captures' credit is known.

## Changes in revision 11

- **A header-placed capture's `altitude_m` is `OFFSETZ − datum`**, not
  `OFFSETZ`. The captures are grouped by `OFFSETZ` (a new group where sorted
  neighbours differ by more than `splats_datum_gap_m`, default 5 m), and each
  group's datum is its median `OFFSETZ`, at every load. *The datum* says how.
- **Why.** Revision 10 drew every capture about 25 m above the map. The
  header's heights are what stitch the captures together, to RTK's accuracy,
  so they are kept relative to each other and shifted together. Only
  `OFFSETZ` is used: a capture's ground, its antenna height `H` and a nominal
  antenna height are all estimates, and none of them is assumed. So the
  origins, the antenna at each scan's first fix, land near the map's ground,
  and the captures' own ground 1.4–1.7 m below it.
- The load prints each capture's group, datum and `altitude_m`. The
  `splats` table and the app do not change.
- Not done:
  - Grouping by position (overlap or distance). It matches "shares a seam"
    better, but height alone was chosen. A smaller gap can split captures
    that overlap.
  - A fixed datum. A new capture can move its group.

## Changes in revision 10

- **A capture is placed from its PLY header by default.** `04_splats.sql`
  gains `splats_placement`: `header` (the default) places each capture from
  `georef.csv` alone, a copy of its scan's PLY georeference, and
  `control_points` is the fit as before. `load.sh` passes
  `SPLATS_PLACEMENT` through. *Placement* and *Georeference CSV → `splats`
  table* say how.
- **The height is the header's too.** `altitude_m` is `offsetz`, the origin's
  ellipsoidal height, not `mean(H − scale·Z)`. The map has no terrain, so each
  capture is drawn some 25 m above the map's ground. This is on purpose: the
  header's placement is shown as it is, nothing from the control points or the
  antenna height corrects it. The horizontal placement agrees with the
  control-point fit to its residual.
- New: `infra/scripts/georef.mjs` writes `infra/data/3dgs/georef.csv` from
  each scan's `point_cloud.ply` header (`infra/specs/georef.md`). The header
  reading moves out of `control-points.mjs` into `scripts/ply-header.mjs`,
  shared by both, with the same refusals.
- `splats.rms_m` and `splats.points` become nullable: NULL when placed by the
  header. Neither is published.
- The app does not change: it reads `lng`, `lat`, `heading_deg`, `scale` and
  `altitude_m` as before.
- Not done:
  - The geoid. `offsetz` is ellipsoidal; nothing subtracts `gnss.csv`'s
    `undulation`.
  - Removing the control-point fit, or its CSV. It stays, one variable away.
  - Placing a capture without a georeferenced PLY in `header` mode. It has no
    `georef.csv` row and is not loaded.

## Changes in revision 9

- **`control_points.csv` gains `ALT`, after `LON`.** It records the altitude
  of the capture file's origin: for a scan, its PLY header's `offsetz`. That
  number is what turns the file's z back into a GNSS altitude
  (`altitude = offsetz + z`). The CSV is the one place a capture's
  georeference is written down outside its PLY, and without `ALT` the vertical
  part was lost. The header becomes
  `SplatID,File,Point,X,Y,Z,LAT,LON,ALT,H,Note`, still matched exactly.
- The loader validates `ALT` (blank or a number, one value per capture) and
  does not use it. The fit, the `splats` table, the tiles and the app are
  unchanged.
- A file with the old header is refused by the loader, naming the expected
  header. `control-points.mjs` upgrades one when it writes
  (`infra/specs/control-points.md`, revision 9).
- The loader's fixtures gain the column (blank).
- Not done:
  - Storing `ALT` in `splats` or publishing it. Nothing reads it yet, and
    the map has no terrain to set it against.

## Changes in revision 8

- **A capture's origin is read from `lng`/`lat` properties, not from the
  tile's point.** Until now `splatOf` took `lngLat` from the MVT point. At z14
  with `extent: 4096`, that point is quantized to a grid of about 0.54 m, so
  each capture was drawn 0.12–0.37 m off its solved origin, in a different
  direction per capture. The values were measured by decoding Martin's tiles
  with the app's own `decodeMvt` and `splatOf` and comparing them with the
  table. Overlapping captures disagreed by up to about 0.5–0.7 m, while the
  3dgs-viewer, which reads `control_points.csv` directly, lined them up.
  Heading, scale and the per-axis metres were already exact: through the
  table's values, every control point lands within 1 mm of its RTK fix.
- `splats` gains `lng` and `lat`, `double precision` columns generated from
  `geom`. Martin publishes them as `float8`, and they join the published
  property names in `infra/CLAUDE.md`. The point geometry stays, to say which
  tiles hold a capture.
- Alternatives not taken:
  - A larger `extent` (2²⁰ gives about 2 mm). It only shrinks the error
    rather than removing it, and it couples the origin's accuracy to a tiling
    setting.
  - Fetching the capture's tiles at z20. That still leaves about 1 cm of
    quantization, and costs many more tiles.
- Not changed: `heading_deg` and `scale` stay `real`. Float32 rounding there
  moves a point 300 m out by under 0.2 mm.
- Files changed:
  - Code: `infra/sql/01_schema.sql`, `infra/martin.yaml`, `schema.ts`, with
    tests in `schema.test.ts` and `infra/test/run.sh`.
  - Docs: `infra/CLAUDE.md` (the property list and what the point is for)
    and a new top entry in `app/ai/DECISIONS.md`.
  - After it lands: re-run `infra/load.sh` and restart Martin so it reads the
    new columns.

## Changes in revision 7

- **The loader takes `.spz` only**, matched in lower case. It used to accept
  `.spz .ply .splat .ksplat .sog`, the formats Spark parses by name. But the
  layer draws only the LoD tree, and `build-lod.sh` reads only
  `source/<scan>.spz`. So any other row passed the row check and then always
  failed with "its LoD … is not in …", which names the wrong cause. The
  error is now "File '…' is not .spz". `process-splat.sh` already writes
  `.spz`, so no capture in use changes.
- `control-points.mjs` checks the three points it picks with the loader's
  measure of a line, the smallest singular value (`infra/specs/control-points.md`,
  revision 7). A generated file can no longer fail the loader's line check.

## Changes in revision 6

Drafted as `specs/ellipsoid-placement.md` and folded in here.

- **infra fits on WGS 84**, not on the map's sphere (*The solve*, step 1). For
  a georeferenced scan the residual drops from 0.13–0.22 m RMS (sphere) to
  millimetres. On the KZ0918 scans: scale 1.0001, heading 359.38°, RMS 0.000 m.
  `scale` and `heading_deg` keep their meaning.
- **The layer draws each axis with its own map-metres-per-true-metre**
  (`trueMetreAxes`). `placement` becomes `diag(east, north, 1) · similarity`.
  The sphere fit could only take the best uniform compromise, which left the
  capture 0.2–0.4 cm per metre wider east–west and 0.1–0.2 cm per metre
  narrower north–south than the map. Simulated over every RTK fix, the new fit
  is 0.000 m off at the median and 0.002 m at most.
- **The per-axis part is a Spark world modifier** (`stretch.ts`), since
  Spark's mesh transform keeps one scale. `covSplats` (option (a) of the
  draft) is ruled out: it throws on a paged mesh in Spark 2.3.1, before the
  draft's two-capture crash even comes into it.
- **Not measured in this change:** the modifier's per-frame cost with both
  captures loaded. The draft's budget was within 10% of the default mode
  (39 fps, 5.4 GB). The modifier adds three vector operations per splat to
  the generator Spark already runs, and no memory. Check it in the browser.
- infra's test fixtures for exact recovery (`ok.csv`, `old-frame.csv`) are
  regenerated on the ellipsoid. The T1 case tightens to 5 mm, 0.01°, 1e-4 of
  1/k, and an RMS under 5 mm.

## Changes in revision 5

Drafted as `specs/paged-lod.md` and folded in here. Its step-0 spike results
are under *Level of detail*.

- The layer draws each capture's **paged LoD tree** (a chunked `.rad`: a
  header and one `.radc` file per chunk, built offline by `infra/scripts/build-lod.sh`
  and served at `/3dgs-lod/`), not the `.spz` with a tree built in the browser.
  The spike measured a single-file `.rad` read by byte ranges. Chunked was
  chosen after it; the chunks hold the same data, fetched whole. `SplatSource` gains `lodFiles`; `schema.ts` gains
  `lodUrlOf`.
- `lodCleanupTimeoutMs` goes back to Spark's default, and the page pool is
  Spark's platform default. The draw budget is not capped.
- Captures no longer stay loaded for the life of the map: they are unloaded
  past `SPLAT_KEEP_M` (10 km) on a settled view, and at most
  `SPLAT_MAX_CAPTURES` (16) are held.
- infra: the splat load requires every capture's `<stem>-lod.rad`
  (`splats_lod_dir`).
- Paged LoD and evicting loaded captures leave *Out of scope*.

## Changes in revision 4

- The control points' frame is the file's own, and nothing else's: a scan's
  `poses.csv` is not in it. Revision 3 required each capture to be stored in
  its poses' frame; the KZ0918 PLYs are not (they are georeferenced, UTM 51N
  less the first fix), and their points, written from the poses, drew them
  turned 21.9° and 91.3°, 18 m and 166 m off (median).
- The KZ0918 description: georeferenced PLY, z up, not "y down, render wrong
  until redelivered".
- The layer, the loader and the CSV's columns do not change.

## Changes in revision 3

- One frame for a capture's file, its poses and its control points, z-up, as
  stored. The loader reads `X, Y, Z` as file coordinates (the measuring
  frame's `file x = −X, file y = Z, file z = Y` is gone), and `placement` is
  `rotateZ(−heading) · scale` again: revision 2's `UPRIGHT` is removed.
- The KZ0918 files as delivered are not in their poses' frame and render
  wrong until redelivered.
- A point measured by hand is read in the file's stored coordinates, not in a
  y-up viewer.

## Out of scope

- Splats as occluders for sunlight or AO, in the probe, or in the USD export.
- Cropping floaters in the layer (infra's `process-splat.sh` does it).
- A user setting for the page pool, the keep radius or the capture count.
- Spherical harmonics in the LoD.
- Per-capture visibility or opacity.
- Loading a capture from a URL the user types.
- Removing the splat mount from a live map (as for every mount).
