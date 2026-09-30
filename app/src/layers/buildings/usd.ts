import * as THREE from "three";
import { hexRgb, interpolateStops, srgbToLinear, type Rgb } from "../../lib/colour";
import { settle, TileStore, type BuildingFeature, type TileId } from "../../lib/tiles";
import {
  buildPackage,
  frameTiles,
  linearRgb,
  meshPrim,
  previewMaterial,
  projection,
  UsdExportError,
  usda,
  xform,
  type ExportFrame,
  type FrameProjection,
  type UsdPackage,
} from "../../lib/usd";
import { buildingTiles, meetsMinHeight, type BuildingSource } from "./schema";
import type { BuildingSettings, Palette } from "./index";

/**
 * The buildings as a USD package: one `Mesh` per feature, walls and roof, no
 * floor. See *Buildings* in `src/lib/usd/specs/spec.md`.
 */

export const BUILDINGS_USD_NAME = "buildings";
const PRIM = "Buildings";
const MATERIAL = `/${PRIM}/Looks/Building`;

/** What of the settings the package reads: what the extrusion paints with. */
export type BuildingUsdSettings = Pick<BuildingSettings, "heightScale" | "minHeight" | "flatColor" | "paletteId">;

type Vec2 = [number, number];

/** Twice the signed area: positive when counter-clockwise with y north. */
function signedArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    a += x0 * y1 - x1 * y0;
  }
  return a;
}

/** A feature's polygons as one mesh in the frame, or `null` if none has three points. */
export function buildingMesh(
  polygons: BuildingFeature["polygons"],
  topM: number,
  proj: FrameProjection,
): { points: number[]; faceVertexCounts: number[]; faceVertexIndices: number[] } | null {
  const points: number[] = [];
  const counts: number[] = [];
  const indices: number[] = [];
  for (const poly of polygons) {
    const rings = poly
      .map((ring) => {
        const pts = ring.map(([lng, lat]) => proj.toLocal(lng, lat));
        // GeoJSON rings repeat their first point.
        const [a, b] = [pts[0], pts[pts.length - 1]];
        if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
        return pts;
      })
      // A polygon without an outer ring is nothing; a degenerate hole is dropped.
      .filter((r, i) => i === 0 || r.length >= 3);
    if (rings[0].length < 3) continue;
    // Outer counter-clockwise, holes clockwise: every face then points outward.
    rings.forEach((r, i) => {
      if (i === 0 ? signedArea(r) < 0 : signedArea(r) > 0) r.reverse();
    });

    const base = points.length / 3;
    const ringStart: number[] = [];
    let n = 0;
    for (const r of rings) {
      ringStart.push(n);
      n += r.length;
    }
    // Bottom vertices [base, base + n), top vertices [base + n, base + 2n).
    for (const r of rings) for (const [x, y] of r) points.push(x, y, 0);
    for (const r of rings) for (const [x, y] of r) points.push(x, y, topM);

    rings.forEach((r, k) => {
      for (let i = 0; i < r.length; i++) {
        const a = base + ringStart[k] + i;
        const b = base + ringStart[k] + ((i + 1) % r.length);
        counts.push(4);
        indices.push(a, b, b + n, a + n);
      }
    });

    const [outer, ...holes] = rings;
    const tris = THREE.ShapeUtils.triangulateShape(
      outer.map(([x, y]) => new THREE.Vector2(x, y)),
      holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y))),
    );
    const flat = rings.flat();
    for (const [a, b, c] of tris) {
      // The roof faces up: counter-clockwise seen from above.
      const [pa, pb, pc] = [flat[a], flat[b], flat[c]];
      const up = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]) >= 0;
      counts.push(3);
      indices.push(...(up ? [a, b, c] : [a, c, b]).map((i) => base + n + i));
    }
  }
  return counts.length ? { points, faceVertexCounts: counts, faceVertexIndices: indices } : null;
}

/** The extrusion's colour at a true height: the palette interpolated in sRGB, or the flat colour. */
export function buildingColour(settings: BuildingUsdSettings, palettes: readonly Palette[], heightM: number): Rgb {
  const palette = palettes.find((p) => p.id === settings.paletteId);
  if (!palette) return linearRgb(settings.flatColor);
  const [r, g, b] = interpolateStops(
    palette.stops.map(([h, hex]) => [h, hexRgb(hex)] as const),
    heightM,
  );
  // To 8 bits first, as the extrusion's colour is.
  const byte = (v: number) => Math.round(v * 255) / 255;
  return srgbToLinear([byte(r), byte(g), byte(b)]);
}

export interface TileFeatures {
  tile: TileId;
  features: BuildingFeature[];
}

/** The package from decoded tiles, in the order given. Pure but for the zip. */
export function buildingsPackage(
  tiles: readonly TileFeatures[],
  settings: BuildingUsdSettings,
  palettes: readonly Palette[],
  frame: ExportFrame,
  attribution: string,
): UsdPackage {
  const proj = projection(frame);
  const meshes = [];
  // The half-side of the origin-centred square covering the frame and every mesh.
  let extentM = frame.sizeM / 2;
  for (const { tile, features } of tiles) {
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (settings.minHeight > 0 && !meetsMinHeight(f.heightM, settings.minHeight)) continue;
      // Per footprint: OpenMapTiles merges many into one feature, and keeping
      // the feature whole drags in buildings far outside the frame.
      const kept = f.polygons.filter((poly) =>
        poly.some((ring) => ring.some(([lng, lat]) => proj.inside(...proj.toLocal(lng, lat)))),
      );
      if (!kept.length) continue;
      const mesh = buildingMesh(kept, f.heightM * settings.heightScale, proj);
      if (!mesh) continue;
      for (let k = 0; k < mesh.points.length; k += 3) {
        extentM = Math.max(extentM, Math.abs(mesh.points[k]), Math.abs(mesh.points[k + 1]));
      }
      meshes.push(
        meshPrim(`b_${tile.x}_${tile.y}_${i}`, {
          ...mesh,
          displayColor: buildingColour(settings, palettes, f.heightM),
          material: MATERIAL,
          extra: [usda.prop("float", "primvars:heightM", usda.num(f.heightM), { interpolation: "constant" })],
        }),
      );
    }
  }
  return buildPackage({
    name: BUILDINGS_USD_NAME,
    prim: PRIM,
    frame,
    attribution: [attribution],
    custom: { heightScale: settings.heightScale, extentM },
    extentM,
    children: [
      xform("Looks", [previewMaterial(`/${PRIM}/Looks`, "Building", { diffuseFromDisplayColor: true, roughness: 0.85 })]),
      ...meshes,
    ],
  });
}

/** Fetch every tile the frame touches, then build the package. */
export async function fetchBuildingsUsd(
  source: BuildingSource,
  settings: BuildingUsdSettings,
  palettes: readonly Palette[],
  frame: ExportFrame,
  fetchFn?: typeof fetch,
): Promise<UsdPackage> {
  const store = new TileStore({ buildings: buildingTiles(source) }, fetchFn);
  const tiles = frameTiles(frame);
  const counts = await settle(store, tiles);
  if (counts.failed) throw new UsdExportError(BUILDINGS_USD_NAME, "failed", `${counts.failed} building tile(s) failed to load`);
  return buildingsPackage(
    tiles.map((tile) => ({ tile, features: store.featuresOf("buildings", tile) })),
    settings,
    palettes,
    frame,
    source.attribution,
  );
}
