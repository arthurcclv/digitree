import { changed, nativeLayer, type LayerMount, type MountContext } from "../../lib/mount";
import { TREE_LAYER_ID } from "./constants";
import { treeMeshRecord, treePointsLayer } from "./records";
import type { TreeSource } from "./schema";
import { ThreeTreeLayer, type ModelStatus } from "./treeLayer";
import type { TreeSettings } from "./index";

export interface TreeMountHooks {
  /** Models arrive one at a time, long after the switch that asked for them. */
  onModelStatus?: (status: ModelStatus) => void;
}

export type TreeMount = LayerMount<TreeSettings>;

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
  const tree = new ThreeTreeLayer(trees.sourceLayer);
  tree.onModelsChanged = () => hooks.onModelStatus?.(tree.modelStatus());
  // GeoLibre's generic opacity and visibility controls, routed into three.js.
  const native = nativeLayer(map, TREE_LAYER_ID, tree, {
    setOpacity: (opacity) => tree.setOpacity(opacity),
    setVisibility: (visible) => tree.setVisibility(visible),
  });
  let settings: TreeSettings | null = null;

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
    dispose() {
      native.dispose();
      tree.dispose();
    },
  };
}
