import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { OSM_TILEJSON } from "../basemaps";
import { TREES_BOUNDS, TREES_SOURCE_LAYER, TREES_TILES } from "../tree";
import { tileIntersects, tileKey, type TileId } from "./tileGrid";

/**
 * The layer's own tiles. See *Data* in `specs/spec.md`: this layer does not
 * read MapLibre's parsed tiles, because MapLibre loads only the viewport and
 * the shade at the viewport's sunward edge is cast from outside it.
 *
 * Decoded features are kept in lng/lat; placing them in a domain's frame is
 * the layer's job and changes every time the view moves.
 */

export interface TreeFeature {
  id: string;
  lng: number;
  lat: number;
  heightM: number | null;
  species: unknown;
}

export interface BuildingFeature {
  heightM: number;
  /** One entry per polygon: its rings, outer first, each closed as in GeoJSON. */
  polygons: [number, number][][][];
}

/** Decoded tiles kept per source for the session. */
export const TILE_CACHE_SIZE = 256;

/** Requests in flight at once, across both sources. */
export const FETCH_CONCURRENCY = 6;

type Entry<T> = { state: "ready"; features: T[] } | { state: "pending" } | { state: "failed" };

/** Insertion-ordered LRU: a read moves the entry to the back. */
class Lru<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly limit: number) {}
  get(key: string): T | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: T): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

const BUILDINGS_SOURCE_LAYER = "building";

function decodeTrees(buf: ArrayBuffer, t: TileId): TreeFeature[] {
  const layer = new VectorTile(new PbfReader(buf)).layers[TREES_SOURCE_LAYER];
  if (!layer) return [];
  const out: TreeFeature[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i).toGeoJSON(t.x, t.y, t.z);
    if (f.geometry.type !== "Point") continue;
    const id = f.properties?.tree_id;
    if (typeof id !== "string") continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const h = f.properties?.height_m;
    out.push({ id, lng, lat, heightM: typeof h === "number" && h > 0 ? h : null, species: f.properties?.species });
  }
  return out;
}

function decodeBuildings(buf: ArrayBuffer, t: TileId): BuildingFeature[] {
  const layer = new VectorTile(new PbfReader(buf)).layers[BUILDINGS_SOURCE_LAYER];
  if (!layer) return [];
  const out: BuildingFeature[] = [];
  for (let i = 0; i < layer.length; i++) {
    const vf = layer.feature(i);
    if (vf.properties.hide_3d === true) continue;
    const h = Number(vf.properties.render_height);
    if (!(h > 0)) continue;
    const g = vf.toGeoJSON(t.x, t.y, t.z).geometry;
    const polygons =
      g.type === "Polygon"
        ? [g.coordinates as [number, number][][]]
        : g.type === "MultiPolygon"
          ? (g.coordinates as [number, number][][][])
          : [];
    if (polygons.length) out.push({ heightM: h, polygons });
  }
  return out;
}

export interface TileCounts {
  covered: number;
  pending: number;
  failed: number;
}

/**
 * What differs between the two sources: where a tile lives, how it decodes,
 * and which tiles can hold anything at all.
 */
interface Source<T> {
  name: "trees" | "buildings";
  cache: Lru<Entry<T>>;
  /** The URL template, or `null` when it cannot be had (an unreadable TileJSON). */
  template: () => Promise<string | null>;
  decode: (buf: ArrayBuffer, t: TileId) => T[];
  /** False for a tile known to be empty without asking. */
  mayHold: (t: TileId) => boolean;
}

/**
 * Fetches, decodes and caches both sources on one tile grid. `want()` is the
 * only way in: it names the tiles the layer needs now, and anything not yet
 * held is queued. `onChange` fires when a tile lands or fails.
 */
export class TileStore {
  private readonly trees: Source<TreeFeature> = {
    name: "trees",
    cache: new Lru(TILE_CACHE_SIZE),
    template: async () => TREES_TILES,
    decode: decodeTrees,
    mayHold: (t) => tileIntersects(t, TREES_BOUNDS),
  };
  private readonly buildings: Source<BuildingFeature> = {
    name: "buildings",
    cache: new Lru(TILE_CACHE_SIZE),
    template: () => this.templateFor(),
    decode: decodeBuildings,
    mayHold: () => true,
  };
  private queue: { id: string; tile: TileId; start: () => void }[] = [];
  private inFlight = 0;
  private buildingTemplate: Promise<string | null> | null = null;
  private wanted: TileId[] = [];

  onChange: (() => void) | null = null;

  constructor(private readonly fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  /** Replace the wanted set; queue whatever is missing. Failed tiles are retried. */
  want(tiles: TileId[]): void {
    this.wanted = tiles;
    const queued = new Set(this.queue.map((q) => q.id));
    for (const tile of tiles) {
      const key = tileKey(tile);
      this.eachSource((src) => {
        const entry = src.cache.get(key);
        if (entry?.state === "ready" || entry?.state === "pending") return;
        const id = `${src.name}:${key}`;
        if (queued.has(id)) return;
        if (!src.mayHold(tile)) {
          src.cache.set(key, { state: "ready", features: [] });
          return;
        }
        this.queue.push({ id, tile, start: () => void this.load(src, tile) });
      });
    }
    // Drop queued work that is no longer wanted.
    const wantedKeys = new Set(tiles.map(tileKey));
    this.queue = this.queue.filter((q) => wantedKeys.has(tileKey(q.tile)));
    this.pump();
  }

  /** The wanted tiles whose both sources are ready. */
  covered(): TileId[] {
    return this.wanted.filter((t) => {
      const k = tileKey(t);
      return this.trees.cache.get(k)?.state === "ready" && this.buildings.cache.get(k)?.state === "ready";
    });
  }

  counts(): TileCounts {
    let covered = 0;
    let pending = 0;
    let failed = 0;
    for (const t of this.wanted) {
      const k = tileKey(t);
      const a = this.trees.cache.get(k)?.state;
      const b = this.buildings.cache.get(k)?.state;
      if (a === "failed" || b === "failed") failed++;
      else if (a === "ready" && b === "ready") covered++;
      else pending++;
    }
    return { covered, pending, failed };
  }

  treesOf(t: TileId): TreeFeature[] {
    return this.featuresOf(this.trees, t);
  }

  buildingsOf(t: TileId): BuildingFeature[] {
    return this.featuresOf(this.buildings, t);
  }

  private featuresOf<T>(src: Source<T>, t: TileId): T[] {
    const e = src.cache.get(tileKey(t));
    return e?.state === "ready" ? e.features : [];
  }

  /** Both sources, each with its own feature type — a union array would lose it. */
  private eachSource(fn: <T>(src: Source<T>) => void): void {
    fn(this.trees);
    fn(this.buildings);
  }

  private templateFor(): Promise<string | null> {
    this.buildingTemplate ??= this.fetchFn(OSM_TILEJSON)
      .then((r) => (r.ok ? r.json() : null))
      // `json()` is untyped; the cast only restates the typeof check before it.
      .then((j) => (j && Array.isArray(j.tiles) && typeof j.tiles[0] === "string" ? (j.tiles[0] as string) : null))
      .catch(() => null)
      .then((t) => {
        // A failed TileJSON is retried on the next request, not cached as a failure.
        if (!t) this.buildingTemplate = null;
        return t;
      });
    return this.buildingTemplate;
  }

  private pump(): void {
    while (this.inFlight < FETCH_CONCURRENCY && this.queue.length) this.queue.shift()!.start();
  }

  private async load<T>(src: Source<T>, tile: TileId): Promise<void> {
    const key = tileKey(tile);
    src.cache.set(key, { state: "pending" });
    this.inFlight++;
    try {
      const template = await src.template();
      if (!template) throw new Error("no tile template");
      const url = template
        .replace("{z}", String(tile.z))
        .replace("{x}", String(tile.x))
        .replace("{y}", String(tile.y));
      const res = await this.fetchFn(url);
      // Martin answers an empty tile with 204.
      if (res.status === 204) {
        src.cache.set(key, { state: "ready", features: [] });
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        src.cache.set(key, { state: "ready", features: src.decode(await res.arrayBuffer(), tile) });
      }
    } catch {
      // A failure is a state, not an error: the tile stays uncovered and is counted.
      src.cache.set(key, { state: "failed" });
    } finally {
      this.inFlight--;
      this.onChange?.();
      this.pump();
    }
  }
}
