/**
 * The host's two rules for the USD scene export: which layers take part, in
 * what order, and when the export may start. Pure, and shared by
 * `useMapEngine` (which exports them) and `App.tsx` (which lists them). See
 * *The host's part* in `src/lib/usd/specs/spec.md`.
 */

/** A package the scene export can write. */
export type SceneParticipant = "basemap" | "buildings" | "sunlight" | "temperature" | "trees" | "light";

/** The stack order, bottom up: the root references the packages in it. */
export const SCENE_STACK: readonly SceneParticipant[] = ["basemap", "buildings", "sunlight", "temperature", "trees", "light"];

/** What is on screen, as the export counts it (the tree circles do not count). */
export interface SceneVisibility {
  buildings: boolean;
  sunlight: boolean;
  temperature: boolean;
  treeMeshes: boolean;
}

/** The participants of an export, in stack order. The basemap and the light are always in. */
export function sceneParticipants(v: SceneVisibility): SceneParticipant[] {
  const shown: Record<SceneParticipant, boolean> = {
    basemap: true,
    buildings: v.buildings,
    sunlight: v.sunlight,
    temperature: v.temperature,
    trees: v.treeMeshes,
    light: true,
  };
  return SCENE_STACK.filter((p) => shown[p]);
}

/**
 * May the export start? Once the map is ready, and only when each visible
 * raster overlay has a result (state `ready`); the other layers are always
 * ready.
 */
export function sceneExportReady(mapReady: boolean, overlays: readonly { visible: boolean; state: string }[]): boolean {
  return mapReady && overlays.every((o) => !o.visible || o.state === "ready");
}
