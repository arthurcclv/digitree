import type { ExportFrame } from "./frame";
import { layer, type DictValue, type LayerMeta, type Prim } from "./usda";
import { usdz } from "./usdz";
import { zip, type ZipEntry } from "./zip";

/**
 * What a layer hands the host, the root layer that references the packages,
 * and the outer zip. See *Output* and *The host's part* in `specs/spec.md`.
 */

export interface UsdPackage {
  /** File stem: "buildings" → buildings.usdz. */
  name: string;
  /** The package's root prim, and its prim under `/World`: "Buildings". */
  prim: string;
  usdz: Blob;
  /** Files written next to the package in the outer zip (the GeoTIFFs). */
  sidecars: { name: string; blob: Blob }[];
  /** Shown in the root's attribution list. */
  attribution: string[];
  /** Set by a raster layer: its result's sun time. */
  sunTime?: number;
  /** Half-side of the origin-centred square covering the geometry, when it can exceed the frame. */
  extentM?: number;
}

export type UsdExportReason = "not-ready" | "failed";

export class UsdExportError extends Error {
  constructor(
    readonly layer: string,
    readonly reason: UsdExportReason,
    detail: string,
  ) {
    super(`${layer}: ${detail}`);
    this.name = "UsdExportError";
  }
}

/** The metadata every layer of the export carries: Z-up, metres, where it is. */
export function stageMeta(frame: ExportFrame, defaultPrim: string, custom: Record<string, DictValue> = {}): LayerMeta {
  return {
    defaultPrim,
    upAxis: "Z",
    metersPerUnit: 1,
    customLayerData: {
      geo: { crs: "EPSG:3857", originLng: frame.centre.lng, originLat: frame.centre.lat, sizeM: frame.sizeM },
      ...custom,
    },
  };
}

/** What names, places and credits a package, whatever it holds. */
export interface PackageMeta {
  name: string;
  prim: string;
  frame: ExportFrame;
  attribution: string[];
  sunTime?: number;
  /** Extra `customLayerData`, beside the frame's. */
  custom?: Record<string, DictValue>;
  sidecars?: UsdPackage["sidecars"];
}

export interface PackageInput extends PackageMeta {
  /** The children of the package's root `Xform`. */
  children: Prim[];
  /** Files inside the package, as `textures/…png`. */
  files?: ZipEntry[];
  extentM?: number;
}

/** A package's root layer, as text. */
export function packageLayer(p: Omit<PackageInput, "files" | "sidecars">): string {
  const custom: Record<string, DictValue> = { ...(p.custom ?? {}) };
  if (p.attribution.length) custom.attribution = p.attribution;
  return layer(stageMeta(p.frame, p.prim, custom), [{ type: "Xform", name: p.prim, meta: ['kind = "component"'], children: p.children }]);
}

export function buildPackage(p: PackageInput): UsdPackage {
  const bytes = usdz(`${p.name}.usda`, packageLayer(p), p.files ?? []);
  return {
    name: p.name,
    prim: p.prim,
    usdz: new Blob([bytes as BlobPart], { type: "model/vnd.usdz+zip" }),
    sidecars: p.sidecars ?? [],
    attribution: p.attribution,
    sunTime: p.sunTime,
    extentM: p.extentM,
  };
}

/** `scene.usda`: one referencing prim per package, in the order given. */
export function rootLayer(frame: ExportFrame, packages: readonly UsdPackage[], exportedAt: number, sunTime: number): string {
  const attribution = [...new Set(packages.flatMap((p) => p.attribution))];
  const meta = stageMeta(frame, "World", {
    exportedAt: new Date(exportedAt).toISOString(),
    sunTime: new Date(sunTime).toISOString(),
    ...(attribution.length ? { attribution } : {}),
  });
  const children: Prim[] = packages.map((p) => ({
    type: "",
    name: p.prim,
    meta: [`prepend references = @./${p.name}.usdz@`],
  }));
  return layer(meta, [{ type: "Xform", name: "World", children }]);
}

/** The download: the root, then each package and its sidecars. Stored, not compressed. */
export async function sceneZip(root: string, packages: readonly UsdPackage[]): Promise<Blob> {
  const entries: ZipEntry[] = [{ name: "scene.usda", data: new TextEncoder().encode(root) }];
  for (const p of packages) {
    entries.push({ name: `${p.name}.usdz`, data: new Uint8Array(await p.usdz.arrayBuffer()) });
    for (const s of p.sidecars) entries.push({ name: s.name, data: new Uint8Array(await s.blob.arrayBuffer()) });
  }
  return new Blob([zip(entries) as BlobPart], { type: "application/zip" });
}
