import type { MapMouseEvent } from "maplibre-gl";
import { sourceId } from "@geolibre/map/style-layer-ids";
import { changed, nativeLayer, type LayerMount, type MountContext } from "../../lib/mount";
import { TREE_LAYER_ID, TREE_POINTS_LAYER_ID, TREE_STATE } from "./constants";
import { pickCircle } from "./pick";
import { treeMeshRecord, treePointsLayer } from "./records";
import type { TreeFeature, TreeSource } from "./schema";
import { ThreeTreeLayer, TREE_MESH_MIN_ZOOM, type ModelStatus, type TreePick } from "./treeLayer";
import { exportTreesUsd } from "./usd";
import type { ExportFrame, UsdPackage } from "../../lib/usd";
import type { TreeSettings } from "./index";

export interface TreeMountHooks {
  /** Models arrive one at a time, long after the switch that asked for them. */
  onModelStatus?: (status: ModelStatus) => void;
}

export interface TreeMount extends LayerMount<TreeSettings> {
  /** The meshes as a USD package, as drawn now. See `src/lib/usd/specs/spec.md`. */
  exportUsd(frame: ExportFrame): Promise<UsdPackage>;
  /** The tree drawn under a screen point (CSS px, map container), or null. See `specs/tree-info.md`. */
  pick(point: { x: number; y: number }): TreeFeature | null;
  /** Mark one tree as selected, by `tree_id`, or clear the mark. */
  select(treeId: string | null): void;
}

/** The two feature-state keys, each held by at most one feature. */
type StateKey = (typeof TREE_STATE)[keyof typeof TREE_STATE];

/**
 * The tree layer attached to a map: both records, and the three.js half with
 * its bridge and the settings GeoLibre cannot carry. See `specs/spec.md`,
 * *Lifecycle*, and `src/lib/mount/specs/spec.md`.
 */
export function mountTree(
  { map }: MountContext,
  { trees }: { trees: TreeSource },
  initial: TreeSettings,
  hooks: TreeMountHooks = {},
): TreeMount {
  const tree = new ThreeTreeLayer(trees);
  tree.onModelsChanged = () => hooks.onModelStatus?.(tree.modelStatus());
  // GeoLibre's generic opacity and visibility controls, routed into three.js.
  const native = nativeLayer(map, TREE_LAYER_ID, tree, {
    setOpacity: (opacity) => tree.setOpacity(opacity),
    setVisibility: (visible) => tree.setVisibility(visible),
  });
  let settings: TreeSettings | null = null;

  /**
   * What a click would pick now: the meshes where they are drawn, else the
   * circles where they are, else nothing. Remembers the result, so `select`
   * can find the feature id of the tree it was just given.
   */
  let lastPick: TreePick | null = null;
  const pickAt = (point: { x: number; y: number }): TreePick | null => {
    const s = settings!;
    let found: TreePick | null = null;
    if (s.meshVisible && map.getZoom() >= TREE_MESH_MIN_ZOOM) found = tree.pickMesh(point);
    else if (s.pointsVisible) found = pickCircle(map, point);
    if (found) lastPick = found;
    return found;
  };

  // The circles' marks: feature-state on the points source, by MVT feature id.
  const marked: Record<StateKey, TreePick | null> = { hover: null, selected: null };
  const markCircle = (key: StateKey, pick: TreePick | null) => {
    const target = (p: TreePick) => ({ source: sourceId(TREE_POINTS_LAYER_ID), sourceLayer: trees.sourceLayer, id: p.featureId });
    for (const [p, on] of [
      [marked[key], false],
      [pick, true],
    ] as const) {
      if (p?.featureId === undefined) continue;
      try {
        map.setFeatureState(target(p), { [key]: on });
      } catch {
        // The source is gone (a style swap); its states went with it.
      }
    }
    marked[key] = pick;
  };
  const applyMarks = () =>
    tree.setMarks({ hover: marked.hover?.tree.id ?? null, selected: marked.selected?.tree.id ?? null });

  const setHover = (pick: TreePick | null) => {
    if ((pick?.tree.id ?? null) === (marked.hover?.tree.id ?? null)) return;
    markCircle(TREE_STATE.hover, pick);
    applyMarks();
    map.getCanvas().style.cursor = pick ? "pointer" : "";
  };

  // Hover: at most one pick per frame, none while the camera moves.
  let frame = 0;
  let pointer: { x: number; y: number } | null = null;
  const hoverNow = () => {
    frame = 0;
    if (!pointer || map.isMoving()) return setHover(null);
    setHover(pickAt(pointer));
  };
  const onMouseMove = (e: MapMouseEvent) => {
    pointer = { x: e.point.x, y: e.point.y };
    if (!frame) frame = requestAnimationFrame(hoverNow);
  };
  const onLeave = () => {
    pointer = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    setHover(null);
  };
  map.on("mousemove", onMouseMove);
  map.on("mouseout", onLeave);
  map.on("movestart", onLeave);

  const update = (next: TreeSettings) => {
    // Height is not a GeoLibre concept.
    if (changed(settings, next, "heightScale")) tree.setHeightScale(next.heightScale);
    // The circles are filtered by their record; GeoLibre cannot filter the
    // custom layer, so the meshes are told separately.
    if (changed(settings, next, "kind")) tree.setKind(next.kind);
    // Which geometry the meshes draw reaches exactly one of the two halves.
    if (changed(settings, next, "meshSource")) tree.setMeshSource(next.meshSource);
    settings = next;
  };
  update(initial);

  return {
    update,
    prepareSync() {
      native.ensureAdded();
      // Points first: the meshes sit above the circles.
      return [treePointsLayer(settings!, trees), treeMeshRecord(settings!)];
    },
    exportUsd: (frame) => exportTreesUsd(trees, settings!, frame),
    pick: (point) => pickAt(point)?.tree ?? null,
    select(treeId) {
      if (treeId === (marked.selected?.tree.id ?? null)) return;
      // The circles need the feature id, which only a pick knows.
      const pick: TreePick | null =
        treeId === null ? null : lastPick?.tree.id === treeId ? lastPick : { tree: { id: treeId } as TreeFeature, featureId: undefined };
      markCircle(TREE_STATE.selected, pick);
      applyMarks();
    },
    dispose() {
      map.off("mousemove", onMouseMove);
      map.off("mouseout", onLeave);
      map.off("movestart", onLeave);
      if (frame) cancelAnimationFrame(frame);
      native.dispose();
      tree.dispose();
    },
  };
}
