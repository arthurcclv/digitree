import type { LocalFrame } from "../../lib/tiles";
import { SPLAT_KEEP_M, SPLAT_LOAD_CONCURRENCY, SPLAT_MAX_CAPTURES } from "./constants";
import { mercatorDistance, type Splat } from "./schema";
import type { SplatStatus } from "./state";

/** Where distances are measured from: the frame at the view's centre. */
export type View = LocalFrame;

/** A loaded capture and what the caller holds for it (its mesh). */
export interface Held<T> {
  splat: Splat;
  value: T;
}

/** The next load: a capture, and the loaded one it displaces, if any. */
export interface Next<T> {
  splat: Splat;
  evicted: Held<T> | null;
}

/**
 * Which captures are loaded, which wait, and which failed: *Which captures
 * load* in `specs/spec.md`, as plain data. It holds no mesh and does no I/O.
 * The layer offers what its tiles hold, asks `next` what to load, reports each
 * load back with `done` or `failed`, and disposes what `next` evicts and
 * `settle` unloads. `T` is whatever the layer keeps per capture.
 */
export class Residency<T> {
  /** Every capture seen since it was last unloaded or dropped, by id. */
  private readonly known = new Map<string, Splat>();
  private readonly loaded = new Map<string, Held<T>>();
  private readonly errors: SplatStatus["errors"] = [];
  /** Waiting, in the order found; `next` picks from it by distance. */
  private queue: Splat[] = [];
  /** Loading now, in the order started. */
  private readonly loading = new Set<string>();
  /**
   * Still in flight, but forgotten by `settle`: each holds a concurrency slot
   * until it finishes, and its result is then discarded. A count per id, since
   * a capture found again may load again before the old request finishes.
   */
  private readonly dropped = new Map<string, number>();

  /**
   * Queue every capture not seen yet, in the order given (nearest first, from
   * `splatsIn`), which breaks ties in `next`. Whether any was new.
   */
  offer(splats: Splat[]): boolean {
    const fresh = splats.filter((s) => !this.known.has(s.id));
    for (const s of fresh) this.known.set(s.id, s);
    this.queue.push(...fresh);
    return fresh.length > 0;
  }

  /**
   * The next capture to load, and the loaded one it evicts (already forgotten
   * here; the caller disposes it). `null` means wait: the one due stays queued.
   * See *Which captures load*, Order, Concurrency and Count.
   */
  next(view: View): Next<T> | null {
    if (this.loading.size + this.droppedCount() >= SPLAT_LOAD_CONCURRENCY) return null;
    let nearestIndex = -1;
    let nearest = Infinity;
    // Strict `<`: on a tie the earlier found wins.
    this.queue.forEach((s, i) => {
      const dist = distanceM(s, view);
      if (dist < nearest) [nearestIndex, nearest] = [i, dist];
    });
    if (nearestIndex < 0) return null;
    const splat = this.queue[nearestIndex];
    let evicted: Held<T> | null = null;
    if (this.loaded.size + this.loading.size >= SPLAT_MAX_CAPTURES) {
      let farthest: { held: Held<T>; dist: number } | null = null;
      for (const held of this.loaded.values()) {
        const dist = distanceM(held.splat, view);
        if (!farthest || dist > farthest.dist) farthest = { held, dist };
      }
      if (!farthest || farthest.dist <= nearest) return null;
      evicted = farthest.held;
      this.forget(evicted.splat.id);
    }
    this.queue.splice(nearestIndex, 1);
    this.loading.add(splat.id);
    return { splat, evicted };
  }

  /**
   * A capture `next` gave has loaded. Whether it is still wanted: `false` when
   * `settle` or `clear` forgot it meanwhile, and the caller disposes `value`.
   */
  done(splat: Splat, value: T): boolean {
    if (this.loading.delete(splat.id)) {
      this.loaded.set(splat.id, { splat, value });
      return true;
    }
    this.undrop(splat.id);
    return false;
  }

  /**
   * A capture `next` gave failed to load. It stays known, so it is not
   * retried; one forgotten meanwhile records no error.
   */
  failed(splat: Splat, message: string): void {
    if (this.loading.delete(splat.id)) this.errors.push({ id: splat.id, message });
    else this.undrop(splat.id);
  }

  /**
   * On a settled view: forget every loaded and queued capture past
   * `SPLAT_KEEP_M`, so either is found again if its tile comes back. Returns
   * the loaded ones, for the caller to dispose, and whether anything changed.
   */
  settle(view: View): { unloaded: Held<T>[]; changed: boolean } {
    const unloaded = [...this.loaded.values()].filter((h) => distanceM(h.splat, view) > SPLAT_KEEP_M);
    for (const h of unloaded) this.forget(h.splat.id);
    const farLoading = [...this.loading].filter((id) => distanceM(this.known.get(id)!, view) > SPLAT_KEEP_M);
    for (const id of farLoading) {
      this.loading.delete(id);
      this.known.delete(id);
      this.dropped.set(id, (this.dropped.get(id) ?? 0) + 1);
    }
    const far = this.queue.filter((s) => distanceM(s, view) > SPLAT_KEEP_M);
    if (far.length) {
      this.queue = this.queue.filter((s) => !far.includes(s));
      for (const s of far) this.known.delete(s.id);
    }
    return { unloaded, changed: unloaded.length > 0 || farLoading.length > 0 || far.length > 0 };
  }

  /** Every loaded capture. */
  held(): Held<T>[] {
    return [...this.loaded.values()];
  }

  /** Drop everything; the loaded ones are returned for the caller to dispose. */
  clear(): Held<T>[] {
    const held = this.held();
    this.loaded.clear();
    this.known.clear();
    this.queue = [];
    this.loading.clear();
    this.dropped.clear();
    return held;
  }

  counts(): Pick<SplatStatus, "known" | "loaded" | "loading" | "errors"> {
    return { known: this.known.size, loaded: this.loaded.size, loading: [...this.loading], errors: [...this.errors] };
  }

  private droppedCount(): number {
    let n = 0;
    for (const c of this.dropped.values()) n += c;
    return n;
  }

  private undrop(id: string): void {
    const c = this.dropped.get(id) ?? 0;
    if (c > 1) this.dropped.set(id, c - 1);
    else this.dropped.delete(id);
  }

  private forget(id: string): void {
    this.loaded.delete(id);
    this.known.delete(id);
  }
}

function distanceM(splat: Splat, view: View): number {
  return mercatorDistance(splat, view.origin) / view.metre;
}
