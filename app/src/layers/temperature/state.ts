import type { SunlightState } from "../sunlight";

/**
 * The layer's state: `off`, or else the direct-sun layer's. See *State* in
 * `specs/spec.md`.
 */
export type TemperatureState = SunlightState;

export function temperatureState(visible: boolean, sunlight: SunlightState): TemperatureState {
  if (!visible) return "off";
  // The direct-sun layer is off only until this layer's demand reaches it.
  return sunlight === "off" ? "waiting" : sunlight;
}
