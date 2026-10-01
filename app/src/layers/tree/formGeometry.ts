import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { radialWidthM } from "./crown";
import type { TreeForm } from "./forms";

/**
 * The eight procedural shapes named in `specs/spec.md`. No glTF, no loader, no
 * asset and no async step — which is what keeps this change cheap, and what
 * makes a later per-form glTF swap cheap too: form is the axis that turns a
 * per-species asset problem (471) into a per-form one (8).
 *
 * Every builder returns its shape in metres, Y-up, base at the origin, as two
 * merged geometries — bark and canopy — so the layer keeps one material per
 * geometry. All offsets and rotations are fixed constants, never `Math.random`:
 * the same form yields the same geometry on every reload.
 */
export interface FormGeometry {
  bark: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
  /**
   * The height the shape was modelled at, which every instance scales from.
   *
   * **Measured from the geometry, never hand-written.** The constant it replaces
   * (`TREE_BASE_HEIGHT_M` = 13) had drifted from the mesh it described, which
   * actually stood 12.23 m — so every tree drew about 6% short of its surveyed
   * height. A declared number can drift again; a measured one cannot.
   */
  baseHeightM: number;
  /**
   * The canopy's width at the modelled size: the diameter of the smallest
   * vertical cylinder about the trunk that holds it (`radialWidthM`). What a
   * surveyed `canopy_width_m` scales from. The bark is left out: a trunk is
   * never wider than its crown except on a palm, and a palm's width is its
   * fronds. Measured, for the same reason `baseHeightM` is.
   */
  baseWidthM: number;
}

/** A round flat-shaded foliage lump, tumbled on all three axes. */
function blob(radius: number, at: [number, number, number], spin: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  g.rotateX(spin);
  g.rotateY(spin * 1.7);
  g.rotateZ(spin * 0.4);
  g.translate(...at);
  return g;
}

/**
 * A foliage lump squashed or stretched on Y, spun **about Y only**.
 *
 * The axis restriction is the point. A tilted disc is not a tier and a tilted
 * column is not a column, so tumbling these the way `blob` does would destroy
 * the silhouette the form class promises — which is the one thing a form class
 * is for.
 */
function stack(
  radius: number,
  rise: number,
  at: [number, number, number],
  spin: number,
): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  g.scale(1, rise, 1);
  g.rotateY(spin);
  g.translate(...at);
  return g;
}

/** A tapering trunk standing on the origin. */
function trunk(top: number, bottom: number, height: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(top, bottom, height, 9);
  g.translate(0, height / 2, 0);
  return g;
}

/**
 * A ring of `count` fronds at the top of a bare trunk, each pointing outward
 * along +z before being swung into place. `droop` is per-frond and positive
 * tips the frond down, so a crown mixes raised and hanging ones the way a real
 * palm does.
 */
function crown(
  count: number,
  droop: readonly number[],
  size: [number, number, number],
  reach: number,
  at: number,
): THREE.BufferGeometry[] {
  return Array.from({ length: count }, (_, i) => {
    const g = new THREE.BoxGeometry(...size);
    g.translate(0, 0, reach);
    g.rotateX(droop[i % droop.length]);
    g.rotateY((i * Math.PI * 2) / count);
    g.translate(0, at, 0);
    return g;
  });
}

/**
 * `mergeGeometries` refuses a mixed indexed/non-indexed set, and the builders
 * mix cones and boxes (indexed) with icosahedra (not), so level them first.
 * `toNonIndexed` returns the receiver unchanged when it is already flat, hence
 * the set: a part must not be disposed twice.
 */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const merged = mergeGeometries(flat, false);
  for (const p of new Set([...parts, ...flat])) p.dispose();
  if (!merged) throw new Error("tree form geometry could not be merged");
  return merged;
}

type Build = () => { bark: THREE.BufferGeometry; canopy: THREE.BufferGeometry };

const BUILDERS: Readonly<Record<TreeForm, Build>> = {
  /**
   * The shape this layer drew when every tree was the same one, kept exactly as
   * it was: it is what an unclassified species still draws, so the change is
   * additive and the 4.98% that is not classified looks no different.
   */
  generic: () => ({
    bark: trunk(0.34, 0.62, 6.2),
    canopy: merge([
      blob(3.5, [0, 8.2, 0], 0.0),
      blob(2.6, [1.9, 6.9, 0.9], 0.7),
      blob(2.4, [-1.7, 7.3, -1.1], 1.4),
      blob(2.1, [0.4, 10.4, -0.7], 2.1),
    ]),
  }),

  /** Wider than tall, on a short thick bole: 榕樹, 樟樹, 茄苳. */
  spreading: () => ({
    bark: trunk(0.42, 0.85, 4.4),
    canopy: merge([
      blob(4.2, [0, 6.6, 0], 0.0),
      blob(3.3, [3.4, 5.8, 1.2], 0.6),
      blob(3.1, [-3.1, 6.0, -1.4], 1.3),
      blob(2.9, [0.9, 5.6, -3.3], 2.0),
      blob(2.7, [-1.1, 6.4, 3.2], 2.7),
    ]),
  }),

  /** Taller than wide, an ovoid on a clear stem: 楓香, 臺灣欒樹, 白千層. */
  upright: () => ({
    bark: trunk(0.3, 0.55, 5.2),
    canopy: merge([
      blob(2.9, [0, 8.0, 0], 0.0),
      blob(2.5, [1.3, 10.2, 0.5], 0.5),
      blob(2.4, [-1.2, 6.6, -0.6], 1.1),
      blob(2.0, [0.3, 12.0, -0.4], 1.8),
    ]),
  }),

  /**
   * Flattened whorls with daylight between them, up a trunk that stays visible
   * to the top: 黑板樹's pagoda, 小葉欖仁's shelves. The gaps are the whole
   * point of the class, so the layers are thin and well separated.
   */
  tiered: () => ({
    bark: trunk(0.32, 0.6, 9.0),
    canopy: merge([
      stack(4.0, 0.22, [0, 6.0, 0], 0.0),
      stack(3.4, 0.22, [0.2, 8.5, -0.2], 0.9),
      stack(2.6, 0.22, [-0.2, 10.8, 0.2], 1.8),
      stack(1.7, 0.22, [0, 12.5, 0], 2.6),
    ]),
  }),

  /** Foliage to the ground, near-vertical sides: 龍柏, 福木, 羅漢松. */
  columnar: () => ({
    bark: trunk(0.26, 0.4, 2.2),
    canopy: merge([
      stack(1.7, 3.4, [0, 6.2, 0], 0.0),
      stack(1.1, 2.6, [0.3, 6.6, -0.25], 1.2),
    ]),
  }),

  /** A tapering spire in stacked skirts: 落羽杉, 南洋杉, 溼地松. */
  conic: () => {
    const skirt = (radius: number, height: number, at: number) => {
      const g = new THREE.ConeGeometry(radius, height, 9);
      g.translate(0, at, 0);
      return g;
    };
    return {
      bark: trunk(0.3, 0.55, 3.0),
      canopy: merge([skirt(3.0, 5.0, 5.0), skirt(2.3, 4.2, 8.0), skirt(1.5, 3.4, 11.0)]),
    };
  },

  /** Bare trunk, pinnate crown: 大王椰子, 黃椰子, 海棗. */
  "palm-feather": () => ({
    bark: trunk(0.26, 0.42, 11.0),
    canopy: merge(crown(9, [0.35, -0.2, 0.5, 0.1, -0.05], [0.5, 0.1, 4.2], 2.3, 11.0)),
  }),

  /** Bare trunk, palmate crown — shorter, stouter and more compact: 蒲葵. */
  "palm-fan": () => ({
    bark: trunk(0.4, 0.62, 7.0),
    canopy: merge(crown(10, [-0.5, 0.1, 0.4, -0.2], [1.5, 0.12, 2.4], 1.5, 7.0)),
  }),
};

/** Every form, in table order — the source of truth for what the layer allocates. */
export const TREE_FORMS = Object.keys(BUILDERS) as readonly TreeForm[];

/** Builds one form's geometry and measures the size it was modelled at. */
export function buildForm(form: TreeForm): FormGeometry {
  const { bark, canopy } = BUILDERS[form]();
  bark.computeBoundingBox();
  canopy.computeBoundingBox();
  const baseHeightM = Math.max(bark.boundingBox!.max.y, canopy.boundingBox!.max.y);
  return { bark, canopy, baseHeightM, baseWidthM: radialWidthM([canopy]) };
}

const hulls = new Map<TreeForm, { hull: THREE.BufferGeometry; base: { heightM: number; widthM: number } }>();

/**
 * A form's canopy as a convex hull, normalised to a tree of height 1, in this
 * layer's Y-up frame: the shape the sunlight layer casts shadows with. See
 * *The canopy hull* in this layer's spec, and *Trees* in the sunlight spec.
 * Cached; do not dispose.
 *
 * Convex because the light pass counts a closed convex surface exactly once
 * per ray; the canopy itself is overlapping blobs and stacked cones, which it
 * would count two or more times. Measured from the canopy, for the same reason
 * `baseHeightM` is: a declared shape would drift from the one that is drawn.
 */
export function canopyHullOf(form: TreeForm): THREE.BufferGeometry {
  return hullEntry(form).hull;
}

/**
 * The size `canopyHullOf(form)` is modelled at, for `crownScale`: height 1, by
 * the hull's normalisation, and the hull's own measured width — which is the
 * form's `baseWidthM / baseHeightM`. With it, a shadow caster scales its hull by
 * the same rule the meshes scale the drawn tree by.
 */
export function canopyHullBaseOf(form: TreeForm): { heightM: number; widthM: number } {
  return hullEntry(form).base;
}

function hullEntry(form: TreeForm) {
  const cached = hulls.get(form);
  if (cached) return cached;
  const { bark, canopy, baseHeightM } = buildForm(form);
  const pos = canopy.getAttribute("position");
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    points.push(new THREE.Vector3().fromBufferAttribute(pos, i).divideScalar(baseHeightM));
  }
  const hull = new ConvexGeometry(points);
  // Only the shape is wanted: the light pass reads positions, nothing else.
  hull.deleteAttribute("normal");
  hull.computeBoundingBox();
  bark.dispose();
  canopy.dispose();
  const entry = { hull, base: { heightM: 1, widthM: radialWidthM([hull]) } };
  hulls.set(form, entry);
  return entry;
}

/**
 * The two materials every form's meshes share.
 *
 * Shared, not per-form, and that is load-bearing: `setOpacity` iterates
 * materials, so sharing keeps GeoLibre's paint bridge iterating two of them
 * however many forms exist. A form that wants its own colour needs vertex
 * colours, not its own material.
 *
 * `premultipliedAlpha` matters: MapLibre sets `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`
 * and expects premultiplied colours, so three.js has to emit them or the trees
 * wash out at partial opacity.
 */
export function buildMaterials(): [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] {
  return [
    new THREE.MeshStandardMaterial({
      color: 0x4a3b2f,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
      premultipliedAlpha: true,
    }),
    new THREE.MeshStandardMaterial({
      color: 0x5f8f5a,
      roughness: 0.85,
      metalness: 0,
      flatShading: true,
      premultipliedAlpha: true,
    }),
  ];
}
