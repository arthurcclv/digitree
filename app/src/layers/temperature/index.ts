import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { LPI_NODE } from "../sunlight";
import { TEMPERATURE_NATIVE_LAYER_ID, DEFAULT_PET_PARAMS } from "./temperatureLayer";

// Only what the app reads. Tests import the folder's modules directly.
export {
  PET_NODATA,
  TEMPERATURE_NATIVE_LAYER_ID,
  ThreeTemperatureLayer,
  type TemperatureStatus,
} from "./temperatureLayer";
export { PET_NODE, PET_RAMP, type PetClass, type PetField, type PetParams, type PetProbe } from "./pet";
export { temperatureState, type TemperatureState } from "./state";

/** GeoLibre record id. */
export const TEMPERATURE_LAYER_ID = "temperature";

/** What `temperature.pet` derives from; the engine adds the node with these. */
export const PET_DEPS = [LPI_NODE] as const;

export interface TemperatureSettings {
  /** Overlay on/off. On makes the direct-sun layer compute, shown or not. */
  visible: boolean;
  opacity: number;
  /** Global irradiance, W/m². */
  g0: number;
  /** Air temperature, °C. */
  ta: number;
  /** Wind speed, m/s. */
  v: number;
}

export const DEFAULT_TEMPERATURE_SETTINGS: TemperatureSettings = {
  visible: false,
  opacity: 0.8,
  ...DEFAULT_PET_PARAMS,
};

/** The panel's slider ranges, as in the spec's *Settings* table. */
export const PET_PARAM_RANGES = {
  g0: { min: 0, max: 1200, step: 10 },
  ta: { min: 15, max: 40, step: 0.5 },
  v: { min: 0, max: 10, step: 0.1 },
} as const;

/**
 * The external-native record, on the direct-sun record's pattern: GeoLibre
 * moves and shows the custom layer we add, and routes opacity and visibility to
 * it through the paint bridge.
 */
export function temperatureRecord(settings: TemperatureSettings): GeoLibreLayer {
  return {
    id: TEMPERATURE_LAYER_ID,
    name: "Felt temperature (PET) · three.js",
    // Inert on the external-native path, as for the tree mesh.
    type: "3d-tiles",
    // Empty on purpose: every input arrives through the DAG, not a source.
    source: {},
    visible: settings.visible,
    opacity: settings.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "threejs",
      nativeLayerIds: [TEMPERATURE_NATIVE_LAYER_ID],
      paintMode: "plugin",
    },
  };
}
