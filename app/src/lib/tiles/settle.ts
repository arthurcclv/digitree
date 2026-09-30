import type { TileId } from "./grid";
import type { TileCounts, TileSource, TileStore } from "./store";

/**
 * Ask a store for `tiles` and resolve once none is pending: every one ready
 * or failed. It takes the store's `onChange`, so the store must be the
 * caller's own, as the USD export's and the export pass's are.
 */
export function settle<S extends Record<string, TileSource<unknown>>>(
  store: TileStore<S>,
  tiles: TileId[],
): Promise<TileCounts> {
  return new Promise((resolve) => {
    const check = () => {
      const counts = store.counts();
      if (counts.pending > 0) return;
      store.onChange = null;
      resolve(counts);
    };
    store.onChange = check;
    store.want(tiles);
    check();
  });
}
