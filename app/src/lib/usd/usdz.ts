import { zip, type ZipEntry } from "./zip";

/**
 * A `.usdz` package: its root layer first, every entry's data 64-byte
 * aligned, stored, and only file types USDZ allows that this app writes. See
 * *A layer package* in `specs/spec.md`.
 */

/** The byte boundary every entry's data starts on, as the USDZ rules require. */
export const USDZ_ALIGN = 64;
/** The file types USDZ allows that this app writes: no WebP, no TIFF. */
const ALLOWED = /\.(usda|png)$/;

export function usdz(rootName: string, rootLayer: string, files: readonly ZipEntry[] = []): Uint8Array {
  if (!rootName.endsWith(".usda")) throw new Error(`a package's root layer is a .usda: ${rootName}`);
  for (const f of files) {
    if (!ALLOWED.test(f.name)) throw new Error(`not allowed in a usdz: ${f.name}`);
  }
  return zip([{ name: rootName, data: new TextEncoder().encode(rootLayer) }, ...files], USDZ_ALIGN);
}
