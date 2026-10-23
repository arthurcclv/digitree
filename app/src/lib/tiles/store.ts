import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { tileKey, type TileId } from "./grid";

/**
 * Tiles fetched by a layer itself rather than read from MapLibre. See *Data*
 * in the sunlight spec: MapLibre loads only the viewport, and the shade at the
 * viewport's sunward edge is cast from outside it.
 *
 * The store knows no dataset. Each source it holds is handed in, as where its
 * tiles are and how they decode; see `specs/spec.md`. Decoded features are
 * kept in lng/lat; placing them in a frame is the layer's job and changes
 * every time the view moves.
 */

/** A building footprint with its height. Schema-free: see the buildings layer's schema. */
export interface BuildingFeature {
  heightM: number;
  /** One entry per polygon: its rings, outer first, each closed as in GeoJSON. */
  polygons: [number, number][][][];
}

/** A decoded feature's geometry, in lng/lat, as the decoder gives it. */
export type TileGeometry = ReturnType<VectorTileFeature["toGeoJSON"]>["geometry"];

/** Where a source's tiles are: a URL template, or a TileJSON naming one. */
export type TileLocation = { tiles: string } | { tileJson: string };

/** One source a store holds: where its tiles are, and how they decode. */
export interface TileSource<T> {
  location: TileLocation;
  decode(buf: ArrayBuffer, tile: TileId): T[];
  /** False for a tile known to be empty without asking. Default: always true. */
  mayHold?(tile: TileId): boolean;
}

/**
 * The features of one MVT layer in a tile, each read by `read`, which drops a
 * feature by returning `null`. The geometry is decoded only when asked for.
 */
export function decodeMvt<T>(
  buf: ArrayBuffer,
  t: TileId,
  sourceLayer: string,
  read: (properties: Record<string, unknown>, geometry: () => TileGeometry) => T | null,
): T[] {
  const layer = new VectorTile(new PbfReader(buf)).layers[sourceLayer];
  if (!layer) return [];
  const out: T[] = [];
  for (let i = 0; i < layer.length; i++) {
    const vf = layer.feature(i);
    const f = read(vf.properties, () => vf.toGeoJSON(t.x, t.y, t.z).geometry);
    if (f !== null) out.push(f);
  }
  return out;
}

/** Decoded tiles kept per source for the session. */
export const TILE_CACHE_SIZE = 256;

/** Requests in flight at once, across a store's sources. */
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

export interface TileCounts {
  covered: number;
  pending: number;
  failed: number;
}

type FeatureOf<S> = S extends TileSource<infer T> ? T : never;

interface Held {
  name: string;
  source: TileSource<unknown>;
  cache: Lru<Entry<unknown>>;
  /** A resolved TileJSON template, shared by every tile until it fails. */
  template: Promise<string | null> | null;
}

/**
 * Fetches, decodes and caches its sources on one tile grid. `want()` is the
 * only way in: it names the tiles the layer needs now, and anything not yet
 * held is queued. `onChange` fires when a tile lands or fails. `dispose()`
 * aborts what is in flight and ends the store.
 *
 * A store holds exactly the sources it is given; a tile counts as covered once
 * every one of them has it.
 */
export class TileStore<S extends Record<string, TileSource<unknown>>> {
  private readonly held: Held[];
  private readonly byName = new Map<string, Held>();
  private queue: { id: string; tile: TileId; start: () => void }[] = [];
  private inFlight = 0;
  private wanted: TileId[] = [];
  /** Aborts every fetch in flight when the store is disposed. */
  private readonly abort = new AbortController();

  onChange: (() => void) | null = null;

  constructor(
    sources: S,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {
    this.held = Object.entries(sources).map(([name, source]) => ({
      name,
      source,
      cache: new Lru<Entry<unknown>>(TILE_CACHE_SIZE),
      template: null,
    }));
    for (const h of this.held) this.byName.set(h.name, h);
  }

  /** Replace the wanted set; queue whatever is missing. Failed tiles are retried. */
  want(tiles: TileId[]): void {
    if (this.abort.signal.aborted) return;
    this.wanted = tiles;
    const queued = new Set(this.queue.map((q) => q.id));
    for (const tile of tiles) {
      const key = tileKey(tile);
      for (const src of this.held) {
        const entry = src.cache.get(key);
        if (entry?.state === "ready" || entry?.state === "pending") continue;
        const id = `${src.name}:${key}`;
        if (queued.has(id)) continue;
        if (src.source.mayHold && !src.source.mayHold(tile)) {
          src.cache.set(key, { state: "ready", features: [] });
          continue;
        }
        this.queue.push({ id, tile, start: () => void this.load(src, tile) });
      }
    }
    // Drop queued work that is no longer wanted.
    const wantedKeys = new Set(tiles.map(tileKey));
    this.queue = this.queue.filter((q) => wantedKeys.has(tileKey(q.tile)));
    this.pump();
  }

  /** The wanted tiles every held source has ready. */
  covered(): TileId[] {
    return this.wanted.filter((t) => this.states(t).every((s) => s === "ready"));
  }

  counts(): TileCounts {
    let covered = 0;
    let pending = 0;
    let failed = 0;
    for (const t of this.wanted) {
      const states = this.states(t);
      if (states.includes("failed")) failed++;
      else if (states.every((s) => s === "ready")) covered++;
      else pending++;
    }
    return { covered, pending, failed };
  }

  /** One source's features in a tile, or none while it is not ready. */
  featuresOf<K extends keyof S & string>(name: K, t: TileId): FeatureOf<S[K]>[] {
    const e = this.byName.get(name)?.cache.get(tileKey(t));
    return (e?.state === "ready" ? e.features : []) as FeatureOf<S[K]>[];
  }

  /**
   * Abort every fetch in flight and drop the queue. The store is done: `want`
   * does nothing after it, and a fetch that settles anyway fires nothing.
   */
  dispose(): void {
    this.onChange = null;
    this.queue = [];
    this.wanted = [];
    this.abort.abort();
  }

  /** One tile's state in each held source. */
  private states(t: TileId): (Entry<unknown>["state"] | undefined)[] {
    const k = tileKey(t);
    return this.held.map((src) => src.cache.get(k)?.state);
  }

  private templateOf(src: Held): Promise<string | null> {
    const loc = src.source.location;
    if ("tiles" in loc) return Promise.resolve(loc.tiles);
    src.template ??= this.fetchFn(loc.tileJson, { signal: this.abort.signal })
      .then((r) => (r.ok ? r.json() : null))
      // `json()` is untyped; the cast only restates the typeof check before it.
      .then((j) => (j && Array.isArray(j.tiles) && typeof j.tiles[0] === "string" ? (j.tiles[0] as string) : null))
      .catch(() => null)
      .then((t) => {
        // A failed TileJSON is retried on the next request, not cached as a failure.
        if (!t) src.template = null;
        return t;
      });
    return src.template;
  }

  private pump(): void {
    while (this.inFlight < FETCH_CONCURRENCY && this.queue.length) this.queue.shift()!.start();
  }

  private async load(src: Held, tile: TileId): Promise<void> {
    const key = tileKey(tile);
    src.cache.set(key, { state: "pending" });
    this.inFlight++;
    try {
      const template = await this.templateOf(src);
      if (!template) throw new Error("no tile template");
      const url = template
        .replace("{z}", String(tile.z))
        .replace("{x}", String(tile.x))
        .replace("{y}", String(tile.y));
      const res = await this.fetchFn(url, { signal: this.abort.signal });
      // Martin answers an empty tile with 204.
      let features: unknown[] = [];
      if (res.status !== 204) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        features = src.source.decode(await res.arrayBuffer(), tile);
      }
      // A fetch that ignored the abort still lands in a store that is done.
      if (!this.abort.signal.aborted) src.cache.set(key, { state: "ready", features });
    } catch {
      // A failure is a state, not an error: the tile stays uncovered and is counted.
      if (!this.abort.signal.aborted) src.cache.set(key, { state: "failed" });
    } finally {
      this.inFlight--;
      // `onChange` is null and the queue empty once disposed.
      this.onChange?.();
      this.pump();
    }
  }
}
