import type { LocalFrame } from "../../lib/tiles";
import { SPLAT_KEEP_M, SPLAT_MAX_CAPTURES } from "./constants";
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
  load: Splat;
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
  private queue: Splat[] = [];
  private loading: string | null = null;

  /**
   * Queue every capture not seen yet, in the order given (nearest first, from
   * `splatsIn`). Whether any was new.
   */
  offer(splats: Splat[]): boolean {
    const fresh = splats.filter((s) => !this.known.has(s.id));
    for (const s of fresh) this.known.set(s.id, s);
    this.queue.push(...fresh);
    return fresh.length > 0;
  }

  /**
   * The next capture to load, one at a time. Past `SPLAT_MAX_CAPTURES` it
   * loads only if nearer than the farthest loaded, which it evicts (already
   * forgotten here; the caller disposes it). `null` while one is loading,
   * when none waits, or when the one due is not nearer: it waits in the queue.
   */
  next(view: View): Next<T> | null {
    if (this.loading !== null) return null;
    const splat = this.queue[0];
    if (!splat) return null;
    let evicted: Held<T> | null = null;
    if (this.loaded.size >= SPLAT_MAX_CAPTURES) {
      let farthest: { held: Held<T>; dist: number } | null = null;
      for (const held of this.loaded.values()) {
        const dist = distanceM(held.splat, view);
        if (!farthest || dist > farthest.dist) farthest = { held, dist };
      }
      if (!farthest || farthest.dist <= distanceM(splat, view)) return null;
      evicted = farthest.held;
      this.forget(evicted.splat.id);
    }
    this.queue.shift();
    this.loading = splat.id;
    return { load: splat, evicted };
  }

  /** The capture `next` gave has loaded. */
  done(splat: Splat, value: T): void {
    this.loaded.set(splat.id, { splat, value });
    this.loading = null;
  }

  /** The capture `next` gave failed to load. It stays known, so it is not retried. */
  failed(splat: Splat, message: string): void {
    this.errors.push({ id: splat.id, message });
    this.loading = null;
  }

  /**
   * On a settled view: forget every loaded and queued capture past
   * `SPLAT_KEEP_M`, so either is found again if its tile comes back. Returns
   * the loaded ones, for the caller to dispose, and whether anything changed.
   */
  settle(view: View): { unloaded: Held<T>[]; changed: boolean } {
    const unloaded = [...this.loaded.values()].filter((h) => distanceM(h.splat, view) > SPLAT_KEEP_M);
    for (const h of unloaded) this.forget(h.splat.id);
    const far = this.queue.filter((s) => distanceM(s, view) > SPLAT_KEEP_M);
    if (far.length) {
      this.queue = this.queue.filter((s) => !far.includes(s));
      for (const s of far) this.known.delete(s.id);
    }
    return { unloaded, changed: unloaded.length > 0 || far.length > 0 };
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
    this.loading = null;
    return held;
  }

  counts(): Pick<SplatStatus, "known" | "loaded" | "loading" | "errors"> {
    return { known: this.known.size, loaded: this.loaded.size, loading: this.loading, errors: [...this.errors] };
  }

  private forget(id: string): void {
    this.loaded.delete(id);
    this.known.delete(id);
  }
}

function distanceM(splat: Splat, view: View): number {
  return mercatorDistance(splat, view.origin) / view.metre;
}
