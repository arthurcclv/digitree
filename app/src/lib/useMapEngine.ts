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
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const syncRef = useRef<LayerSync | null>(null);
  const treeRef = useRef<ThreeTreeLayer | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const treeSettingsRef = useRef(treeSettings);
  treeSettingsRef.current = treeSettings;
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
    // back out of the source this same call creates for `tree-points`.
    sync.sync([
      buildingsLayer(settingsRef.current),
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

    map.on("style.load", onStyleLoad);
    map.on("move", onMove);
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
  }, [applyLayers, settings, treeSettings]);

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
    flyTo,
    zoomBy,
    setPitch,
    setBearing,
    resetNorth,
  };
}
