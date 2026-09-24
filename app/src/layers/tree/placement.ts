/**
 * Per-tree variation. The module behind *Rotation is hashed, not random* in
 * `specs/spec.md`.
 *
 * Like `forms.ts`, this is deliberately free of three.js: it is arithmetic over
 * a string, which is what makes it testable without a GL context. And like
 * `forms.ts`, what it returns is a property of the *tree* rather than of the
 * geometry — so a tree keeps its orientation when the mesh source changes under
 * it.
 */

/** FNV-1a offset basis and prime, 32-bit. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** murmur3's `fmix32` constants. See `avalanche` below for why they are here. */
const MIX_A = 0x85ebca6b;
const MIX_B = 0xc2b2ae35;

const TAU = Math.PI * 2;

/**
 * murmur3's finalizer, and **not** an optional polish step.
 *
 * FNV-1a alone is a poor fit for this data. The inventory's ids are sequential
 * — `BT0015000001`, `BT0015000002`, … — and trees along one street carry
 * consecutive ones. Two ids differing by 1 in the last digit leave FNV-1a
 * differing by exactly one multiple of the prime, which is 0.39% of the
 * circle: measured on the real ids, consecutive trees came out **1.4° apart**
 * (106.8°, 105.4°, 104.0°, …). A boulevard would have drawn as one mesh
 * stamped forty times at forty spacings, all facing the same way — precisely
 * the artefact the rotation exists to remove.
 *
 * The distribution was never the problem and is not what this fixes: plain
 * FNV-1a already spreads 20,000 ids evenly over the circle. The defect is
 * *local* — neighbouring ids correlate — which is why `placement.test.ts`
 * measures the gap between consecutive ids and not just the histogram.
 */
function avalanche(hash: number): number {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, MIX_A);
  h ^= h >>> 13;
  h = Math.imul(h, MIX_B);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The angle, in radians, that this tree is yawed by — the same one on every
 * reload, under either mesh source, at any zoom, from any viewport.
 *
 * Hashed from `tree_id` rather than drawn from `Math.random`, and the spec
 * forbids the layer from calling `Math.random` at all. A random angle would not
 * merely differ between launches: the mesh refresh runs on `idle`, so every tree
 * in view would visibly spin as you panned.
 *
 * `tree_id` is the seed because it is already the layer's answer to *which tree
 * is this* — it is what instances are deduped by, and it is published as a
 * property for that reason. Seeding from the coordinate instead would tie a
 * tree's orientation to its position, so correcting a surveyed coordinate by a
 * metre would spin the tree.
 *
 * **The arithmetic below is the contract, not an implementation detail.**
 * Changing the constants, the traversal or the finalizer is not a refactor — it
 * reshuffles every tree in Taipei. That is why it is written out here rather
 * than taken from a hashing dependency that is free to improve itself.
 */
export function rotationOf(treeId: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < treeId.length; i += 1) {
    // UTF-16 code units: the ids are ASCII today, but a custom drop-in's need
    // not be, and a hash that walks code units cannot be surprised by one.
    hash ^= treeId.charCodeAt(i);
    // Math.imul, because `*` on two 32-bit values leaves float precision behind
    // and the low bits — the ones that matter here — would be wrong.
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Unsigned before the divide: Math.imul is signed, and a negative angle here
  // would still be deterministic but would cover only half the circle.
  return (avalanche(hash >>> 0) / 0x1_0000_0000) * TAU;
}
