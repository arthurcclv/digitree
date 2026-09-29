import type { BuildingSettings, BuildingSource } from "../buildings";
import { changed, nativeLayer, type LayerMount, type MountContext } from "../../lib/mount";
import { ThreeAoLayer } from "./aoLayer";
import { AO_LAYER_ID, ambientOcclusionRecord } from "./records";
import type { AoState } from "./state";
import type { AmbientOcclusionSettings } from "./index";

/**
 * The layer's own settings, and the buildings' fields it must match: it is
 * shown only while they are, and its redrawn prisms follow their exaggeration
 * and filter.
 */
export interface AmbientOcclusionMountSettings {
  ao: AmbientOcclusionSettings;
  buildings: Pick<BuildingSettings, "visible" | "heightScale" | "minHeight">;
}

export interface AmbientOcclusionMountHooks {
  onStatus?: (state: AoState) => void;
}

export type AmbientOcclusionMount = LayerMount<AmbientOcclusionMountSettings>;

/**
 * Ambient occlusion attached to a map. See *The GeoLibre record* in
 * `specs/spec.md`, and `src/lib/mount/specs/spec.md`.
 */
export function mountAmbientOcclusion(
  { map }: MountContext,
  { buildings }: { buildings: BuildingSource },
  initial: AmbientOcclusionMountSettings,
  hooks: AmbientOcclusionMountHooks = {},
): AmbientOcclusionMount {
  const ao = new ThreeAoLayer(buildings);
  ao.onStatus = (state) => hooks.onStatus?.(state);
  const native = nativeLayer(map, AO_LAYER_ID, ao, {
    setOpacity: (opacity) => ao.setOpacity(opacity),
    setVisibility: (visible) => ao.setVisibility(visible),
  });
  let settings: AmbientOcclusionMountSettings | null = null;

  const update = (next: AmbientOcclusionMountSettings) => {
    const prev = settings;
    // Not GeoLibre concepts: strength, reach, and the buildings' shape.
    if (
      changed(prev?.ao ?? null, next.ao, "intensity", "radiusM") ||
      changed(prev?.buildings ?? null, next.buildings, "heightScale", "minHeight")
    ) {
      ao.setParams({
        intensity: next.ao.intensity,
        radiusM: next.ao.radiusM,
        heightScale: next.buildings.heightScale,
        minHeight: next.buildings.minHeight,
      });
    }
    settings = next;
  };
  update(initial);

  return {
    update,
    prepareSync() {
      native.ensureAdded();
      return [ambientOcclusionRecord(settings!.ao, settings!.buildings)];
    },
    dispose() {
      native.dispose();
      ao.dispose();
    },
  };
}
