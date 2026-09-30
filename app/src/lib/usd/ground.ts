import { gridCentredOnFrame } from "./frame";
import { meshPrim, previewMaterial, xform } from "./prims";
import { colourise, rgbaPng } from "./raster";
import { buildPackage, UsdExportError, type PackageMeta, type UsdPackage } from "./scene";

/**
 * A textured quad covering the frame, north up: the basemap and both raster
 * overlays. See *Per layer* in `specs/spec.md`.
 */
export interface GroundInput extends PackageMeta {
  /** Height above the ground, so overlays do not z-fight the basemap. */
  z: number;
  /** The quad's half-side; the frame's by default. */
  halfM?: number;
  png: Uint8Array;
  /** Take opacity from the texture's alpha, masked at 0.5. */
  masked: boolean;
}

export function groundPackage({ z, halfM, png, masked, ...meta }: GroundInput): UsdPackage {
  const h = halfM ?? meta.frame.sizeM / 2;
  const texture = `textures/${meta.name}.png`;
  const looks = `/${meta.prim}/Looks`;
  return buildPackage({
    ...meta,
    files: [{ name: texture, data: png }],
    children: [
      xform("Looks", [
        previewMaterial(looks, "Ground", {
          texture,
          opacityFromTexture: masked,
          opacityThreshold: masked ? 0.5 : 0,
          roughness: 1,
        }),
      ]),
      meshPrim("Ground", {
        // South-west, south-east, north-east, north-west: counter-clockwise from above.
        points: [-h, -h, z, h, -h, z, h, h, z, -h, h, z],
        faceVertexCounts: [4],
        faceVertexIndices: [0, 1, 2, 3],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        st: [0, 0, 1, 0, 1, 1, 0, 1],
        material: `${looks}/Ground`,
      }),
    ],
  });
}

/** A value grid: rows from the north, `nodata` where there is no value. */
export interface RasterGrid {
  size: number;
  values: Float32Array;
  nodata: number;
  /** Its centre, lng/lat, and its side in metres. */
  centre: readonly [number, number];
  sideM: number;
}

/** A raster: its grid, the same values as a GeoTIFF, and the moment they are for. */
export interface Raster {
  grid: RasterGrid;
  /** Written next to the package. */
  tiff: Blob;
  sunTime: number;
}

export interface RasterInput extends Omit<PackageMeta, "sidecars" | "sunTime">, Raster {
  z: number;
  /** The layer's ramp, sRGB 0–1. */
  rampAt: (v: number) => readonly [number, number, number];
}

/**
 * A raster overlay as a ground package: its grid through its ramp as the
 * texture, NoData transparent, its GeoTIFF beside the package, the quad the
 * grid's own size. The layer computed the grid over the frame; one not centred
 * on it is a bug, and fails.
 */
export async function rasterPackage({ grid, tiff, rampAt, custom, ...meta }: RasterInput): Promise<UsdPackage> {
  if (!gridCentredOnFrame(grid.centre, grid.sideM / grid.size, meta.frame)) {
    throw new UsdExportError(meta.name, "failed", "the grid is not centred on the export frame");
  }
  const png = await rgbaPng(colourise(grid.values, grid.nodata, rampAt), grid.size, grid.size);
  const tif = `${meta.name}.tif`;
  return groundPackage({
    ...meta,
    halfM: grid.sideM / 2,
    png,
    masked: true,
    sidecars: [{ name: tif, blob: tiff }],
    // A string, not an asset path: inside a usdz an asset resolves within the
    // package, and the GeoTIFF sits beside it.
    custom: { ...(custom ?? {}), values: tif, noData: grid.nodata, sunTime: new Date(meta.sunTime).toISOString() },
  });
}
