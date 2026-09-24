/**
 * The AO pass's constants: the hemisphere sample kernel, the 4 × 4 rotation
 * tile, and the composite factor the shader mirrors. Pure — see *Rendering*
 * in `specs/spec.md`.
 */

export const AO_SAMPLES = 16;

/** The rotation tile is 4 × 4 pixels. */
export const AO_NOISE_SIZE = 4;

export type Vec3 = [number, number, number];

/** mulberry32: a small, seedable PRNG, so the kernel is the same every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` sample offsets in the unit +Z hemisphere (the surface normal is +Z).
 * Lengths grow as `lerp(0.1, 1, (i/n)²)`, so samples crowd the centre, where
 * contact occlusion lives. No sample grazes the surface: z ≥ 0.15 of its
 * length, which keeps a flat face from occluding itself.
 */
export function aoKernel(n = AO_SAMPLES, seed = 1): Vec3[] {
  const next = rng(seed);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    let x: number, y: number, z: number, len: number;
    do {
      x = next() * 2 - 1;
      y = next() * 2 - 1;
      z = next();
      len = Math.hypot(x, y, z);
    } while (len > 1 || len < 1e-3 || z / len < 0.15);
    const t = i / n;
    const scale = (0.1 + 0.9 * t * t) / len;
    out.push([x * scale, y * scale, z * scale]);
  }
  return out;
}

/** One random unit vector per pixel of the rotation tile, row-major. */
export function aoNoise(seed = 2): Vec3[] {
  const next = rng(seed);
  const out: Vec3[] = [];
  while (out.length < AO_NOISE_SIZE * AO_NOISE_SIZE) {
    const v: Vec3 = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1];
    const len = Math.hypot(...v);
    if (len > 1 || len < 1e-3) continue;
    out.push([v[0] / len, v[1] / len, v[2] / len]);
  }
  return out;
}

/**
 * What the composite multiplies the frame by: `mix(1, ao, intensity)`,
 * extended past 1 and clamped, so intensities up to `AO_INTENSITY_MAX` darken
 * more steeply and saturate at black instead of going negative.
 */
export function compositeFactor(ao: number, intensity: number): number {
  return Math.min(1, Math.max(0, 1 + (ao - 1) * intensity));
}

/** The strongest intensity the panel offers: twice the plain `ao` multiply. */
export const AO_INTENSITY_MAX = 2;
