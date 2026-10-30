// Which scan is best in one 1 m voxel, for splat-mosaic.mjs: method 1,
// coverage-sharpness. The seam (name, version, score, choose) and the method
// are specs/voxel-quality.md. A score sees one scan's splats in one voxel and
// nothing else: no poses, no RTK, no other scan, no neighbouring voxel.
//
// A change to the method or to a constant below raises `version`, which every
// tile's header and mosaic.json record, and revises the spec.

export const name = 'coverage-sharpness';
export const version = 1;

// A splat counts towards the score when its alpha is at least 0.5. Opacity is
// stored as a logit, so that is a stored value of at least 0.
const OPAQUE_LOGIT = 0;
// 4 × 4 × 4 sub-cells of 0.25 m: the size cut's largest axis.
const SUB = 4;
// Within 10% of the best value, scans compete on their splat count.
const BAND = 0.9;

const subcells = new Uint8Array(SUB * SUB * SUB);

// `voxel`: { n, x, y, z (in [0, 1) within the voxel), opacity (logit),
// scale0..2 (log metres), rot0..3, dc0..2 }, parallel Float32Arrays of at
// least n. Returns { value, count, coverage, sharpness }.
export function score(voxel) {
  const { n, x, y, z, opacity, scale0, scale1, scale2 } = voxel;
  subcells.fill(0);
  const largest = [];
  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (!(opacity[i] >= OPAQUE_LOGIT)) continue;
    const c = subcell(x[i]) + SUB * (subcell(y[i]) + SUB * subcell(z[i]));
    if (!subcells[c]) { subcells[c] = 1; filled++; }
    // The largest axis's σ: exp of the largest stored log scale.
    largest.push(Math.exp(Math.max(scale0[i], scale1[i], scale2[i])));
  }
  if (largest.length === 0) return { value: 0, count: n, coverage: 0, sharpness: 0 };
  const coverage = filled / subcells.length;
  const sharpness = 1 / median(largest);
  return { value: coverage * sharpness, count: n, coverage, sharpness };
}

// The indices of the best candidates: those within the band of the best
// value, and of them the ones with the most splats. Decided against the best
// alone, so the order of `scores` cannot change the answer.
export function choose(scores) {
  let best = 0;
  for (const s of scores) if (s.value > best) best = s.value;
  const floor = best * BAND;
  let most = -1;
  for (const s of scores) if (s.value >= floor && s.count > most) most = s.count;
  const out = [];
  scores.forEach((s, i) => { if (s.value >= floor && s.count === most) out.push(i); });
  return out;
}

// A coordinate in [0, 1) → its sub-cell along that axis. Clamped: a centre on
// the voxel's far face, by float32 rounding, belongs to the last sub-cell, not
// past it.
function subcell(a) {
  return Math.min(SUB - 1, Math.max(0, Math.floor(a * SUB)));
}

function median(values) {
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}
