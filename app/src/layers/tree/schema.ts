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
  district: "district",
  place: "place",
  placeNote: "place_note",
  diameter: "diameter_cm",
  surveyDate: "survey_date",
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
  /** The rest is for display only (`tree-info.md`); no geometry reads it. */
  district: string | null;
  /** The road or park name. */
  place: string | null;
  /** Which side of the road; street rows only. */
  placeNote: string | null;
  /** The surveyed trunk diameter in cm, or `null` where it is missing or not positive. */
  diameterCm: number | null;
  /** `YYYY-MM-DD`, as the tiles carry it. */
  surveyDate: string | null;
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
  return {
    id,
    lng,
    lat,
    heightM: positive(p[TREE_PROPS.height]),
    canopyWidthM: positive(p[TREE_PROPS.canopyWidth]),
    kind: p[TREE_PROPS.kind],
    species: p[TREE_PROPS.species],
    district: text(p[TREE_PROPS.district]),
    place: text(p[TREE_PROPS.place]),
    placeNote: text(p[TREE_PROPS.placeNote]),
    diameterCm: positive(p[TREE_PROPS.diameter]),
    surveyDate: text(p[TREE_PROPS.surveyDate]),
  };
}

/** A measurement: a positive number, or `null` — never zero. */
const positive = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);

/** A non-empty string, or `null`. */
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A tree source as a `TileStore` source: decoded with `treeOf`, bounded by its extent. */
export function treeTiles(source: TreeSource): TileSource<TreeFeature> {
  return {
    location: { tiles: source.tiles },
    decode: (buf, t) => decodeMvt(buf, t, source.sourceLayer, (p, geometry) => treeOf(p, geometry())),
    mayHold: (t) => tileIntersects(t, source.bounds),
  };
}
