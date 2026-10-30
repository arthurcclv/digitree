# Spec — `voxel-quality.mjs`: which scan is best in one voxel

Status: **revision 1, approved 2026-10-29, implemented**, together with
`specs/splat-mosaic.md`.

## What it is

The mosaic (`specs/splat-mosaic.md`) keeps one scan per 1 m voxel. This module
decides which one. It is its own file, behind a seam the mosaic calls and
knows nothing else about, so the method can be tuned or replaced without
touching the mosaic.

**The rule it obeys:** a score is computed from one scan's splats in one
voxel, from those splats alone: their positions within the voxel and their
own attributes. It never uses poses, RTK, the camera path, another scan's
splats, or the neighbouring voxels.

## The seam

`scripts/voxel-quality.mjs` exports:

```js
export const name = 'coverage-sharpness';
export const version = 1;

// One scan's splats in one voxel → its score there.
export function score(voxel) { … }   // → Score

// The candidates of one voxel, one per scan → the indices of the ones it
// ranks best: one winner, or several it cannot tell apart.
export function choose(scores) { … } // Score[] → number[] (non-empty)
```

`voxel` is one scan's splats in one voxel, as parallel `Float32Array`s of
length `n` (n ≥ 1), in the file's stored units:

| field | meaning |
| --- | --- |
| `n` | the number of splats |
| `x`, `y`, `z` | the centre within the voxel, in [0, 1) metres from its low corner |
| `opacity` | as stored: a logit (`sigmoid(opacity)` is the alpha) |
| `scale0`, `scale1`, `scale2` | as stored: log metres (`exp(scale)` is the axis's σ) |
| `rot0` … `rot3` | as stored, a quaternion |
| `dc0`, `dc1`, `dc2` | as stored: SH degree 0 |

A `Score` is a plain object the module defines. The mosaic only stores it and
hands it back to `choose`; it reads none of its fields. Method 1's carries
`value` and `count` (below), which its `choose` and the tests read.

When `choose` returns more than one index, the mosaic breaks the tie itself:
of those, the scan whose name sorts first wins. `choose` must be a function
of its scores as a set: passing them in another order must return the same
candidates.

`name` and `version` go into every tile's header and into `mosaic.json`, so
a mosaic always says how it was chosen. A change to the method or to one of
its constants raises `version`, and revises this spec.

**Replacing the method** means a new module with the same exports and a new
`name`. The mosaic imports exactly one, `scripts/voxel-quality.mjs`. Its test
suite substitutes a stub through `SPLATS_QUALITY_MODULE`, a path to another
module with the same exports. That variable is for tests and experiments, and
a run that uses it reports the stub's `name`.

## Method 1: `coverage-sharpness`

The voxel is won by the scan that fills more of it with sharp, opaque
splats. Splats from a scan near its edge, or far from the scanner, are fewer
and larger there, and lose.

For one scan's splats in one voxel:

1. **Opaque splats** are those with `sigmoid(opacity) ≥ 0.5`. Only they count
   towards the score. A near-transparent haze adds almost nothing to the
   image, and in large numbers it would otherwise win.
2. **Coverage** `C`: divide the voxel into 4 × 4 × 4 sub-cells of 0.25 m.
   `C` is the fraction of the 64 sub-cells that hold the centre of at least
   one opaque splat, in [0, 1]. A wall passing through the voxel fills about
   16 of them, empty air none. The same surface gives the same ceiling for
   every scan of that voxel, so `C` compares scans, not voxels.
3. **Sharpness** `S` = 1 / median, over the opaque splats, of their largest
   axis, `max(exp(scale0), exp(scale1), exp(scale2))`, in 1/m. The median,
   not the mean, so that a few large splats do not decide. With an even count
   it is the mean of the middle two.
4. **`value = C × S`**, or 0 when there are no opaque splats.
5. **`count`** = n, all splats, opaque or not.

`choose(scores)`:

1. `best` = the largest `value`.
2. If `best` is 0 (no scan has an opaque splat there), every candidate is
   **in the band**. Otherwise the band is every candidate with
   `value ≥ 0.9 × best`.
3. Of those in the band, the one with the largest `count` wins. Within 10%
   the two scans are taken to be equally good, and the denser one usually
   holds the finer detail the two numbers miss.
4. Return every candidate in the band with the largest `count`: one, or
   several when they share it.

The band is decided against `best` alone, so the choice does not depend on
the order the candidates are passed in. A pairwise "within 10%" comparison
would not be transitive and would depend on that order.

| constant | value | what it means |
| --- | --- | --- |
| opaque | `sigmoid ≥ 0.5` | which splats count towards the score |
| sub-cell | 0.25 m (4 per axis) | the coverage resolution: the size cut's 0.25 m largest axis |
| band | 0.9 | how close a score must be to the best to compete on `count` |

These are this revision's values, chosen by reasoning, not tuned. Tuning
them on the delivered scans is expected and raises `version`.

## Tests

`test/voxel-quality.sh` runs the module on hand-built voxels (a small `.mjs`
beside it, with no files) and asserts:

- **score**: `C` and `S` for known layouts (a plane of 16 sub-cells; a single
  splat; all splats transparent → `value` 0); the median with odd and even
  counts; `sigmoid` and `exp` applied to stored units, not raw values;
- **choose**: a sharper scan beats a blurrier one at equal coverage; a fuller
  one beats an emptier one at equal sharpness; two scans within the band →
  the larger `count`; a candidate just outside the band loses even with more
  splats; all-zero values → the larger `count`; an exact tie → both indices;
- **order**: `choose` returns the same candidates for every permutation of
  its candidates;
- **seam**: the module exports `name`, `version`, `score` and `choose`, and
  `score` returns `count` and `value`.

## Out of scope

- Using anything but the voxel's own splats (see *The rule it obeys*).
- Mixing scans within a voxel.
- Learned or image-based metrics, such as rendering each scan's voxel and
  measuring its sharpness. A later method can do this behind the same seam
  if it keeps the rule.
