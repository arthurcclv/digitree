import * as THREE from "three";
import type { MercatorPoint, TileId } from "./grid";
import type { BuildingFeature } from "./store";

/**
 * Building prisms from decoded tiles, shared by the sunlight and ambient-
 * occlusion layers. A tile is triangulated once, in tile units; placing it in
 * a layer's frame is then a scale and an offset per vertex.
 */

type Vec2 = [number, number];

/** Tile units across a tile: x east, y south as in Mercator. */
export const TILE_UNITS = 4096;

/**
 * A local metre frame: x east, y north, z up, origin at `origin`. The sunlight
 * layer's `Domain` is one.
 */
export interface LocalFrame {
  origin: MercatorPoint;
  /** Mercator units per metre, fixed at the origin's latitude. */
  metre: number;
}

/**
 * One tile's buildings, triangulated in tile units with z in metres.
 * `features` gives each building's run of `prism` (floats, not vertices) and
 * its true height, so a layer can drop or scale buildings without
 * triangulating again.
 */
export interface TilePrisms {
  prism: Float32Array;
  floor: Float32Array;
  /** Buildings that produced at least one polygon. */
  count: number;
  features: { start: number; end: number; heightM: number }[];
}

/** A tile's buildings, triangulated in tile units. */
export function triangulateTile(tile: TileId, buildings: BuildingFeature[]): TilePrisms {
  const n = 2 ** tile.z;
  const toTile = (lng: number, lat: number): Vec2 => {
    const mx = (180 + lng) / 360;
    const my = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
    return [(mx * n - tile.x) * TILE_UNITS, (my * n - tile.y) * TILE_UNITS];
  };
  const prism: number[] = [];
  const floor: number[] = [];
  const features: TilePrisms["features"] = [];
  for (const b of buildings) {
    const start = prism.length;
    for (const rings of b.polygons) {
      const local = rings.map((ring) => {
        const pts = ring.map(([lng, lat]) => toTile(lng, lat));
        // GeoJSON rings repeat their first point.
        if (pts.length > 1) pts.pop();
        return pts;
      });
      if (!local[0] || local[0].length < 3) continue;
      addPrism(local, b.heightM, prism, floor);
    }
    if (prism.length > start) features.push({ start, end: prism.length, heightM: b.heightM });
  }
  return { prism: new Float32Array(prism), floor: new Float32Array(floor), count: features.length, features };
}

/**
 * Copy a run of a tile's vertices from tile units into a frame's local metres
 * at `out[at…]`, scaling z by `zScale`; returns the next free index. Tile y
 * runs south, local y north.
 */
export function placeTile(
  f: LocalFrame,
  tile: TileId,
  src: Float32Array,
  out: Float32Array,
  at: number,
  zScale = 1,
  start = 0,
  end = src.length,
): number {
  const n = 2 ** tile.z;
  const scale = 1 / (n * TILE_UNITS * f.metre);
  const ox = (tile.x / n - f.origin.x) / f.metre;
  const oy = -(tile.y / n - f.origin.y) / f.metre;
  for (let i = start; i < end; i += 3) {
    const o = at + i - start;
    out[o] = ox + src[i] * scale;
    out[o + 1] = oy - src[i + 1] * scale;
    out[o + 2] = src[i + 2] * zScale;
  }
  return at + end - start;
}

/**
 * One footprint (outer ring, then holes) as a closed prism into `prism`, and
 * its floor alone into `floor`.
 */
export function addPrism(rings: Vec2[][], h: number, prism: number[], floor: number[]): void {
  const [outer, ...holes] = rings;
  const contour = outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holeVecs = holes.filter((r) => r.length >= 3).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holeVecs);
  // Indices run over the outer ring then each hole, as triangulated.
  const all = [...contour, ...holeVecs.flat()];
  for (const [a, b, c] of tris) {
    for (const i of [a, b, c]) floor.push(all[i].x, all[i].y, 0);
    for (const i of [a, b, c]) prism.push(all[i].x, all[i].y, 0);
    for (const i of [a, b, c]) prism.push(all[i].x, all[i].y, h);
  }
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      prism.push(ax, ay, 0, bx, by, 0, bx, by, h);
      prism.push(ax, ay, 0, bx, by, h, ax, ay, h);
    }
  }
}
