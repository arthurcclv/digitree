import {
  decodeMvt,
  lngLatToMercator,
  type MercatorPoint,
  type TileGeometry,
  type TileSource,
} from "../../lib/tiles";

/**
 * Where the captures are: the host's descriptor (`src/sources.ts`). The layer
 * knows no endpoint. See *`SplatSource`* in `specs/spec.md`.
 */
export interface SplatSource {
  /** Martin's tile template for the `splats` table; may be relative. */
  tiles: string;
  /** The MVT layer inside each tile. */
  sourceLayer: string;
  /**
   * Where the cleaned captures are; a capture's file is this plus its `file`.
   * Part of infra's published interface; the layer never fetches it.
   */
  files: string;
  /** Where the LoD trees the layer draws are; see `lodUrlOf`. */
  lodFiles: string;
  /** Rendered by the host whenever a capture is drawn. */
  attribution: string;
  name: string;
}

/** One capture, as infra placed it from its control points. */
export interface Splat {
  id: string;
  file: string;
  /** Where the capture's local (0, 0) lands. */
  lngLat: [number, number];
  /** The local z = 0 plane, in metres above the map's ground. */
  altitudeM: number;
  /** Of the capture's local +y, degrees clockwise from north. */
  headingDeg: number;
  /** Capture units to metres. */
  scale: number;
  bytes: number;
}

/** The `splats` table's published property names (`infra/martin.yaml`). */
export const SPLAT_PROPS = {
  id: "splat_id",
  file: "file",
  bytes: "bytes",
  altitudeM: "altitude_m",
  headingDeg: "heading_deg",
  scale: "scale",
} as const;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The one reading of a capture. `null`, never a guess, for a feature with a
 * missing or invalid property: infra validates on load, so this is a schema
 * drift, and drawing a capture in the wrong place is worse than not at all.
 */
export function splatOf(props: Record<string, unknown>, geometry: () => TileGeometry): Splat | null {
  const id = props[SPLAT_PROPS.id];
  const file = props[SPLAT_PROPS.file];
  const bytes = props[SPLAT_PROPS.bytes];
  const altitudeM = props[SPLAT_PROPS.altitudeM];
  const headingDeg = props[SPLAT_PROPS.headingDeg];
  const scale = props[SPLAT_PROPS.scale];
  if (typeof id !== "string" || id === "") return null;
  if (typeof file !== "string" || file === "" || file.includes("/")) return null;
  if (!finite(bytes) || !finite(altitudeM) || !finite(headingDeg) || !finite(scale) || scale <= 0) return null;
  const g = geometry();
  if (g.type !== "Point") return null;
  const [lng, lat] = g.coordinates;
  if (!finite(lng) || !finite(lat)) return null;
  return { id, file, lngLat: [lng, lat], altitudeM, headingDeg, scale, bytes };
}

/**
 * The capture's paged LoD tree, which is what the layer draws: the header
 * `<stem>-lod.rad` under the descriptor's `lodFiles`, where `<stem>` is `file`
 * less its extension. Its chunk files sit beside it, named inside it. infra's loader requires that file under the same name rule
 * (`infra/sql/04_splats.sql`, *its LoD*), so the published interface carries
 * no second file name.
 */
export function lodUrlOf(source: SplatSource, splat: Pick<Splat, "file">): string {
  return source.lodFiles + encodeURIComponent(`${splat.file.replace(/\.[^.]*$/, "")}-lod.rad`);
}

/** The `TileStore` adapter, as `treeTiles` is for the trees. */
export function splatTiles(source: SplatSource): TileSource<Splat> {
  return {
    location: { tiles: source.tiles },
    decode: (buf, t) => decodeMvt(buf, t, source.sourceLayer, splatOf),
  };
}

/** From a Mercator point to a capture's origin, in Mercator units. */
export function mercatorDistance(splat: Pick<Splat, "lngLat">, from: MercatorPoint): number {
  const p = lngLatToMercator(splat.lngLat[0], splat.lngLat[1]);
  return Math.hypot(p.x - from.x, p.y - from.y);
}

/**
 * Every capture in a set of tiles, once each — a point in a tile's buffer
 * arrives once per covering tile — nearest the view's centre first.
 */
export function splatsIn(perTile: Splat[][], centre: MercatorPoint): Splat[] {
  const byId = new Map<string, { splat: Splat; dist: number }>();
  for (const list of perTile) {
    for (const s of list) {
      if (byId.has(s.id)) continue;
      byId.set(s.id, { splat: s, dist: mercatorDistance(s, centre) });
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.dist - b.dist || a.splat.id.localeCompare(b.splat.id))
    .map((e) => e.splat);
}
