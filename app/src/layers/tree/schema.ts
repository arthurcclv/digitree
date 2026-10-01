/**
 * Where the tree inventory is (the `TreeSource` descriptor, handed in by the
 * host) and how a tree is read from it (the schema, fixed here). See *Data
 * source* in `specs/spec.md` and `src/lib/tiles/specs/spec.md`.
 */
import { decodeMvt, tileIntersects, type TileSource } from "../../lib/tiles";

/** Where a tree inventory is served. Plain data; the host owns the values. */
export interface TreeSource {
  /** URL template with `{z}`/`{x}`/`{y}`; may be relative. */
  tiles: string;
  /** The MVT layer inside each tile. */
  sourceLayer: string;
  /** The server's zoom range; nothing is served outside it. */
  minzoom: number;
  maxzoom: number;
  /** The inventory's extent, west/south/east/north. No tile is asked for outside it. */
  bounds: [number, number, number, number];
  attribution: string;
  /** The points record's display name. */
  name: string;
  /** The points record's `metadata.sourceKind`: a free label, none GeoLibre acts on. */
  sourceKind: string;
  /**
   * The height a tree with no surveyed height is drawn and cast at: a fact
   * about the inventory (its measured median), and nothing else is ever
   * substituted.
   */
  fallbackHeightM: number;
}

/** The property names every tree source publishes. */
export const TREE_PROPS = {
  id: "tree_id",
  kind: "kind",
  species: "species",
  height: "height_m",
  canopyWidth: "canopy_width_m",
} as const;

/** One tree, read once for every layer that draws or casts it. */
export interface TreeFeature {
  id: string;
  lng: number;
  lat: number;
  /** The surveyed height, or `null` where it is missing or not positive. */
  heightM: number | null;
  /**
   * The surveyed canopy width, or `null` where it is missing or not positive.
   * Only custom drop-ins carry one today. See *Canopy width* in `specs/spec.md`.
   */
  canopyWidthM: number | null;
  kind: unknown;
  species: unknown;
}

/**
 * The one reading of a tree: a Point with a text `tree_id`, or nothing. What a
 * layer does with a missing height, a duplicate or a kind is its own policy.
 */
export function treeOf(
  properties: Record<string, unknown> | null | undefined,
  geometry: { type: string; coordinates?: unknown } | null | undefined,
): TreeFeature | null {
  const p = properties ?? {};
  const id = p[TREE_PROPS.id];
  if (typeof id !== "string" || geometry?.type !== "Point") return null;
  const [lng, lat] = geometry.coordinates as [number, number];
  const h = p[TREE_PROPS.height];
  const w = p[TREE_PROPS.canopyWidth];
  return {
    id,
    lng,
    lat,
    heightM: typeof h === "number" && h > 0 ? h : null,
    canopyWidthM: typeof w === "number" && w > 0 ? w : null,
    kind: p[TREE_PROPS.kind],
    species: p[TREE_PROPS.species],
  };
}

/** A tree source as a `TileStore` source: decoded with `treeOf`, bounded by its extent. */
export function treeTiles(source: TreeSource): TileSource<TreeFeature> {
  return {
    location: { tiles: source.tiles },
    decode: (buf, t) => decodeMvt(buf, t, source.sourceLayer, (p, geometry) => treeOf(p, geometry())),
    mayHold: (t) => tileIntersects(t, source.bounds),
  };
}
