/**
 * A tree's size: how tall and how wide it draws. The module behind *Per-instance
 * transform* and *Base width is per form* in `specs/spec.md`.
 *
 * Like `forms.ts` and `placement.ts`, free of three.js at runtime, so the one
 * rule every consumer scales by is testable without a GL context. The meshes,
 * the sunlight occluders and the USD export all call `crownScale`, which is what
 * keeps a tree's drawn crown, its shadow and its exported prim the same size.
 */
import type { BufferGeometry } from "three";

/** The size a shape was modelled at: its measured `baseHeightM` and `baseWidthM`. */
export interface CrownBase {
  heightM: number;
  widthM: number;
}

/** One tree's size, as the data gives it. */
export interface CrownSize {
  /** Already resolved: the surveyed height, or the source's `fallbackHeightM`. */
  heightM: number;
  /** The surveyed `canopy_width_m`, or `null` where none was recorded. */
  widthM: number | null;
}

/** The instance scale: `y` is vertical, `xz` is both horizontal axes. */
export interface CrownScale {
  y: number;
  xz: number;
}

/**
 * The scale that brings a shape modelled at `base` to this tree's size.
 *
 * `heightScale` exaggerates the vertical only, the way the buildings' does. A
 * tree with a measured width is exactly that wide. One without keeps its form's
 * proportions **at its true height**, so the slider stretches every tree the
 * same way whether or not its width was measured.
 */
export function crownScale(base: CrownBase, tree: CrownSize, heightScale: number): CrownScale {
  return {
    y: (tree.heightM * heightScale) / base.heightM,
    xz: tree.widthM === null ? tree.heightM / base.heightM : tree.widthM / base.widthM,
  };
}

/**
 * The diameter of the smallest vertical cylinder about the local `y` axis that
 * contains every vertex: twice the greatest horizontal distance from the axis.
 *
 * A radius, not a bounding box, because every tree is yawed by its own
 * `rotationOf`. A box's width changes with the yaw, so two trees of the same
 * surveyed width would draw at different sizes depending on which way they
 * face. The radius is the same at every yaw.
 */
export function radialWidthM(geometries: Iterable<BufferGeometry>): number {
  let r2 = 0;
  for (const g of geometries) {
    const pos = g.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      r2 = Math.max(r2, x * x + z * z);
    }
  }
  return 2 * Math.sqrt(r2);
}
