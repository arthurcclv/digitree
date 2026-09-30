import { rasterPackage, UsdExportError, type ExportFrame, type UsdPackage } from "../../lib/usd";
import { nearRaster } from "../sunlight";
import { petRampAt, type PetRead } from "./pet";

/**
 * PET as a USD package: a ground quad above the direct-sun one, textured with
 * the PET ramp, the GeoTIFF beside it, over the same export pass's cells. See *Sunlight and temperature* in
 * `src/lib/usd/specs/spec.md`.
 */

export const TEMPERATURE_USD_NAME = "temperature";
/** Above the direct-sun overlay, as on the map. */
export const TEMPERATURE_USD_Z = 0.04;

export function temperaturePackage(result: PetRead | null, frame: ExportFrame): Promise<UsdPackage> {
  if (!result) return Promise.reject(new UsdExportError(TEMPERATURE_USD_NAME, "not-ready", "no PET result to export"));
  const { read, params } = result;
  return rasterPackage({
    // Over exactly the frame, from the direct-sun layer's export pass.
    ...nearRaster(read),
    name: TEMPERATURE_USD_NAME,
    prim: "Temperature",
    frame,
    z: TEMPERATURE_USD_Z,
    rampAt: petRampAt,
    // Its own is none: the direct-sun package credits the sources.
    attribution: [],
    custom: { quantity: "physiological equivalent temperature (PET, degC)", g0: params.g0, ta: params.ta, v: params.v },
  });
}
