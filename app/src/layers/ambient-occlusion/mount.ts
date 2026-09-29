import type { BuildingSource } from "../buildings";
import { changed, nativeLayer, type LayerMount, type MountContext } from "../../lib/mount";
import { ThreeAoLayer } from "./aoLayer";
import { AO_LAYER_ID, ambientOcclusionRecord } from "./records";
import type { AoState } from "./state";
import type { AmbientOcclusionSettings, ShadedExtrusion } from "./index";

/** The layer's own settings, and the extrusion it shades and must match. */
export interface AmbientOcclusionMountSettings {
  ao: AmbientOcclusionSettings;
  extrusion: ShadedExtrusion;
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
    // Not GeoLibre concepts: strength, reach, and the extrusion's shape.
    if (
      changed(prev?.ao ?? null, next.ao, "intensity", "radiusM") ||
      changed(prev?.extrusion ?? null, next.extrusion, "heightScale", "minHeight")
    ) {
      ao.setParams({
        intensity: next.ao.intensity,
        radiusM: next.ao.radiusM,
        heightScale: next.extrusion.heightScale,
        minHeight: next.extrusion.minHeight,
      });
    }
    settings = next;
  };
  update(initial);

  return {
    update,
    prepareSync() {
      native.ensureAdded();
      return [ambientOcclusionRecord(settings!.ao, settings!.extrusion)];
    },
    dispose() {
      native.dispose();
      ao.dispose();
    },
  };
}
