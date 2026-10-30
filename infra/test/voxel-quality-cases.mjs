// The cases of test/voxel-quality.sh: voxel-quality.mjs on hand-built voxels,
// no files. Prints one line per case, `ok <label>` or `FAIL <label>: <why>`.
import * as q from '../scripts/voxel-quality.mjs';

const results = [];
const check = (label, actual, want) => {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  results.push(a === w ? `ok ${label}` : `FAIL ${label}: want ${w}, got ${a}`);
};
const near = (label, actual, want, tol = 1e-6) => {
  results.push(Math.abs(actual - want) <= tol ? `ok ${label}` : `FAIL ${label}: want ${want}, got ${actual}`);
};

// A voxel from splats { x, y, z, a (alpha), s (largest σ, m), s2 (another axis) }.
const logit = (a) => Math.log(a / (1 - a));
function voxel(splats) {
  const n = splats.length, f = () => new Float32Array(n);
  const v = { n, x: f(), y: f(), z: f(), opacity: f(), scale0: f(), scale1: f(), scale2: f(),
    rot0: f(), rot1: f(), rot2: f(), rot3: f(), dc0: f(), dc1: f(), dc2: f() };
  splats.forEach((p, i) => {
    v.x[i] = p.x ?? 0.1; v.y[i] = p.y ?? 0.1; v.z[i] = p.z ?? 0.1;
    v.opacity[i] = logit(p.a ?? 0.9);
    // The largest σ on the axis named, so the score must take the max.
    v.scale0[i] = Math.log(p.s2 ?? 0.01); v.scale1[i] = Math.log(p.s ?? 0.05); v.scale2[i] = Math.log(0.01);
    v.rot0[i] = 1;
  });
  return v;
}
// n splats, one in each of the first n sub-cells of a 4×4 plane at z = 0.1.
const plane = (n, s = 0.05, a = 0.9) =>
  Array.from({ length: n }, (_, i) => ({ x: (i % 4) * 0.25 + 0.1, y: Math.floor(i / 4) * 0.25 + 0.1, z: 0.1, s, a }));

// --- the seam ---
check('exports name and version', [q.name, q.version], ['coverage-sharpness', 1]);
check('exports score and choose', [typeof q.score, typeof q.choose], ['function', 'function']);
const one = q.score(voxel([{}]));
check('score returns count and value', [typeof one.count, typeof one.value], ['number', 'number']);

// --- score ---
let s = q.score(voxel(plane(16)));
near('a plane through 16 of the 64 sub-cells: coverage 0.25', s.coverage, 0.25);
near('  sharpness 1 / 0.05 m', s.sharpness, 20, 1e-4);
near('  value = coverage × sharpness', s.value, 5, 1e-4);
s = q.score(voxel([{ x: 0.1 }, { x: 0.15 }, { x: 0.2 }]));
near('three splats in one sub-cell cover one', s.coverage, 1 / 64);
s = q.score(voxel([{ s: 0.1 }, { s: 0.3 }, { s: 0.2, x: 0.9 }]));
near('the median largest axis, odd count (0.2 m)', s.sharpness, 5, 1e-4);
s = q.score(voxel([{ s: 0.1 }, { s: 0.3 }, { s: 0.2, x: 0.9 }, { s: 0.4, y: 0.9 }]));
near('  even count: the mean of the middle two (0.25 m)', s.sharpness, 4, 1e-4);
s = q.score(voxel([{ s: 0.01, s2: 0.2 }]));
near('the largest axis, whichever it is (0.2 m)', s.sharpness, 5, 1e-4);
s = q.score(voxel([{ a: 0.3 }, { a: 0.2, x: 0.9 }]));
check('only transparent splats: value 0, count 2', [s.value, s.count], [0, 2]);
s = q.score(voxel([{ a: 0.9, s: 0.1 }, { a: 0.3, x: 0.9, s: 1 }]));
check('a transparent splat counts in count, not in coverage or sharpness',
  [s.count, s.coverage, Math.round(s.sharpness * 1e4) / 1e4], [2, 1 / 64, 10]);
s = q.score(voxel([{ a: 0.5 }]));
check('alpha exactly 0.5 is opaque', s.coverage, 1 / 64);
s = q.score(voxel([{ x: 0.99999994, y: 0, z: 0.5 }]));
check('a centre on the far face is the last sub-cell', s.coverage, 1 / 64);

// --- choose ---
const sharp = q.score(voxel(plane(16, 0.02)));
const blurry = q.score(voxel(plane(16, 0.1)));
check('a sharper scan beats a blurrier one at equal coverage', q.choose([blurry, sharp]), [1]);
const full = q.score(voxel(plane(16)));
const sparse = q.score(voxel(plane(4)));
check('a fuller scan beats an emptier one at equal sharpness', q.choose([sparse, full]), [1]);
check('within the band: the larger count wins', q.choose([{ value: 10, count: 5 }, { value: 9.5, count: 8 }]), [1]);
check('just outside the band: the best value wins despite fewer splats',
  q.choose([{ value: 10, count: 5 }, { value: 8.9, count: 80 }]), [0]);
check('all zero: the larger count', q.choose([{ value: 0, count: 3 }, { value: 0, count: 7 }]), [1]);
check('an exact tie: both', q.choose([{ value: 4, count: 6 }, { value: 4, count: 6 }]), [0, 1]);
check('one candidate: itself', q.choose([{ value: 0, count: 1 }]), [0]);

// --- order ---
const cands = [{ value: 10, count: 5 }, { value: 9.5, count: 8 }, { value: 9.2, count: 8 }, { value: 6, count: 50 }];
const pick = (xs) => q.choose(xs).map((i) => xs[i]).sort((a, b) => a.value - b.value);
const want = JSON.stringify(pick(cands));
const perms = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
check('the same candidates for every order of the 24',
  perms(cands).every((p) => JSON.stringify(pick(p)) === want), true);

console.log(results.join('\n'));
