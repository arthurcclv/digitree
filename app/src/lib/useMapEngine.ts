import { useCallback, useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, config as maplibreConfig, type ErrorEvent } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { createLayerSync, installMapTransformCompat, type LayerSync } from "@geolibre/map";
import {
  clearExternalNativePaintBridge,
  setExternalNativePaintBridge,
} from "@geolibre/core";
import { anchorUnderLabels, hideBasemapBuildings, type Basemap } from "../layers/basemaps";
import { BUILDINGS_STYLE_LAYER_IDS, buildingsLayer, type BuildingSettings } from "../layers/buildings";
import {
  ThreeTreeLayer,
  TREE_LAYER_ID,
  TREE_NATIVE_LAYER_ID,
  treeMeshRecord,
  treePointsLayer,
  type ModelStatus,
  type TreeSettings,
} from "../layers/tree";
import {
  SUNLIGHT_LAYER_ID,
  SUNLIGHT_NATIVE_LAYER_ID,
  sunlightRecord,
  ThreeSunlightLayer,
  type ProbeResult,
  type SunlightSettings,
  type SunlightStatus,
} from "../layers/sunlight";

// MapLibre derives its worker URL from its own module URL and the worker then
// imports a sibling chunk. Neither survives bundling, so point it at a worker
// Vite bundles for us — otherwise no tile is ever parsed and the map is blank.
maplibreConfig.WORKER_URL = maplibreWorkerUrl;

// GeoLibre ships a compatibility shim for MapLibre's removed `Map#transform`.
// It must run before the first Map is constructed, hence module scope.
installMapTransformCompat();

export interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface Viewpoint {
  id: string;
  label: string;
  sub: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export const HOME: Viewpoint = {
  id: "xinyi",
  label: "Xinyi",
  sub: "信義 · Taipei 101",
  center: [121.5608, 25.0345],
  zoom: 15.4,
  pitch: 66,
  bearing: -28,
};

export function useMapEngine(
  basemap: Basemap,
  settings: BuildingSettings,
  treeSettings: TreeSettings,
  sunlightSettings: SunlightSettings,
  onProbe: (result: ProbeResult) => void,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const syncRef = useRef<LayerSync | null>(null);
  const treeRef = useRef<ThreeTreeLayer | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const treeSettingsRef = useRef(treeSettings);
  treeSettingsRef.current = treeSettings;
  const sunlightRef = useRef<ThreeSunlightLayer | null>(null);
  const sunlightSettingsRef = useRef(sunlightSettings);
  sunlightSettingsRef.current = sunlightSettings;
  const onProbeRef = useRef(onProbe);
  onProbeRef.current = onProbe;
  // `map.isStyleLoaded()` is false until every source settles, which is long
  // after the style itself is usable; track the style.load event instead.
  const styleReadyRef = useRef(false);

  const [camera, setCamera] = useState<Camera>({
    lng: HOME.center[0],
    lat: HOME.center[1],
    zoom: HOME.zoom,
    pitch: HOME.pitch,
    bearing: HOME.bearing,
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

  /** Push the current GeoLibre layer list at the map and re-anchor it. */
  const applyLayers = useCallback(() => {
    const map = mapRef.current;
    const sync = syncRef.current;
    if (!map || !sync || !styleReadyRef.current) return;
    // The three.js layer rides in the same sync call as the buildings: its
    // record is marked as an external custom layer, so GeoLibre moves and shows
    // the native layer we added rather than trying to create or paint it.
    // Later entries end up higher in the stack, so the meshes sit above the
    // tree circles and both above the extrusions. The mesh layer reads its data
    // back out of the source this same call creates for `tree-points`. The
    // sunlight overlay sits between the extrusions and the circles; it fetches
    // its own tiles, so it depends on neither source being shown.
    sync.sync([
      buildingsLayer(settingsRef.current),
      sunlightRecord(sunlightSettingsRef.current),
      treePointsLayer(treeSettingsRef.current),
      treeMeshRecord(treeSettingsRef.current),
    ]);
    // `createLayerSync` always appends on top, which is what we want by
    // default; only drop below the labels when the user asks for it.
    if (settingsRef.current.labelsOnTop) {
      anchorUnderLabels(map, BUILDINGS_STYLE_LAYER_IDS);
    }
  }, []);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: basemap.styleUrl,
      center: HOME.center,
      zoom: HOME.zoom,
      pitch: HOME.pitch,
      bearing: HOME.bearing,
      maxPitch: 85,
      canvasContextAttributes: { antialias: true, powerPreference: "high-performance" },
      attributionControl: false, // the custom status bar carries attribution
    });
    mapRef.current = map;
    syncRef.current = createLayerSync(map);

    const tree = new ThreeTreeLayer();
    treeRef.current = tree;
    // Models arrive one at a time, long after the switch that asked for them.
    tree.onModelsChanged = () => setModelStatus(tree.modelStatus());
    // Route GeoLibre's generic opacity and visibility controls into three.js.
    setExternalNativePaintBridge(TREE_LAYER_ID, {
      setOpacity: (opacity) => tree.setOpacity(opacity),
      setVisibility: (visible) => tree.setVisibility(visible),
    });
    const sunlight = new ThreeSunlightLayer();
    sunlightRef.current = sunlight;
    sunlight.setSunTime(sunlightSettingsRef.current.sunTime);
    sunlight.onStatus = setSunlightStatus;
    setExternalNativePaintBridge(SUNLIGHT_LAYER_ID, {
      setOpacity: (opacity) => sunlight.setOpacity(opacity),
      setVisibility: (visible) => sunlight.setVisibility(visible),
    });
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: MapLibreMap }).__map = map;
    }

    const onStyleLoad = () => {
      styleReadyRef.current = true;
      hideBasemapBuildings(map);
      // setStyle destroys custom layers, and GeoLibre's sync only moves native
      // layers that already exist — so re-add ours before every sync.
      if (!map.getLayer(TREE_NATIVE_LAYER_ID) && treeRef.current) {
        map.addLayer(treeRef.current);
      }
      if (!map.getLayer(SUNLIGHT_NATIVE_LAYER_ID) && sunlightRef.current) {
        map.addLayer(sunlightRef.current);
      }
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

    // A click probes the overlay; with the overlay off it does nothing.
    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      const layer = sunlightRef.current;
      if (!layer || !sunlightSettingsRef.current.visible) return;
      layer.probe(e.lngLat.lng, e.lngLat.lat).then((r) => onProbeRef.current(r));
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
      clearExternalNativePaintBridge(TREE_LAYER_ID);
      tree.dispose();
      treeRef.current = null;
      clearExternalNativePaintBridge(SUNLIGHT_LAYER_ID);
      sunlight.dispose();
      sunlightRef.current = null;
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

  // Any control change re-describes the layers and diff-syncs them.
  useEffect(() => {
    applyLayers();
  }, [applyLayers, settings, treeSettings, sunlightSettings.visible, sunlightSettings.opacity]);

  // The sun time is the sunlight layer's own control; a new sun is a new pass.
  useEffect(() => {
    sunlightRef.current?.setSunTime(sunlightSettings.sunTime);
  }, [sunlightSettings.sunTime]);

  const exportSunlight = useCallback(
    (): Promise<Blob | null> => sunlightRef.current?.exportGeoTiff() ?? Promise.resolve(null),
    [],
  );

  // Height exaggeration is the app's own control, not something GeoLibre models.
  useEffect(() => {
    treeRef.current?.setHeightScale(treeSettings.heightScale);
  }, [treeSettings.heightScale]);

  // The kind filter reaches the circles through the record, but GeoLibre cannot
  // filter the custom layer — so the mesh layer is told separately.
  useEffect(() => {
    treeRef.current?.setKind(treeSettings.kind);
  }, [treeSettings.kind]);

  // Which geometry the meshes draw is not a GeoLibre concept either, and the
  // circles are the same circles under either source — so this reaches exactly
  // one of the two halves, on purpose.
  useEffect(() => {
    treeRef.current?.setMeshSource(treeSettings.meshSource);
  }, [treeSettings.meshSource]);

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
    exportSunlight,
    flyTo,
    zoomBy,
    setPitch,
    setBearing,
    resetNorth,
  };
}
