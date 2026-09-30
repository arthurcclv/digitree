import * as THREE from "three";
import { canopyHullOf, formOf, rotationOf, TREE_FORMS, type TreeFeature, type TreeForm } from "../tree";
import { placeTile, type TileId, type TilePrisms } from "../../lib/tiles";
import { toLocal, type Domain } from "./frame";
import { tileKey, tileSquareLocal } from "./tileGrid";
import { alphaOf, tauOf } from "./transmittance";

/**
 * One set of placed occluders and the three scenes a light pass draws: tree
 * crowns, building prisms, footprints and coverage squares, in one domain's
 * frame. The display keeps one; each export pass builds its own and disposes
 * it (*The export pass*). See *Trees* and *Buildings* in `specs/spec.md`.
 */

/** More than the whole inventory, so in practice nothing is dropped. */
export const SUNLIGHT_MAX_TREES = 200_000;

export interface OccluderMaterials {
  crown: THREE.ShaderMaterial;
  prism: THREE.ShaderMaterial;
  foot: THREE.ShaderMaterial;
  cover: THREE.ShaderMaterial;
}

type PlacedTree = { id: string; x: number; y: number; h: number; species: unknown; form: TreeForm };

/** One form's crowns: its hull, instanced, near trees first. */
interface CrownSet {
  mesh: THREE.InstancedMesh;
  /** This layer's own copy of the hull — it carries `aTau`, the tree layer's must not. */
  geometry: THREE.BufferGeometry;
  matrix: THREE.InstancedBufferAttribute;
  tau: THREE.InstancedBufferAttribute;
  capacity: number;
  /** Instances drawn by the near pass: the prefix that can shade the near grid. */
  nearCount: number;
  count: number;
}

/** The tree layer's Y-up frame onto this layer's east-north-up one: (x, y, z) → (x, −z, y). */
const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/**
 * A tree's hull instance: scaled by its height, yawed as the tree layer yaws
 * it, stood up into this frame, moved to its trunk. The tree layer's yaw about
 * its +Y is the same angle about +Z here. See *Trees*.
 */
export function crownMatrix(x: number, y: number, h: number, yaw: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out
    .makeRotationZ(yaw)
    .multiply(Y_UP_TO_Z_UP)
    .multiply(new THREE.Matrix4().makeScale(h, h, h))
    .setPosition(x, y, 0);
}

/** Replace a geometry's positions; a non-indexed triangle soup. */
function setPositions(geometry: THREE.BufferGeometry, positions: number[] | Float32Array): void {
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setDrawRange(0, positions.length / 3);
}

export interface PlaceInput {
  /** The tiles every source has, whose occluders are placed. */
  covered: readonly TileId[];
  treesOf(tile: TileId): readonly TreeFeature[];
  prismsOf(tile: TileId): TilePrisms;
  domain: Domain;
  fallbackHeightM: number;
  /** Trees within this of the centre, on both axes, are the near pass's prefix. */
  nearReachM: number;
}

export class Occluders {
  readonly lightScene = new THREE.Scene();
  readonly footScene = new THREE.Scene();
  readonly coverScene = new THREE.Scene();
  private readonly prisms = new THREE.Mesh(new THREE.BufferGeometry());
  private readonly floors = new THREE.Mesh(new THREE.BufferGeometry());
  private readonly squares = new THREE.Mesh(new THREE.BufferGeometry());
  /** One instanced hull per form. Allocated on first use. */
  private readonly crowns = new Map<TreeForm, CrownSet>();
  /** Occluders have been placed at least once, so a pass has something to draw. */
  placedOnce = false;

  constructor(private readonly materials: OccluderMaterials) {
    this.prisms.material = materials.prism;
    this.floors.material = materials.foot;
    this.squares.material = materials.cover;
    for (const m of [this.prisms, this.floors, this.squares]) m.frustumCulled = false;
    this.lightScene.add(this.prisms);
    this.footScene.add(this.floors);
    this.coverScene.add(this.squares);
  }

  /** Gather the covered tiles' occluders into the domain's frame. */
  place(input: PlaceInput): { trees: number; buildings: number } {
    const { domain } = input;
    const trees: PlacedTree[] = [];
    const seen = new Set<string>();
    for (const tile of input.covered) {
      for (const t of input.treesOf(tile)) {
        // The tile buffer repeats a tree in each tile it overlaps.
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const [x, y] = toLocal(domain, t.lng, t.lat);
        trees.push({ id: t.id, x, y, h: t.heightM ?? input.fallbackHeightM, species: t.species, form: formOf(t.species) });
      }
    }
    if (trees.length > SUNLIGHT_MAX_TREES) {
      trees.sort((a, b) => b.h - a.h);
      trees.length = SUNLIGHT_MAX_TREES;
    }
    // Trees that can shade the near grid first, so the near pass draws a prefix.
    const r = input.nearReachM;
    this.placeCrowns(trees, (t) => Math.abs(t.x) < r && Math.abs(t.y) < r);

    let buildings = 0;
    const parts = input.covered.map((tile) => {
      const p = input.prismsOf(tile);
      buildings += p.count;
      return { tile, p };
    });
    const prism = new Float32Array(parts.reduce((n, { p }) => n + p.prism.length, 0));
    const floor = new Float32Array(parts.reduce((n, { p }) => n + p.floor.length, 0));
    let pi = 0;
    let fi = 0;
    for (const { tile, p } of parts) {
      pi = placeTile(domain, tile, p.prism, prism, pi);
      fi = placeTile(domain, tile, p.floor, floor, fi);
    }
    setPositions(this.prisms.geometry, prism);
    setPositions(this.floors.geometry, floor);

    // Coverage: one square per covered tile.
    const sq: number[] = [];
    for (const tile of input.covered) {
      const [w, s, e, n] = tileSquareLocal(domain, tile);
      sq.push(w, s, 0, e, s, 0, e, n, 0, w, s, 0, e, n, 0, w, n, 0);
    }
    setPositions(this.squares.geometry, sq);
    return { trees: trees.length, buildings };
  }

  /** The near pass draws each form's near prefix; the far pass draws them all. */
  drawCounts(near: boolean): void {
    for (const set of this.crowns.values()) set.mesh.count = near ? set.nearCount : set.count;
  }

  /** Write every tree into its form's hull instances, near trees first. */
  private placeCrowns(trees: PlacedTree[], isNear: (t: PlacedTree) => boolean): void {
    const byForm = new Map<TreeForm, { near: PlacedTree[]; far: PlacedTree[] }>();
    for (const t of trees) {
      let g = byForm.get(t.form);
      if (!g) byForm.set(t.form, (g = { near: [], far: [] }));
      (isNear(t) ? g.near : g.far).push(t);
    }
    const m = new THREE.Matrix4();
    for (const form of TREE_FORMS) {
      const g = byForm.get(form);
      const total = g ? g.near.length + g.far.length : 0;
      const set = total ? this.crownSet(form, total) : this.crowns.get(form);
      if (!set) continue;
      set.nearCount = g?.near.length ?? 0;
      set.count = total;
      if (!g) continue;
      const matrices = set.matrix.array;
      const tau = set.tau.array;
      [...g.near, ...g.far].forEach((t, i) => {
        crownMatrix(t.x, t.y, t.h, rotationOf(t.id), m).toArray(matrices, i * 16);
        tau[i] = tauOf(alphaOf(t.species));
      });
      set.matrix.needsUpdate = true;
      set.tau.needsUpdate = true;
    }
    this.placedOnce = true;
  }

  /** A form's instanced hull, grown by doubling to hold `needed` trees. */
  private crownSet(form: TreeForm, needed: number): CrownSet {
    const existing = this.crowns.get(form);
    if (existing && existing.capacity >= needed) return existing;
    let capacity = Math.max(1024, existing?.capacity ?? 0);
    while (capacity < needed) capacity *= 2;
    if (existing) {
      this.lightScene.remove(existing.mesh);
      existing.mesh.dispose();
    }
    const geometry = existing?.geometry ?? canopyHullOf(form).clone();
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    const tau = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geometry.setAttribute("aTau", tau);
    const mesh = new THREE.InstancedMesh(geometry, this.materials.crown, capacity);
    mesh.instanceMatrix = matrix;
    mesh.frustumCulled = false;
    this.lightScene.add(mesh);
    const set: CrownSet = { mesh, geometry, matrix, tau, capacity, nearCount: 0, count: 0 };
    this.crowns.set(form, set);
    return set;
  }

  /** The meshes and this set's hull copies; the shared materials are the layer's. */
  dispose(): void {
    for (const set of this.crowns.values()) {
      set.mesh.dispose();
      // Our own copy; the tree layer's cached hull is left alone.
      set.geometry.dispose();
    }
    this.crowns.clear();
    for (const m of [this.prisms, this.floors, this.squares]) m.geometry.dispose();
  }
}

/** The covered set as keys, for `classifyByTiles`. */
export const coveredKeys = (tiles: readonly TileId[]): Set<string> => new Set(tiles.map(tileKey));
