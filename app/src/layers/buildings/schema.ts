/**
 * Where building footprints are (the `BuildingSource` descriptor, handed in by
 * the host) and how a building is read (the OpenMapTiles `building` schema).
 * Both forms of the rule live here, side by side: the MapLibre expressions the
 * extrusion record uses, and the JS the self-fetching layers decode with. See
 * *Source* in `specs/spec.md` and `src/lib/tiles/specs/spec.md`.
 */
import { decodeMvt, type BuildingFeature, type TileSource } from "../../lib/tiles";

/** Where building footprints are served. Plain data; the host owns the values. */
export interface BuildingSource {
  /** A TileJSON URL; its first `tiles` template is used. */
  tileJson: string;
  /** The MVT layer inside each tile. */
  sourceLayer: string;
  attribution: string;
  /** The extrusion record's display name. */
  name: string;
  /** Its `metadata.sourceKind`: a free label, none GeoLibre acts on. */
  sourceKind: string;
}

/** The feature's height in real metres, as MapLibre reads it. */
export const BUILDING_HEIGHT_PROPERTY = "render_height";
export const BUILDING_HEIGHT_EXPRESSION = ["to-number", ["get", BUILDING_HEIGHT_PROPERTY], 0];

/** Drops what OSM marks unsuitable for 3D. */
export const BUILDING_SHOWN_FILTER = ["!=", ["get", "hide_3d"], true];

/** Drops anything shorter than `m` real metres. */
export function minHeightFilter(m: number): unknown[] {
  return [">=", BUILDING_HEIGHT_EXPRESSION, m];
}

/** The JS form of `minHeightFilter`, for a height already decoded. */
export function meetsMinHeight(heightM: number, m: number): boolean {
  return heightM >= m;
}

/**
 * The JS form: a building's height, or `null` when it has no volume — `hide_3d`,
 * or no positive height. Every building this keeps, the extrusion's filter
 * keeps too; the filter also keeps a zero-height footprint, drawn flat, which
 * has nothing to shade or occlude.
 */
export function buildingHeight(props: Record<string, unknown>): number | null {
  if (props.hide_3d === true) return null;
  const h = Number(props[BUILDING_HEIGHT_PROPERTY]);
  return h > 0 ? h : null;
}

/** A building source as a `TileStore` source, decoded with `buildingHeight`. */
export function buildingTiles(source: BuildingSource): TileSource<BuildingFeature> {
  return {
    location: { tileJson: source.tileJson },
    decode: (buf, t) =>
      decodeMvt(buf, t, source.sourceLayer, (p, geometry) => {
        // The height first, so a dropped building is never decoded.
        const heightM = buildingHeight(p);
        if (heightM === null) return null;
        const g = geometry();
        const polygons =
          g.type === "Polygon"
            ? [g.coordinates as [number, number][][]]
            : g.type === "MultiPolygon"
              ? (g.coordinates as [number, number][][][])
              : [];
        return polygons.length ? { heightM, polygons } : null;
      }),
  };
}
