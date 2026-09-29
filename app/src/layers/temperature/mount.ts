import { LPI_NODE } from "../sunlight";
import { changed, nativeLayer, type LayerMount, type MountContext } from "../../lib/mount";
import { PET_NODE, type PetProbe } from "./pet";
import { TEMPERATURE_LAYER_ID, temperatureRecord } from "./records";
import { ThreeTemperatureLayer, type TemperatureStatus } from "./temperatureLayer";
import type { TemperatureSettings } from "./index";

/** What `temperature.pet` derives from; the mount adds the node with these. */
export const PET_DEPS = [LPI_NODE] as const;

export interface TemperatureMountHooks {
  onStatus?: (status: TemperatureStatus) => void;
}

export interface TemperatureMount extends LayerMount<TemperatureSettings> {
  /** PET at a point, from the direct-sun layer's own probe. */
  probe(lng: number, lat: number): Promise<PetProbe>;
  /** The near grid in PET, or `null` when there is nothing to export. */
  exportGeoTiff(): Promise<Blob | null>;
}

/**
 * The PET layer attached to a map. Everything it takes from the direct-sun
 * layer arrives through the DAG, so it must be mounted after `mountSunlight`
 * on the same graph; before it, `add` throws. See *The PET node* and *State*
 * in `specs/spec.md`, and `src/lib/mount/specs/spec.md`.
 */
export function mountTemperature(
  { map, graph }: MountContext,
  initial: TemperatureSettings,
  hooks: TemperatureMountHooks = {},
): TemperatureMount {
  graph.add(PET_NODE, PET_DEPS);
  const temperature = new ThreeTemperatureLayer(graph);
  temperature.onStatus = (status) => hooks.onStatus?.(status);
  // Visibility reaches the layer in `update`, not the bridge, as for sunlight.
  const native = nativeLayer(map, TEMPERATURE_LAYER_ID, temperature, {
    setOpacity: (opacity) => temperature.setOpacity(opacity),
    setVisibility: () => {},
  });
  let settings: TemperatureSettings | null = null;

  const update = (next: TemperatureSettings) => {
    // Also sets the node's own demand, and so the direct sun's.
    temperature.setVisibility(next.visible);
    // G0, Ta and V: three uniforms, no new light pass.
    if (changed(settings, next, "g0", "ta", "v")) {
      temperature.setParams({ g0: next.g0, ta: next.ta, v: next.v });
    }
    settings = next;
  };
  update(initial);

  return {
    update,
    prepareSync() {
      native.ensureAdded();
      return [temperatureRecord(settings!)];
    },
    probe: (lng, lat) => temperature.probe(lng, lat),
    exportGeoTiff: () => temperature.exportGeoTiff(),
    dispose() {
      native.dispose();
      temperature.dispose();
    },
  };
}
