import { buildPackage, rasterPackage, usda, type ExportFrame, type Raster, type UsdPackage } from "../../lib/usd";
import type { NearRead } from "./lpi";
import { sunlightRampAt } from "./ramp";
import { sunPosition } from "./sun";

/**
 * The direct-sun index as a USD package: a ground quad just above the
 * basemap, textured with the ramp, the GeoTIFF beside it, both from an export
 * pass over the frame. See *Sunlight and temperature* in
 * `src/lib/usd/specs/spec.md`.
 */

export const SUNLIGHT_USD_NAME = "sunlight";
/** Above the basemap, below the PET overlay. */
export const SUNLIGHT_USD_Z = 0.02;

/** A read of the export pass as a raster package's values: both overlays' export. */
export function nearRaster({ grid, tiff }: NearRead): Raster {
  return { grid: { ...grid, centre: grid.domain.centre, sideM: grid.domain.domainM }, tiff, sunTime: grid.sunTime };
}

/** `attribution`: the sources whose features cast the shadows. */
export function sunlightPackage(read: NearRead, frame: ExportFrame, attribution: string[]): Promise<UsdPackage> {
  return rasterPackage({
    ...nearRaster(read),
    name: SUNLIGHT_USD_NAME,
    prim: "Sunlight",
    frame,
    z: SUNLIGHT_USD_Z,
    rampAt: sunlightRampAt,
    attribution,
    custom: { quantity: "direct-sun transmittance (index, 0-1)" },
  });
}

export const LIGHT_USD_NAME = "light";
/** The dome's intensity. */
export const LIGHT_INTENSITY = 1000;

/**
 * The scene's light as a USD package: one `DomeLight` at `/Light/Dome`, in
 * every export. A dome has no direction, so the sun at `sunTime` is recorded
 * as metadata only. See *Light* in `src/lib/usd/specs/spec.md`.
 */
export function lightPackage(frame: ExportFrame, sunTime: number): UsdPackage {
  const { azimuthDeg, elevationDeg } = sunPosition(new Date(sunTime), frame.centre.lng, frame.centre.lat);
  return buildPackage({
    name: LIGHT_USD_NAME,
    prim: "Light",
    frame,
    attribution: [],
    sunTime,
    custom: { sunTime: new Date(sunTime).toISOString(), azimuthDeg, elevationDeg },
    children: [
      {
        type: "DomeLight",
        name: "Dome",
        props: [
          usda.prop("color3f", "inputs:color", usda.tuple([1, 1, 1])),
          usda.prop("float", "inputs:exposure", "0"),
          usda.prop("float", "inputs:intensity", usda.num(LIGHT_INTENSITY)),
        ],
      },
    ],
  });
}
