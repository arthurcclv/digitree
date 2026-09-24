import { formOf, type TreeForm } from "../tree";

/**
 * What fraction of direct sun each occluder lets through. See *Transmittance*
 * in `specs/spec.md`.
 *
 * **The shipped values are placeholders.** Every form is 0.5 and no species is
 * overridden: enough to exercise the machinery, and no botanical claim.
 * Replacing them with measured values is a data change to these two tables,
 * reviewed the way the tree layer's species → form table is.
 */

/** A building is opaque: `exp(−1000)` is 0 in any float format. */
export const BUILDING_TAU = 1000;

/** The default for every tree of a form. Must name every form. */
export const FORM_ALPHA: Readonly<Record<TreeForm, number>> = {
  spreading: 0.5,
  upright: 0.5,
  tiered: 0.5,
  columnar: 0.5,
  conic: 0.5,
  "palm-feather": 0.5,
  "palm-fan": 0.5,
  generic: 0.5,
};

/**
 * Species that differ from their form's default, keyed exactly like the tree
 * layer's `SPECIES_FORMS` — no normalisation, for the same reasons.
 */
export const SPECIES_ALPHA: Readonly<Record<string, number>> = {};

/** A tree's transmittance: its species' override, else its form's default. */
export function alphaOf(species: unknown): number {
  if (typeof species === "string" && species in SPECIES_ALPHA) return SPECIES_ALPHA[species];
  return FORM_ALPHA[formOf(species)];
}

/** Optical depth. An opaque occluder gets `BUILDING_TAU`, not infinity. */
export function tauOf(alpha: number): number {
  return alpha <= 0 ? BUILDING_TAU : -Math.log(alpha);
}
