// The USD export's shared writer. It knows no layer; each layer's `usd.ts`
// builds its own package from these. See `specs/spec.md`. Only what a layer
// or the host uses is exported; the rest stays inside the folder.
export {
  exportFrame,
  frameTiles,
  lngLatBounds,
  mercatorBounds,
  projection,
  yawQuat,
  Y_UP_TO_Z_UP_ROTATE_X_DEG,
  type ExportFrame,
  type FrameProjection,
} from "./frame";
export { groundPackage, rasterPackage, type Raster } from "./ground";
export { linearRgb, meshPrim, previewMaterial, xform } from "./prims";
export { imagePng } from "./raster";
export { buildPackage, rootLayer, sceneZip, UsdExportError, type UsdExportReason, type UsdPackage } from "./scene";
export * as usda from "./usda";
export type { ZipEntry } from "./zip";
