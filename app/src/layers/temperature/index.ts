import { DEFAULT_PET_PARAMS } from "./temperatureLayer";

// Only what the app reads. Tests import the folder's modules directly.
export {
  PET_NODATA,
  TEMPERATURE_NATIVE_LAYER_ID,
  ThreeTemperatureLayer,
  type TemperatureStatus,
} from "./temperatureLayer";
export { PET_NODE, PET_RAMP, type PetClass, type PetField, type PetParams, type PetProbe } from "./pet";
export { temperatureState, type TemperatureState } from "./state";

export { TEMPERATURE_LAYER_ID, temperatureRecord } from "./records";
/** The layer attached to a map. See `src/lib/mount/specs/spec.md`. */
export { mountTemperature, PET_DEPS, type TemperatureMount } from "./mount";

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
