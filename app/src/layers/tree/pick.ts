/**
 * Finding the tree under a screen point on the circles, and the card's rows.
 * The meshes' half of picking is `ThreeTreeLayer.pickMesh`. See
 * `specs/tree-info.md`.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { nativeLayerIdPrefix } from "@geolibre/map/style-layer-ids";
import { TREE_POINTS_LAYER_ID } from "./constants";
import { treeOf, type TreeFeature } from "./schema";
import type { TreePick } from "./treeLayer";

/** How far outside a circle's rendered edge a click still picks it, in CSS px. */
export const CIRCLE_PICK_PX = 6;

/** The query `pickCircle` makes; the part of a map it needs. */
type CircleMap = Pick<MapLibreMap, "getStyle" | "queryRenderedFeatures" | "project">;

/**
 * The tree whose circle is under a screen point, or `null`. MapLibre tests
 * the query box against each circle's rendered radius; of several hits the
 * nearest centre wins, and on a tie the lower `tree_id`.
 */
export function pickCircle(map: CircleMap, point: { x: number; y: number }): TreePick | null {
  // A vector-tile record's style layers carry its source-layer in their ids,
  // so they are found by GeoLibre's prefix rather than rebuilt by hand.
  const prefix = nativeLayerIdPrefix(TREE_POINTS_LAYER_ID);
  const layers = (map.getStyle()?.layers ?? [])
    .filter((l) => l.type === "circle" && l.id.startsWith(prefix))
    .map((l) => l.id);
  if (!layers.length) return null;

  const r = CIRCLE_PICK_PX;
  const features = map.queryRenderedFeatures(
    [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ],
    { layers },
  );
  let best: { d2: number; pick: TreePick } | null = null;
  for (const feature of features) {
    const tree = treeOf(feature.properties, feature.geometry);
    if (!tree) continue;
    const p = map.project([tree.lng, tree.lat]);
    const d2 = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
    if (!best || d2 < best.d2 || (d2 === best.d2 && tree.id < best.pick.tree.id)) {
      best = { d2, pick: { tree, featureId: feature.id } };
    }
  }
  return best?.pick ?? null;
}

/** One line of the tree card. */
export interface TreeInfoRow {
  label: string;
  value: string;
}

const NOT_RECORDED = "—";

/** One decimal: the inventory records nothing finer. */
const num = (v: number, unit: string) => `${Number(v.toFixed(1))} ${unit}`;

/**
 * The card's rows for one tree. A `NULL` value is dashed; a row whose column
 * the tree's source has no column for is left out (district, location and
 * survey date on custom rows; canopy width on the city's).
 */
export function treeInfoRows(tree: TreeFeature, fallbackHeightM: number): TreeInfoRow[] {
  const custom = tree.kind === "custom";
  const or = (v: string | null) => v ?? NOT_RECORDED;
  const rows: TreeInfoRow[] = [{ label: "Tree ID", value: tree.id }];
  if (!custom) {
    rows.push({ label: "District", value: or(tree.district) });
    const location = tree.place && tree.placeNote ? `${tree.place} · ${tree.placeNote}` : tree.place;
    rows.push({ label: "Location", value: or(location) });
  }
  rows.push({
    label: "Height",
    value: tree.heightM === null ? `not recorded · drawn at ${fallbackHeightM} m` : num(tree.heightM, "m"),
  });
  rows.push({ label: "Trunk diameter", value: tree.diameterCm === null ? NOT_RECORDED : num(tree.diameterCm, "cm") });
  if (custom) {
    rows.push({ label: "Canopy width", value: tree.canopyWidthM === null ? NOT_RECORDED : num(tree.canopyWidthM, "m") });
  } else {
    rows.push({ label: "Surveyed", value: or(tree.surveyDate) });
  }
  rows.push({ label: "Coordinates", value: `${tree.lat.toFixed(6)}, ${tree.lng.toFixed(6)}` });
  return rows;
}

/**
 * Whether a picked tree can still be picked under these settings: some half
 * is drawn, and the kind filter lets its kind through. The card closes when
 * it cannot.
 */
export function treeStillShown(
  tree: TreeFeature,
  settings: { pointsVisible: boolean; meshVisible: boolean; kind: string },
): boolean {
  if (!settings.pointsVisible && !settings.meshVisible) return false;
  return settings.kind === "all" || settings.kind === tree.kind;
}
