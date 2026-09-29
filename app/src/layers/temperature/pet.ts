import type { LpiField, ProbeResult } from "../sunlight";

/**
 * PET from LPI: the formula, its GLSL form, the ramp and the comfort classes.
 * Free of three.js so it can be tested. See *Definition* and *Ramp* in
 * `specs/spec.md`.
 */

/** The layer's DAG node, and the nodes it derives from. */
export const PET_NODE = "temperature.pet";

export interface PetParams {
  /** Global irradiance, W/m². */
  g0: number;
  /** Air temperature, °C. */
  ta: number;
  /** Wind speed, m/s. */
  v: number;
}

/** What `temperature.pet` publishes. PET at a texel is `petOf(lpi, params)`. */
export interface PetField {
  lpi: LpiField;
  params: PetParams;
  petRange: [number, number];
}

/**
 * `PET = irradiance · (G0 · (lpiSlope · LPI + lpiOffset)) + airTemp · Ta + wind · V + constant`.
 * The one table both forms are built from.
 */
export const PET_COEFFS = {
  irradiance: 0.0126,
  lpiSlope: 0.5986,
  lpiOffset: 0.0116,
  airTemp: 1.2537,
  wind: -2.5537,
  constant: -1.6374,
} as const;

const C = PET_COEFFS;

export function petOf(lpi: number, p: PetParams): number {
  return C.irradiance * (p.g0 * (C.lpiSlope * lpi + C.lpiOffset)) + C.airTemp * p.ta + C.wind * p.v + C.constant;
}

/** `[PET(0), PET(1)]`: full shade to full sun. */
export function petRange(p: PetParams): [number, number] {
  return [petOf(0, p), petOf(1, p)];
}

/** A GLSL float literal: always a decimal point, negatives parenthesised. */
function glslFloat(x: number): string {
  const s = String(x);
  const lit = /[.e]/.test(s) ? s : `${s}.0`;
  return x < 0 ? `(${lit})` : lit;
}

/** `petOf` as a GLSL expression, in the named variables. */
export function petGlsl(lpi = "lpi", g0 = "uG0", ta = "uTa", v = "uV"): string {
  const f = glslFloat;
  return (
    `${f(C.irradiance)} * (${g0} * (${f(C.lpiSlope)} * ${lpi} + ${f(C.lpiOffset)}))` +
    ` + ${f(C.airTemp)} * ${ta} + ${f(C.wind)} * ${v} + ${f(C.constant)}`
  );
}

// ---------------------------------------------------------------------------
// Ramp: fixed, evenly spaced stops, clamped outside. The shader indexes the
// stops by `(pet − PET_RAMP_MIN) / PET_RAMP_STEP`, so the spacing must be even.

export const PET_RAMP: readonly [number, string][] = [
  [22, "#3b6fb6"],
  [26, "#7fb8d6"],
  [30, "#f2e6a0"],
  [34, "#f5b35c"],
  [38, "#e56b3a"],
  [42, "#b8283a"],
  [46, "#6b0f3a"],
];
export const PET_RAMP_MIN = PET_RAMP[0][0];
export const PET_RAMP_STEP = PET_RAMP[1][0] - PET_RAMP[0][0];

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

export const PET_RAMP_RGB = PET_RAMP.map(([, hex]) => hexRgb(hex));

/** The ramp at a PET, as sRGB 0–1 — the shader's `ramp`, on the CPU. */
export function petRampAt(pet: number): [number, number, number] {
  const n = PET_RAMP.length;
  const s = Math.min(Math.max((pet - PET_RAMP_MIN) / PET_RAMP_STEP, 0), n - 1);
  const i = Math.min(Math.floor(s), n - 2);
  const t = s - i;
  const [a, b] = [PET_RAMP_RGB[i], PET_RAMP_RGB[i + 1]];
  return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * t) as [number, number, number];
}

// ---------------------------------------------------------------------------
// Taiwan-calibrated thermal perception classes (Lin & Matzarakis 2008).

export type PetClass =
  | "very cold"
  | "cold"
  | "cool"
  | "slightly cool"
  | "neutral"
  | "slightly warm"
  | "warm"
  | "hot"
  | "very hot";

/** Each class from its lower bound, inclusive; the first has none. */
export const PET_CLASSES: readonly { from: number; cls: PetClass }[] = [
  { from: -Infinity, cls: "very cold" },
  { from: 14, cls: "cold" },
  { from: 18, cls: "cool" },
  { from: 22, cls: "slightly cool" },
  { from: 26, cls: "neutral" },
  { from: 30, cls: "slightly warm" },
  { from: 34, cls: "warm" },
  { from: 38, cls: "hot" },
  { from: 42, cls: "very hot" },
];

export function classOf(pet: number): PetClass {
  let cls = PET_CLASSES[0].cls;
  for (const c of PET_CLASSES) if (pet >= c.from) cls = c.cls;
  return cls;
}

// ---------------------------------------------------------------------------

export type PetProbe =
  | { kind: "value"; pet: number; lpi: number; cls: PetClass }
  | { kind: "roof" | "incomplete" | "outside" | "none" };

/** A direct-sun probe, answered in PET. Every non-value passes through unchanged. */
export function petProbeOf(r: ProbeResult, p: PetParams): PetProbe {
  if (r.kind !== "value") return r;
  const pet = petOf(r.index, p);
  return { kind: "value", pet, lpi: r.index, cls: classOf(pet) };
}
