import { changed, nativeLayer, type LayerMount, type MountContext } from "../../lib/mount";
import { SPLAT_LAYER_ID } from "./constants";
import { splatRecord } from "./records";
import type { SplatSource } from "./schema";
import { ThreeSplatLayer, type SplatLayerDeps } from "./splatLayer";
import type { SplatStatus } from "./state";
import type { SplatSettings } from "./index";

export interface SplatMountHooks {
  onStatus?: (status: SplatStatus) => void;
}

export type SplatMount = LayerMount<SplatSettings>;

/**
 * The splat captures attached to a map. See *The mount* in `specs/spec.md`,
 * and `src/lib/mount/specs/spec.md`. `deps` is for tests.
 */
export function mountSplat(
  { map }: MountContext,
  { splats }: { splats: SplatSource },
  initial: SplatSettings,
  hooks: SplatMountHooks = {},
  deps: Partial<SplatLayerDeps> = {},
): SplatMount {
  const layer = new ThreeSplatLayer(splats, deps);
  layer.onStatus = (status) => hooks.onStatus?.(status);
  const native = nativeLayer(map, SPLAT_LAYER_ID, layer, {
    setOpacity: (opacity) => layer.setOpacity(opacity),
    setVisibility: (visible) => layer.setVisibility(visible),
  });
  let settings: SplatSettings | null = null;

  const update = (next: SplatSettings) => {
    // Not a GeoLibre concept, so not on the bridge.
    if (changed(settings, next, "minZoom")) layer.setMinZoom(next.minZoom);
    if (changed(settings, next, "lodSplatCount", "lodSplatScale")) {
      layer.setLod(next.lodSplatCount, next.lodSplatScale);
    }
    settings = next;
  };
  update(initial);

  return {
    update,
    prepareSync() {
      native.ensureAdded();
      return [splatRecord(settings!)];
    },
    dispose() {
      native.dispose();
      layer.dispose();
    },
  };
}
