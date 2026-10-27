import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

/**
 * Test support: the part of a MapLibre map a mount touches before MapLibre
 * calls `onAdd`, which this never does. So no GL context is ever needed.
 */
export interface FakeMap {
  map: MapLibreMap;
  /** Custom layers currently on the "style", by id. */
  layers: Map<string, CustomLayerInterface>;
  /** Every `addLayer`, in order. */
  added: string[];
  /** Handlers currently registered with `on`, by event type. */
  listeners: Map<string, Set<unknown>>;
  /** What `setStyle` does to custom layers: they are gone. */
  resetStyle(): void;
}

export function fakeMap(): FakeMap {
  const layers = new Map<string, CustomLayerInterface>();
  const added: string[] = [];
  const listeners = new Map<string, Set<unknown>>();
  const map = {
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: CustomLayerInterface) => {
      layers.set(layer.id, layer);
      added.push(layer.id);
    },
    on: (type: string, fn: unknown) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
      return map;
    },
    off: (type: string, fn: unknown) => {
      listeners.get(type)?.delete(fn);
      return map;
    },
    triggerRepaint: () => {},
    getZoom: () => 16,
    getCenter: () => ({ lng: 121.5608, lat: 25.0345 }),
  };
  return {
    map: map as unknown as MapLibreMap,
    layers,
    added,
    listeners,
    resetStyle: () => layers.clear(),
  };
}
