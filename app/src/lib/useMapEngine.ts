import { useCallback, useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, config as maplibreConfig, type ErrorEvent } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { createLayerSync, installMapTransformCompat, type LayerSync } from "@geolibre/map";
import { anchorUnderLabels, hideBasemapBuildings, type Basemap } from "../layers/basemaps";
import { BUILDINGS_STYLE_LAYER_IDS, buildingsLayer, type BuildingSettings } from "../layers/buildings";
import { mountTree, type ModelStatus, type TreeMount, type TreeSettings } from "../layers/tree";
import {
  mountSunlight,
  type ProbeResult,
  type SunlightMount,
  type SunlightSettings,
  type SunlightStatus,
} from "../layers/sunlight";
import {
  mountTemperature,
  type PetProbe,
  type TemperatureMount,
  type TemperatureSettings,
  type TemperatureStatus,
} from "../layers/temperature";
import {
  AO_NATIVE_LAYER_ID,
  mountAmbientOcclusion,
  type AmbientOcclusionMount,
  type AmbientOcclusionSettings,
  type AoState,
  type ShadedExtrusion,
} from "../layers/ambient-occlusion";
import { createGraph } from "./dag";
import { BUILDINGS, TREES } from "../sources";
import { PLACE } from "../place";
import type { Viewpoint } from "./place";

// MapLibre derives its worker URL from its own module URL and the worker then
// imports a sibling chunk. Neither survives bundling, so point it at a worker
// Vite bundles for us — otherwise no tile is ever parsed and the map is blank.
maplibreConfig.WORKER_URL = maplibreWorkerUrl;

// GeoLibre ships a compatibility shim for MapLibre's removed `Map#transform`.
// It must run before the first Map is constructed, hence module scope.
installMapTransformCompat();

/** What ambient occlusion must match: the extrusion this app draws is the buildings. */
const shadedExtrusion = ({ visible, heightScale, minHeight }: BuildingSettings): ShadedExtrusion => ({
  visible,
  heightScale,
  minHeight,
});

/** The layers this app mounts. Each folder owns its own lifecycle. */
interface Mounts {
  ao: AmbientOcclusionMount;
  sunlight: SunlightMount;
  temperature: TemperatureMount;
  tree: TreeMount;
}

export interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export function useMapEngine(
  basemap: Basemap,
  settings: BuildingSettings,
  treeSettings: TreeSettings,
  sunlightSettings: SunlightSettings,
  aoSettings: AmbientOcclusionSettings,
  temperatureSettings: TemperatureSettings,
  onProbe: (result: ProbeResult) => void,
  onTemperatureProbe: (result: PetProbe) => void,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const syncRef = useRef<LayerSync | null>(null);
  const mountsRef = useRef<Mounts | null>(null);
  // The settings live in refs so that `applyLayers` can stay a stable callback
  // and still be called from the `style.load` handler, registered once.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onProbeRef = useRef(onProbe);
  onProbeRef.current = onProbe;
  const onTemperatureProbeRef = useRef(onTemperatureProbe);
  onTemperatureProbeRef.current = onTemperatureProbe;
  const sunlightVisibleRef = useRef(sunlightSettings.visible);
  sunlightVisibleRef.current = sunlightSettings.visible;
  const temperatureVisibleRef = useRef(temperatureSettings.visible);
  temperatureVisibleRef.current = temperatureSettings.visible;
  // The first mount's settings; every later change reaches the mounts through
  // `update`, in the effect below.
  const initialRef = useRef({ treeSettings, sunlightSettings, aoSettings, temperatureSettings });
  // `map.isStyleLoaded()` is false until every source settles, which is long
  // after the style itself is usable; track the style.load event instead.
  const styleReadyRef = useRef(false);
  // The records last synced. `sync` re-applies every layer, so an unchanged
  // list — a sun-time step, say — is not synced again.
  const syncedRef = useRef<string | null>(null);

  const [camera, setCamera] = useState<Camera>({
    lng: PLACE.home.center[0],
    lat: PLACE.home.center[1],
    zoom: PLACE.home.zoom,
    pitch: PLACE.home.pitch,
    bearing: PLACE.home.bearing,
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Nothing is fetched until the modelled source is first chosen, so this stays
  // all-zero — and the panel stays quiet about it — for a procedural session.
  const [modelStatus, setModelStatus] = useState<ModelStatus>({
    loaded: 0,
    failed: 0,
    total: 0,
  });
  const [sunlightStatus, setSunlightStatus] = useState<SunlightStatus | null>(null);
  const [aoState, setAoState] = useState<AoState>("off");
  const [temperatureStatus, setTemperatureStatus] = useState<TemperatureStatus | null>(null);

  /** Push the current GeoLibre layer list at the map and re-anchor it. */
  const applyLayers = useCallback(() => {
    const map = mapRef.current;
    const sync = syncRef.current;
    const mounts = mountsRef.current;
    if (!map || !sync || !mounts || !styleReadyRef.current) return;
    // Later entries end up higher in the stack. Ambient occlusion multiplies
    // over the extrusions and the ground right after they are drawn, so
    // nothing above it — overlays, circles, meshes — is darkened. The PET
    // overlay sits right above the direct-sun one, and the tree circles and
    // meshes above both.
    const records = [
      buildingsLayer(settingsRef.current, BUILDINGS),
      ...mounts.ao.prepareSync(),
      ...mounts.sunlight.prepareSync(),
      ...mounts.temperature.prepareSync(),
      ...mounts.tree.prepareSync(),
    ];
    const key = JSON.stringify(records);
    if (key === syncedRef.current) return;
    syncedRef.current = key;
    sync.sync(records);
    // `createLayerSync` always appends on top, which is what we want by
    // default; only drop below the labels when the user asks for it.
    if (settingsRef.current.labelsOnTop) {
      // The occlusion goes with the buildings, so labels stay undarkened.
      anchorUnderLabels(map, [...BUILDINGS_STYLE_LAYER_IDS, AO_NATIVE_LAYER_ID]);
    }
  }, []);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: basemap.styleUrl,
      center: PLACE.home.center,
      zoom: PLACE.home.zoom,
      pitch: PLACE.home.pitch,
      bearing: PLACE.home.bearing,
      maxPitch: 85,
      canvasContextAttributes: { antialias: true, powerPreference: "high-performance" },
      attributionControl: false, // the custom status bar carries attribution
    });
    mapRef.current = map;
    syncRef.current = createLayerSync(map);

    // One derived-layer DAG per map. Each mount adds its own node, so the
    // order is dependency order: temperature derives from sunlight.
    const ctx = { map, graph: createGraph() };
    const initial = initialRef.current;
    const mounts: Mounts = {
      ao: mountAmbientOcclusion(
        ctx,
        { buildings: BUILDINGS },
        { ao: initial.aoSettings, extrusion: shadedExtrusion(settingsRef.current) },
        { onStatus: setAoState },
      ),
      sunlight: mountSunlight(ctx, { trees: TREES, buildings: BUILDINGS }, initial.sunlightSettings, {
        onStatus: setSunlightStatus,
      }),
      temperature: mountTemperature(ctx, initial.temperatureSettings, { onStatus: setTemperatureStatus }),
      tree: mountTree(ctx, { trees: TREES }, initial.treeSettings, { onModelStatus: setModelStatus }),
    };
    mountsRef.current = mounts;
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: MapLibreMap }).__map = map;
    }

    const onStyleLoad = () => {
      styleReadyRef.current = true;
      // setStyle wiped every layer, so whatever was synced before is gone.
      syncedRef.current = null;
      hideBasemapBuildings(map);
      try {
        map.setLight({
          anchor: "viewport",
          color: "#ffffff",
          intensity: 0.35,
          position: [1.4, 210, 38],
        });
      } catch {
        /* older/newer style spec — extrusions still render */
      }
      // Each mount re-adds its custom layer, which setStyle destroyed, before
      // the sync that moves it.
      applyLayers();
      setReady(true);
    };

    const onMove = () => {
      const c = map.getCenter();
      setCamera({
        lng: c.lng,
        lat: c.lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      });
    };

    // A click probes each overlay that is on; with both off it does nothing.
    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      const { lng, lat } = e.lngLat;
      if (sunlightVisibleRef.current) mounts.sunlight.probe(lng, lat).then((r) => onProbeRef.current(r));
      if (temperatureVisibleRef.current) {
        mounts.temperature.probe(lng, lat).then((r) => onTemperatureProbeRef.current(r));
      }
    };

    map.on("style.load", onStyleLoad);
    map.on("move", onMove);
    map.on("click", onClick);
    map.on("error", (e: ErrorEvent) => {
      const message = e.error?.message;
      if (message) setError(message);
    });

    return () => {
      syncRef.current?.dispose();
      syncRef.current = null;
      // Reverse mount order: downstream first, so nothing samples the
      // sunlight targets as they go.
      mounts.tree.dispose();
      mounts.temperature.dispose();
      mounts.sunlight.dispose();
      mounts.ao.dispose();
      mountsRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; basemap swaps go through setStyle below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap swap: setStyle wipes the style, so style.load re-runs applyLayers.
  const basemapUrl = basemap.styleUrl;
  const firstStyle = useRef(basemapUrl);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || basemapUrl === firstStyle.current) return;
    firstStyle.current = basemapUrl;
    styleReadyRef.current = false;
    setReady(false);
    map.setStyle(basemapUrl);
  }, [basemapUrl]);

  // Any control change: every mount takes its settings first — one layer's
  // may change another's records, through the DAG's demand — then one sync.
  useEffect(() => {
    const mounts = mountsRef.current;
    if (mounts) {
      mounts.ao.update({ ao: aoSettings, extrusion: shadedExtrusion(settings) });
      mounts.sunlight.update(sunlightSettings);
      mounts.temperature.update(temperatureSettings);
      mounts.tree.update(treeSettings);
    }
    applyLayers();
  }, [applyLayers, settings, treeSettings, sunlightSettings, aoSettings, temperatureSettings]);

  const exportSunlight = useCallback(
    (): Promise<Blob | null> => mountsRef.current?.sunlight.exportGeoTiff() ?? Promise.resolve(null),
    [],
  );

  const exportTemperature = useCallback(
    (): Promise<Blob | null> => mountsRef.current?.temperature.exportGeoTiff() ?? Promise.resolve(null),
    [],
  );

  const flyTo = useCallback((view: Viewpoint) => {
    mapRef.current?.flyTo({
      center: view.center,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing,
      duration: 2200,
      curve: 1.5,
      essential: true,
    });
  }, []);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ zoom: map.getZoom() + delta, duration: 260 });
  }, []);

  const setPitch = useCallback((pitch: number) => {
    mapRef.current?.setPitch(pitch);
  }, []);

  const setBearing = useCallback((bearing: number) => {
    mapRef.current?.setBearing(bearing);
  }, []);

  const resetNorth = useCallback(() => {
    mapRef.current?.easeTo({ bearing: 0, duration: 420 });
  }, []);

  return {
    containerRef,
    camera,
    ready,
    error,
    modelStatus,
    sunlightStatus,
    aoState,
    temperatureStatus,
    exportSunlight,
    exportTemperature,
    flyTo,
    zoomBy,
    setPitch,
    setBearing,
    resetNorth,
  };
}
