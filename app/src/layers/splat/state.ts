/** What the host shows about the captures. See *The mount* in `specs/spec.md`. */
export interface SplatStatus {
  state: "idle" | "loading" | "ready" | "error";
  /** Captures found in the fetched tiles. */
  known: number;
  loaded: number;
  /** The ids of the captures loading now, in the order they started. */
  loading: string[];
  errors: { id: string; message: string }[];
  /** Spark's own LoD budget for this device, once Spark has loaded. */
  platformBudget: number | null;
}

/**
 * `idle`: no capture known yet. `loading`: at least one is loading. `ready`: at least
 * one drawn and none loading. `error`: every known capture failed.
 */
export function splatStatus(counts: Omit<SplatStatus, "state">): SplatStatus {
  const { known, loading, errors } = counts;
  const state =
    loading.length > 0 ? "loading" : known === 0 ? "idle" : errors.length === known ? "error" : "ready";
  return { state, ...counts };
}
