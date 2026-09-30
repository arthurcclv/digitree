import type { BuildingSource } from "../buildings";
import type { TreeSource } from "../tree";
import { LPI_NODE } from "./lpi";
import { changed, nativeLayer, type LayerMount, type MountContext } from "../../lib/mount";
import { SUNLIGHT_LAYER_ID, sunlightRecord } from "./records";
import { ThreeSunlightLayer, type ProbeResult, type SunlightStatus } from "./sunlightLayer";
import { lightPackage, sunlightPackage } from "./usd";
import type { ExportFrame, UsdPackage } from "../../lib/usd";
import type { SunlightSettings } from "./index";

export interface SunlightMountHooks {
  onStatus?: (status: SunlightStatus) => void;
}

export interface SunlightMount extends LayerMount<SunlightSettings> {
  /** The index at a point, for the drawn result. */
  probe(lng: number, lat: number): Promise<ProbeResult>;
  /** The near grid as a GeoTIFF, or `null` when there is nothing to export. */
  exportGeoTiff(): Promise<Blob | null>;
  /** The near grid as a USD package. See `src/lib/usd/specs/spec.md`. */
  exportUsd(frame: ExportFrame): Promise<UsdPackage>;
  /** The scene's light: a `DomeLight` package, with the set sun as metadata. */
  exportLightUsd(frame: ExportFrame): Promise<UsdPackage>;
}

/**
 * The direct-sun layer attached to a map. It owns the `sunlight.lpi` node, so
 * it is mounted before anything that derives from it. See *The LPI node* and
 * *The GeoLibre records* in `specs/spec.md`, and `src/lib/mount/specs/spec.md`.
 */
export function mountSunlight(
  { map, graph }: MountContext,
  sources: { trees: TreeSource; buildings: BuildingSource },
  initial: SunlightSettings,
  hooks: SunlightMountHooks = {},
): SunlightMount {
  graph.add(LPI_NODE, []);
  const sunlight = new ThreeSunlightLayer(graph, sources);
  sunlight.onStatus = (status) => hooks.onStatus?.(status);
  // Visibility reaches the layer in `update`, not through the bridge: the
  // record follows demand, and the bridge would hide a layer a dependent needs.
  const native = nativeLayer(map, SUNLIGHT_LAYER_ID, sunlight, {
    setOpacity: (opacity) => sunlight.setOpacity(opacity),
    setVisibility: () => {},
  });
  let settings: SunlightSettings | null = null;

  const update = (next: SunlightSettings) => {
    // Drawn visibility also sets the node's own demand, which every record's
    // visibility then reads; the host applies all updates before any sync.
    sunlight.setVisibility(next.visible);
    // A new sun is a new pass.
    if (changed(settings, next, "sunTime")) sunlight.setSunTime(next.sunTime);
    settings = next;
  };
  update(initial);

  return {
    update,
    prepareSync() {
      native.ensureAdded();
      return [sunlightRecord(settings!, graph.demanded(LPI_NODE))];
    },
    probe: (lng, lat) => sunlight.probe(lng, lat),
    exportGeoTiff: () => sunlight.exportGeoTiff(),
    exportUsd: (frame) =>
      sunlight
        .exportFrame(frame)
        .then((read) => sunlightPackage(read, frame, [sources.trees.attribution, sources.buildings.attribution])),
    // No tiles, no GPU, and not gated on the overlay.
    exportLightUsd: (frame) => Promise.resolve(lightPackage(frame, settings!.sunTime)),
    dispose() {
      native.dispose();
      sunlight.dispose();
    },
  };
}
