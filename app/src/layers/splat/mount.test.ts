import * as THREE from "three";
import { describe, expect, test, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { getExternalNativePaintBridge } from "@geolibre/core";
import { createGraph } from "../../lib/dag";
import { fakeMap } from "../../lib/mount/fakeMap";
import { ThreeLayer } from "../../lib/three";
import { lngLatToMercator, metreInMercator, planTiles, tileKey, trueMetreAxes, type TileId, type TileSource } from "../../lib/tiles";
import fixtures from "../../lib/three/mainMatrix.fixtures.json";
import {
  SPLAT_FETCH_HALF_M,
  SPLAT_KEEP_M,
  SPLAT_LAYER_ID,
  SPLAT_MAX_CAPTURES,
  SPLAT_NATIVE_LAYER_ID,
  SPLAT_REBASE_M,
} from "./constants";
import { DEFAULT_SPLAT_SETTINGS, type SplatSettings } from "./index";
import { mountSplat } from "./mount";
import { splatRecord } from "./records";
import type { Splat, SplatSource } from "./schema";
import type { Residency } from "./residency";
import { ThreeSplatLayer, type SplatLayerDeps } from "./splatLayer";
import type { SplatStatus } from "./state";

const SOURCE: SplatSource = {
  tiles: "/tiles/splats/{z}/{x}/{y}",
  sourceLayer: "splats",
  files: "/files/3dgs/",
  lodFiles: "/files/3dgs-lod/",
  attribution: "",
  name: "",
  sharedGroundZ: 10,
};
const SHOWN: SplatSettings = { ...DEFAULT_SPLAT_SETTINGS, visible: true };

const splat = (id: string, lng: number, lat: number): Splat => ({
  id,
  file: `${id}.ply`,
  lngLat: [lng, lat],
  groundZ: 0,
  headingDeg: 0,
  scale: 1,
  bytes: 1,
});

/**
 * Spark's dyno, evaluated on the CPU: a block runs its construct on plain
 * values, so a world modifier can be applied to a point in a test.
 */
type V3 = THREE.Vector3 | { value: THREE.Vector3 };
const v3 = (v: V3) => (v instanceof THREE.Vector3 ? v : v.value);
const fakeDyno = {
  Gsplat: { type: "Gsplat" },
  DynoVec3: class {
    value: THREE.Vector3;
    constructor({ value }: { value: THREE.Vector3 }) {
      this.value = value;
    }
  },
  dynoBlock: (_in: unknown, _out: unknown, construct: (i: { gsplat: { center: THREE.Vector3 } }) => unknown) => ({
    apply: (inputs: { gsplat: { center: THREE.Vector3 } }) => construct(inputs),
  }),
  splitGsplat: (g: { center: THREE.Vector3 }) => ({ outputs: { center: g.center } }),
  combineGsplat: ({ gsplat, center }: { gsplat: object; center: THREE.Vector3 }) => ({ ...gsplat, center }),
  add: (a: V3, b: V3) => v3(a).clone().add(v3(b)),
  sub: (a: V3, b: V3) => v3(a).clone().sub(v3(b)),
  mul: (a: V3, b: V3) => v3(a).clone().multiply(v3(b)),
};

interface FakeModifier {
  apply: (i: { gsplat: { center: THREE.Vector3 } }) => { gsplat: { center: THREE.Vector3 } };
}

/** A world point through a mesh's world modifier, as Spark's generator does. */
const modified = (mesh: THREE.Object3D, p: THREE.Vector3) =>
  (mesh as unknown as { worldModifier: FakeModifier }).worldModifier.apply({ gsplat: { center: p } }).gsplat.center;

/** Spark, stubbed: meshes resolve or reject by URL, and nothing touches GL. */
function fakeSpark(failing: string[] = []) {
  const urls: string[] = [];
  const meshOptions: Record<string, unknown>[] = [];
  const rendererOptions: Record<string, unknown>[] = [];
  const resolvers: (() => void)[] = [];
  class SplatMesh extends THREE.Object3D {
    opacity = 1;
    initialized: Promise<SplatMesh>;
    dispose = vi.fn();
    updateVersion = vi.fn();
    worldModifier: unknown;
    constructor(options: { url: string; worldModifier?: unknown }) {
      super();
      const { url } = options;
      urls.push(url);
      meshOptions.push(options);
      this.worldModifier = options.worldModifier;
      this.initialized = new Promise((resolve, reject) =>
        resolvers.push(() => (failing.some((f) => url.endsWith(f)) ? reject(new Error(`HTTP 404 ${url}`)) : resolve(this))),
      );
    }
  }
  class SparkRenderer extends THREE.Object3D {
    dispose = vi.fn();
    lodSplatCount: number | undefined;
    lodSplatScale: number;
    constructor(options: { lodSplatCount?: number; lodSplatScale?: number }) {
      super();
      rendererOptions.push(options);
      this.lodSplatCount = options.lodSplatCount;
      this.lodSplatScale = options.lodSplatScale ?? 1;
    }
    defaultSplatTarget() {
      return 2_500_000;
    }
  }
  return {
    module: { SplatMesh, SparkRenderer, dyno: fakeDyno } as unknown as typeof import("@sparkjsdev/spark"),
    urls,
    meshOptions,
    rendererOptions,
    /** Finish the oldest pending load. */
    finishNext: async () => {
      resolvers.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** A layer that never makes WebGL. It keeps the camera of the last draw. */
class TestSplatLayer extends ThreeSplatLayer {
  drawn: { scene: THREE.Scene; camera: THREE.Camera } | null = null;
  protected createRenderer(): THREE.WebGLRenderer {
    return {
      dispose() {},
      resetState() {},
      render: (scene: THREE.Scene, camera: THREE.Camera) => (this.drawn = { scene, camera }),
    } as unknown as THREE.WebGLRenderer;
  }
}

/** Tiles decoded from a table instead of MVT, and a fetch that counts. */
function deps(byTile: Record<string, Splat[]>, spark = fakeSpark()) {
  const fetched: string[] = [];
  const importSpark = vi.fn(async () => spark.module);
  const d: Partial<SplatLayerDeps> = {
    importSpark,
    fetchFn: (async (url: string) => {
      fetched.push(url);
      return new Response(new ArrayBuffer(1));
    }) as typeof fetch,
    footprint: () => [
      [121.538, 25.038],
      [121.54, 25.038],
      [121.54, 25.039],
      [121.538, 25.039],
    ],
    tiles: (): TileSource<Splat> => ({
      location: { tiles: SOURCE.tiles },
      decode: (_buf: ArrayBuffer, t: TileId) => byTile[tileKey(t)] ?? [],
    }),
  };
  return { d, fetched, importSpark, spark };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

type FakeMesh = THREE.Object3D & { opacity: number; dispose: () => void };

/** The layer's loaded meshes, by capture id, through its `Residency`. */
const loadedOf = (layer: ThreeSplatLayer): Map<string, { mesh: FakeMesh }> =>
  new Map((layer as unknown as { residency: Residency<{ mesh: FakeMesh }> }).residency.held().map((h) => [h.splat.id, h.value]));

function attached(zoom = 16, centre = { lng: 121.539, lat: 25.0386 }) {
  const f = fakeMap();
  const map = { ...(f.map as unknown as Record<string, unknown>), getZoom: () => zoom, getCenter: () => centre };
  return { f, map: map as unknown as MapLibreMap };
}

describe("mountSplat", () => {
  // A new member is how a host would push layer-specific state in (a setter);
  // it means changing the factory table in the mount spec first.
  test("exposes exactly its members", () => {
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, DEFAULT_SPLAT_SETTINGS);
    expect(Object.keys(m).sort()).toEqual(["dispose", "prepareSync", "update"]);
    m.dispose();
  });

  test("syncs the record the builder makes", () => {
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, DEFAULT_SPLAT_SETTINGS);
    expect(m.prepareSync()).toEqual([splatRecord(DEFAULT_SPLAT_SETTINGS)]);
    m.update(SHOWN);
    expect(m.prepareSync()[0].visible).toBe(true);
    m.dispose();
  });

  test("adds the custom layer, and re-adds it after a style reset", () => {
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, DEFAULT_SPLAT_SETTINGS);
    m.prepareSync();
    f.resetStyle();
    m.prepareSync();
    expect(f.added).toEqual([SPLAT_NATIVE_LAYER_ID, SPLAT_NATIVE_LAYER_ID]);
    m.dispose();
  });

  test("registers the paint bridge on mount and clears it on dispose", () => {
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, DEFAULT_SPLAT_SETTINGS);
    expect(getExternalNativePaintBridge(SPLAT_LAYER_ID)).toBeDefined();
    m.dispose();
    expect(getExternalNativePaintBridge(SPLAT_LAYER_ID)).toBeUndefined();
  });

  test("pushes the LoD budget only when it changed", () => {
    const setLod = vi.spyOn(ThreeSplatLayer.prototype, "setLod");
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, DEFAULT_SPLAT_SETTINGS);
    expect(setLod).toHaveBeenCalledWith(null, 1);
    setLod.mockClear();
    m.update({ ...DEFAULT_SPLAT_SETTINGS, opacity: 0.5, visible: true });
    expect(setLod).not.toHaveBeenCalled();
    m.update({ ...DEFAULT_SPLAT_SETTINGS, lodSplatCount: 1_000_000 });
    expect(setLod).toHaveBeenCalledWith(1_000_000, 1);
    m.update({ ...DEFAULT_SPLAT_SETTINGS, lodSplatCount: 1_000_000, lodSplatScale: 0.5 });
    expect(setLod).toHaveBeenLastCalledWith(1_000_000, 0.5);
    m.dispose();
    vi.restoreAllMocks();
  });

  test("pushes snapToGround only when it changed", () => {
    const setSnap = vi.spyOn(ThreeSplatLayer.prototype, "setSnapToGround");
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, DEFAULT_SPLAT_SETTINGS);
    expect(setSnap).toHaveBeenCalledWith(true);
    setSnap.mockClear();
    m.update({ ...DEFAULT_SPLAT_SETTINGS, opacity: 0.5, lodSplatScale: 2 });
    expect(setSnap).not.toHaveBeenCalled();
    m.update({ ...DEFAULT_SPLAT_SETTINGS, snapToGround: false });
    expect(setSnap).toHaveBeenCalledWith(false);
    m.dispose();
    vi.restoreAllMocks();
  });

  // `false` is not the layer's own default, so only the push can set it.
  test("pushes an initial snapToGround of false", () => {
    const setSnap = vi.spyOn(ThreeSplatLayer.prototype, "setSnapToGround");
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, {
      ...DEFAULT_SPLAT_SETTINGS,
      snapToGround: false,
    });
    expect(setSnap).toHaveBeenCalledExactlyOnceWith(false);
    m.dispose();
    vi.restoreAllMocks();
  });

  test("pushes the min zoom only when it changed, and visibility only through the bridge", () => {
    const setMinZoom = vi.spyOn(ThreeSplatLayer.prototype, "setMinZoom");
    const setVisibility = vi.spyOn(ThreeSplatLayer.prototype, "setVisibility");
    const f = fakeMap();
    const m = mountSplat({ map: f.map, graph: createGraph() }, { splats: SOURCE }, DEFAULT_SPLAT_SETTINGS);
    setMinZoom.mockClear();
    m.update(SHOWN);
    expect(setMinZoom).not.toHaveBeenCalled();
    expect(setVisibility).not.toHaveBeenCalled();
    m.update({ ...SHOWN, minZoom: 17 });
    expect(setMinZoom).toHaveBeenCalledWith(17);
    getExternalNativePaintBridge(SPLAT_LAYER_ID)!.setVisibility!(true);
    expect(setVisibility).toHaveBeenCalledWith(true);
    m.dispose();
    vi.restoreAllMocks();
  });
});

describe("ThreeSplatLayer", () => {
  // `src/lib/three/specs/spec.md`, invariant 8: no offscreen work, so no prerender.
  test("is a ThreeLayer, without a prerender", () => {
    expect(ThreeSplatLayer.prototype).toBeInstanceOf(ThreeLayer);
    expect("prerender" in ThreeSplatLayer.prototype).toBe(false);
  });

  test("fetches nothing and imports nothing while hidden", async () => {
    const { d, fetched, importSpark } = deps({});
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    await settle();
    expect(fetched).toEqual([]);
    expect(importSpark).not.toHaveBeenCalled();
    layer.dispose();
  });

  test("fetches nothing below the min zoom, even when shown", async () => {
    const { d, fetched } = deps({});
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached(14).map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    expect(fetched).toEqual([]);
    layer.dispose();
  });

  test("does not import Spark when the tiles hold no capture", async () => {
    const { d, fetched, importSpark } = deps({});
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.startsWith("/tiles/splats/14/"))).toBe(true);
    expect(importSpark).not.toHaveBeenCalled();
    layer.dispose();
  });

  test("loads captures one at a time, nearest first, keeps going past a failure, and reports it", async () => {
    const near = splat("near", 121.5391, 25.0386);
    const far = splat("far", 121.5399, 25.0389);
    const broken = splat("broken", 121.5395, 25.0387);
    const spark = fakeSpark(["broken-lod.rad"]);
    // The same capture in two tiles, as a point in a tile's buffer arrives.
    const { d } = deps({ "14/13723/7014": [far, near, broken], "14/13724/7014": [near] }, spark);
    const statuses: SplatStatus[] = [];
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onStatus = (s) => statuses.push(s);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();

    expect(spark.urls).toEqual(["/files/3dgs-lod/near-lod.rad"]);
    await spark.finishNext();
    expect(spark.urls).toEqual(["/files/3dgs-lod/near-lod.rad", "/files/3dgs-lod/broken-lod.rad"]);
    await spark.finishNext();
    await spark.finishNext();
    expect(spark.urls).toEqual([
      "/files/3dgs-lod/near-lod.rad",
      "/files/3dgs-lod/broken-lod.rad",
      "/files/3dgs-lod/far-lod.rad",
    ]);

    const last = statuses.at(-1)!;
    expect(last).toMatchObject({ state: "ready", known: 3, loaded: 2, loading: null });
    expect(last.errors.map((e) => e.id)).toEqual(["broken"]);
    layer.dispose();
  });

  test("applies opacity to every loaded capture, and to one loaded later", async () => {
    const spark = fakeSpark();
    const { d } = deps({ "14/13723/7014": [splat("a", 121.5391, 25.0386), splat("b", 121.5395, 25.0387)] }, spark);
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();
    await spark.finishNext();
    layer.setOpacity(0.4);
    await spark.finishNext();
    expect([...loadedOf(layer).values()].map((l) => l.mesh.opacity)).toEqual([0.4, 0.4]);
    layer.dispose();
  });

  // *The shared ground* in the spec.
  test("snapToGround re-places every loaded capture, and one loaded later, by z alone", async () => {
    const spark = fakeSpark();
    const a = { ...splat("a", 121.5391, 25.0386), groundZ: 25.2 };
    const b = { ...splat("b", 121.5395, 25.0387), groundZ: 26.1 };
    const { d } = deps({ "14/13723/7014": [a, b] }, spark);
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();
    await spark.finishNext();
    const position = (id: string) => new THREE.Vector3().setFromMatrixPosition(loadedOf(layer).get(id)!.mesh.matrix);
    const snapped = position("a");
    // Scale 1, and the anchor's latitude to ~1e-4°: k is 1 to about 1e-6.
    expect(snapped.z).toBeCloseTo(-25.2, 4);

    layer.setSnapToGround(false);
    const shared = position("a");
    expect(shared.z).toBeCloseTo(-SOURCE.sharedGroundZ, 4);
    expect([shared.x, shared.y]).toEqual([snapped.x, snapped.y]);

    await spark.finishNext();
    expect(position("b").z).toBeCloseTo(-SOURCE.sharedGroundZ, 4);

    layer.setSnapToGround(true);
    expect(position("a").z).toBeCloseTo(-25.2, 4);
    expect(position("b").z).toBeCloseTo(-26.1, 4);
    layer.dispose();
  });

  // *Level of detail* in the spec.
  test("draws each capture's paged LoD tree, with Spark's pool and cleanup timeout", async () => {
    const spark = fakeSpark();
    const { d } = deps({ "14/13723/7014": [splat("a", 121.5391, 25.0386)] }, spark);
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();
    await spark.finishNext();
    expect(spark.meshOptions).toEqual([{ url: "/files/3dgs-lod/a-lod.rad", paged: true, worldModifier: expect.anything() }]);
    expect(spark.rendererOptions).toHaveLength(1);
    expect(spark.rendererOptions[0]).toMatchObject({ enableLod: true });
    // Spark's defaults: the platform's page pool, and the 3 s after which an
    // unloaded or hidden capture's pages go back to it.
    expect(spark.rendererOptions[0]).not.toHaveProperty("maxPagedSplats");
    expect(spark.rendererOptions[0]).not.toHaveProperty("lodCleanupTimeoutMs");
    layer.dispose();
  });

  // *Settings*: a budget set before Spark loads is not lost, a later one
  // reaches the live renderer, and `null` is Spark's platform default.
  test("hands the LoD budget to Spark's renderer, before and after it exists", async () => {
    const spark = fakeSpark();
    const { d } = deps({ "14/13723/7014": [splat("a", 121.5391, 25.0386)] }, spark);
    const statuses: SplatStatus[] = [];
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onStatus = (s) => statuses.push(s);
    layer.setLod(1_500_000, 0.5);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();
    await spark.finishNext();
    expect(spark.rendererOptions[0]).toMatchObject({ lodSplatCount: 1_500_000, lodSplatScale: 0.5 });
    const live = (layer as unknown as { sparkRenderer: { lodSplatCount?: number; lodSplatScale: number } }).sparkRenderer;
    layer.setLod(null, 2);
    expect(live.lodSplatCount).toBeUndefined();
    expect(live.lodSplatScale).toBe(2);
    expect(statuses.at(-1)!.platformBudget).toBe(2_500_000);
    layer.dispose();
  });

  test("disposes its meshes and Spark's renderer", async () => {
    const spark = fakeSpark();
    const { d } = deps({ "14/13723/7014": [splat("a", 121.5391, 25.0386)] }, spark);
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();
    await spark.finishNext();
    const internals = layer as unknown as { sparkRenderer: { dispose: () => void } | null };
    const mesh = [...loadedOf(layer).values()][0].mesh;
    const renderer = internals.sparkRenderer!;
    layer.dispose();
    expect(mesh.dispose).toHaveBeenCalled();
    expect(renderer.dispose).toHaveBeenCalled();
  });

  test("dispose aborts a tile fetch still in flight", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { d } = deps({});
    // Never answers: the fetch is still in flight when the layer goes.
    d.fetchFn = ((_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onAdd(attached().map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s && !s.aborted)).toBe(true);
    layer.dispose();
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });

  // The whole chain, with nothing extra and nothing missing: points of a
  // capture, through the layer's projection, view and mesh matrices and the
  // mesh's world modifier, land where MapLibre's own mainMatrix puts them,
  // from the capture's lng/lat, ground, heading and scale alone. The
  // capture's metres are true (WGS 84) metres, drawn with the map's metres per
  // true metre on each axis.
  test.each(fixtures.captures.filter((_, i) => i % 3 === 0).map((c) => [`pitch ${c.view.pitch} bearing ${c.view.bearing}`, c] as const))(
    "draws a capture where MapLibre projects it: %s",
    async (_, c) => {
      // The spike's view centre, which the fixture's origin is the Mercator of.
      const centre = { lng: 121.5608, lat: 25.0345 };
      const s = { ...splat("a", 121.5611, 25.0347), groundZ: 24.5, headingDeg: 130, scale: 1.02 };
      const tile = tileKey({ ...lngLatToMercatorTile(s.lngLat), z: 14 });
      const spark = fakeSpark();
      const { d } = deps({ [tile]: [s] }, spark);
      const layer = new TestSplatLayer(SOURCE, d);
      layer.onAdd(attached(17.5, centre).map, {} as WebGL2RenderingContext);
      layer.setVisibility(true);
      await settle();
      await settle();
      await spark.finishNext();
      layer.render({} as WebGL2RenderingContext, { defaultProjectionData: { mainMatrix: c.mainMatrix } } as never);

      const { scene, camera } = layer.drawn!;
      // The capture's mesh, not Spark's renderer, which sits in the scene too.
      const mesh = scene.children.find((o) => "initialized" in o)!;
      scene.updateMatrixWorld();
      const main = new THREE.Matrix4().fromArray(c.mainMatrix);
      // A capture's metres are its own latitude's (*The frame*).
      const metre = metreInMercator(s.lngLat[1]);
      const axes = trueMetreAxes(s.lngLat[1]);
      const m = lngLatToMercator(s.lngLat[0], s.lngLat[1]);
      // The heading turns the capture's +y to (sin h, cos h) east/north, so its
      // +x is (cos h, −sin h); then the scale; then up is up.
      const h = (s.headingDeg * Math.PI) / 180;
      for (const [x, y, z] of [
        [0, 0, 0],
        [10, 4, 2],
        [-35, 60, 12],
      ]) {
        const world = modified(mesh, new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
        const ours = new THREE.Vector4(world.x, world.y, world.z, 1)
          .applyMatrix4(camera.matrixWorldInverse)
          .applyMatrix4(camera.projectionMatrix);
        const east = axes.east * s.scale * (x * Math.cos(h) + y * Math.sin(h));
        const north = axes.north * s.scale * (-x * Math.sin(h) + y * Math.cos(h));
        // Local z = groundZ is the map's ground.
        const up = s.scale * (z - s.groundZ);
        const theirs = new THREE.Vector4(m.x + east * metre, m.y - north * metre, up * metre, 1).applyMatrix4(main);
        expect(ours.x / ours.w).toBeCloseTo(theirs.x / theirs.w, 9);
        expect(ours.y / ours.w).toBeCloseTo(theirs.y / theirs.w, 9);
        expect(ours.z / ours.w).toBeCloseTo(theirs.z / theirs.w, 9);
      }
      // The two world matrices are each other's inverse, set once each.
      const id = camera.matrixWorld.clone().multiply(camera.matrixWorldInverse).elements;
      id.forEach((v, i) => expect(v).toBeCloseTo(new THREE.Matrix4().elements[i], 9));
      layer.dispose();
    },
  );
});

// The frame is fixed while navigating: Spark caches each mesh's world transform
// a tick after the draw, so a transform that moved per frame drew the captures
// at a stale origin against the live camera (*The frame*).
describe("ThreeSplatLayer frame", () => {
  async function loadedAt(centre: { lng: number; lat: number }) {
    const s = splat("a", centre.lng + 0.0003, centre.lat + 0.0002);
    const tile = tileKey({ ...lngLatToMercatorTile(s.lngLat), z: 14 });
    const spark = fakeSpark();
    const { d } = deps({ [tile]: [s] }, spark);
    const layer = new TestSplatLayer(SOURCE, d);
    const view = { centre };
    const { map } = attached(17.5, centre);
    (map as unknown as { getCenter: () => typeof centre }).getCenter = () => view.centre;
    layer.onAdd(map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();
    await spark.finishNext();
    const mesh = () => loadedOf(layer).get("a")!.mesh;
    const settled = () => (layer as unknown as { viewSettled: () => void }).viewSettled();
    const draw = () =>
      layer.render({} as WebGL2RenderingContext, { defaultProjectionData: { mainMatrix: fixtures.captures[0].mainMatrix } } as never);
    return { layer, view, mesh, settled, draw };
  }

  /** `metres` east of `centre`. */
  const east = (centre: { lng: number; lat: number }, metres: number) => ({
    lng: centre.lng + (metres / (40_075_016.686 * Math.cos((centre.lat * Math.PI) / 180))) * 360,
    lat: centre.lat,
  });

  test("a mesh's matrix does not change across draws at different centres; the camera does", async () => {
    const start = { lng: 121.5608, lat: 25.0345 };
    const { layer, view, mesh, draw } = await loadedAt(start);
    draw();
    const before = mesh().matrix.clone();
    const camera = layer.drawn!.camera.matrixWorld.clone();
    view.centre = { lng: 121.5640, lat: 25.0370 };
    draw();
    expect(mesh().matrix.equals(before)).toBe(true);
    // Same mainMatrix, so the camera moves only if the frame does. It does not:
    // only MapLibre's matrix moves the camera.
    expect(layer.drawn!.camera.matrixWorld.equals(camera)).toBe(true);
    layer.dispose();
  });

  // Both settle while hidden: shown, a capture this far from the centre is
  // unloaded (SPLAT_KEEP_M), and the rebase is for the captures loaded next.
  test("viewSettled moves the anchor past SPLAT_REBASE_M and not within it", async () => {
    const start = { lng: 121.5608, lat: 25.0345 };
    const { layer, view, mesh, settled } = await loadedAt(start);
    layer.setVisibility(false);
    const before = mesh().matrix.clone();
    view.centre = east(start, SPLAT_REBASE_M - 100);
    settled();
    expect(mesh().matrix.equals(before)).toBe(true);
    view.centre = east(start, SPLAT_REBASE_M + 100);
    settled();
    // Re-placed from the new anchor: ~20.1 km west of it.
    const x = new THREE.Vector3().setFromMatrixPosition(mesh().matrix).x;
    expect(x).toBeLessThan(-(SPLAT_REBASE_M - 100));
    layer.dispose();
  });

  test("after a rebase the capture still lands where MapLibre projects it", async () => {
    const start = { lng: 121.5608, lat: 25.0345 };
    const { layer, view, mesh, settled, draw } = await loadedAt(start);
    layer.setVisibility(false);
    view.centre = east(start, SPLAT_REBASE_M + 500);
    settled();
    layer.setVisibility(true);
    draw();
    const { camera } = layer.drawn!;
    mesh().updateMatrixWorld();
    const main = new THREE.Matrix4().fromArray(fixtures.captures[0].mainMatrix);
    const m = lngLatToMercator(start.lng + 0.0003, start.lat + 0.0002);
    const ours = new THREE.Vector4(0, 0, 0, 1)
      .applyMatrix4(mesh().matrixWorld)
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix);
    const theirs = new THREE.Vector4(m.x, m.y, 0, 1).applyMatrix4(main);
    expect(ours.x / ours.w).toBeCloseTo(theirs.x / theirs.w, 9);
    expect(ours.y / ours.w).toBeCloseTo(theirs.y / theirs.w, 9);
    expect(ours.z / ours.w).toBeCloseTo(theirs.z / theirs.w, 9);
    // And the stretch moved with it: 100 m east of the origin is still
    // `axes.east` map metres per true metre from it.
    const at = new THREE.Vector3().setFromMatrixPosition(mesh().matrixWorld);
    const p = modified(mesh(), new THREE.Vector3(100, 0, 0).applyMatrix4(mesh().matrixWorld));
    const k = metreInMercator(start.lat + 0.0002) / metreInMercator(view.centre.lat);
    expect(p.x - at.x).toBeCloseTo(100 * k * trueMetreAxes(start.lat + 0.0002).east, 6);
    expect(p.y - at.y).toBeCloseTo(0, 6);
    layer.dispose();
  });

  // *The frame*: Spark keeps one scale of a mesh's matrix, so the per-axis
  // part is a world modifier, about the capture's origin, at its latitude.
  test("each capture is stretched about its own origin by its latitude's axes", async () => {
    const start = { lng: 121.5608, lat: 25.0345 };
    const { layer, mesh } = await loadedAt(start);
    mesh().updateMatrixWorld();
    const at = new THREE.Vector3().setFromMatrixPosition(mesh().matrixWorld);
    const { east, north } = trueMetreAxes(start.lat + 0.0002);
    expect(modified(mesh(), at.clone()).distanceTo(at)).toBeLessThan(1e-9);
    const p = modified(mesh(), at.clone().add(new THREE.Vector3(10, 20, 3)));
    expect(p.x - at.x).toBeCloseTo(10 * east, 9);
    expect(p.y - at.y).toBeCloseTo(20 * north, 9);
    expect(p.z - at.z).toBeCloseTo(3, 9);
    // The modifier's origin is a uniform: Spark regenerates on a new version.
    expect((mesh() as unknown as { updateVersion: ReturnType<typeof vi.fn> }).updateVersion).toHaveBeenCalled();
    layer.dispose();
  });
});

// *Which captures load*: what is held is bounded by distance and by count.
describe("ThreeSplatLayer unloading", () => {
  const east = (centre: { lng: number; lat: number }, metres: number) => ({
    lng: centre.lng + (metres / (40_075_016.686 * Math.cos((centre.lat * Math.PI) / 180))) * 360,
    lat: centre.lat,
  });
  const internals = (layer: ThreeSplatLayer) =>
    layer as unknown as {
      scene: THREE.Scene;
      viewSettled: () => void;
    };

  async function shownAt(byTile: Record<string, Splat[]>, centre: { lng: number; lat: number }) {
    const spark = fakeSpark();
    const { d } = deps(byTile, spark);
    const statuses: SplatStatus[] = [];
    const layer = new TestSplatLayer(SOURCE, d);
    layer.onStatus = (s) => statuses.push(s);
    const view = { centre };
    const { map } = attached(17.5, centre);
    (map as unknown as { getCenter: () => typeof centre }).getCenter = () => view.centre;
    layer.onAdd(map, {} as WebGL2RenderingContext);
    layer.setVisibility(true);
    await settle();
    await settle();
    return { layer, spark, view, statuses };
  }

  test("a capture past SPLAT_KEEP_M is unloaded on a settled view, and loads again when its tile returns", async () => {
    const start = { lng: 121.539, lat: 25.0386 };
    const a = splat("a", 121.5391, 25.0386);
    const { layer, spark, view, statuses } = await shownAt({ "14/13723/7014": [a] }, start);
    await spark.finishNext();
    const mesh = loadedOf(layer).get("a")!.mesh;

    view.centre = east(start, SPLAT_KEEP_M - 100);
    internals(layer).viewSettled();
    expect(loadedOf(layer).has("a")).toBe(true);

    view.centre = east(start, SPLAT_KEEP_M + 100);
    internals(layer).viewSettled();
    expect(loadedOf(layer).has("a")).toBe(false);
    expect(mesh.dispose).toHaveBeenCalled();
    expect(internals(layer).scene.children).not.toContain(mesh);
    expect(statuses.at(-1)).toMatchObject({ known: 0, loaded: 0 });

    view.centre = start;
    internals(layer).viewSettled();
    await settle();
    await spark.finishNext();
    expect(spark.urls).toEqual(["/files/3dgs-lod/a-lod.rad", "/files/3dgs-lod/a-lod.rad"]);
    expect(statuses.at(-1)).toMatchObject({ known: 1, loaded: 1 });
    layer.dispose();
  });

  test("nothing is unloaded while hidden", async () => {
    const start = { lng: 121.539, lat: 25.0386 };
    const { layer, spark, view } = await shownAt({ "14/13723/7014": [splat("a", 121.5391, 25.0386)] }, start);
    await spark.finishNext();
    layer.setVisibility(false);
    view.centre = east(start, SPLAT_KEEP_M + 1000);
    internals(layer).viewSettled();
    expect(loadedOf(layer).has("a")).toBe(true);
    layer.dispose();
  });

  test("past SPLAT_MAX_CAPTURES a nearer capture unloads the farthest, and a farther one waits", async () => {
    // A row of captures 5 m apart, eastwards, all in one tile.
    const row = Array.from({ length: SPLAT_MAX_CAPTURES + 1 }, (_, i) =>
      splat(`c${String(i).padStart(3, "0")}`, 121.5385 + i * 0.00005, 25.0386),
    );
    const west = { lng: row[0].lngLat[0], lat: 25.0386 };
    const { layer, spark, view } = await shownAt({ "14/13723/7014": row }, west);
    for (let i = 0; i < SPLAT_MAX_CAPTURES; i++) await spark.finishNext();
    await settle();
    const ids = () => [...loadedOf(layer).keys()].sort();
    // The last, the farthest from the west end, waits.
    expect(ids()).toEqual(row.slice(0, SPLAT_MAX_CAPTURES).map((s) => s.id));
    expect(spark.urls).toHaveLength(SPLAT_MAX_CAPTURES);

    // From the east end it is the nearest, and the first is the farthest.
    view.centre = { lng: row.at(-1)!.lngLat[0], lat: 25.0386 };
    internals(layer).viewSettled();
    await settle();
    await spark.finishNext();
    await settle();
    expect(ids()).toEqual(row.slice(1).map((s) => s.id));
    expect(loadedOf(layer).size).toBe(SPLAT_MAX_CAPTURES);
    // The first is found again in the tile, and now waits in turn.
    expect(spark.urls).toHaveLength(SPLAT_MAX_CAPTURES + 1);
    layer.dispose();
  });

  // The keep radius must exceed the farthest a capture can load from, or one
  // just loaded at the edge would be unloaded on the next settle.
  test("SPLAT_KEEP_M exceeds the farthest planned tile, at any latitude the map shows captures", () => {
    for (const lat of [0, 25.04, 45, 60]) {
      const centre = lngLatToMercator(121.5, lat);
      const metre = metreInMercator(lat);
      // A footprint far larger than the fetch square: the clip decides.
      const d = 0.5;
      const huge: [number, number][] = [[121.5 - d, lat - d], [121.5 + d, lat - d], [121.5 + d, lat + d], [121.5 - d, lat + d]];
      let farthest = 0;
      for (const t of planTiles({ origin: centre, metre }, huge, SPLAT_FETCH_HALF_M)) {
        for (const [cx, cy] of [[t.x, t.y], [t.x + 1, t.y], [t.x, t.y + 1], [t.x + 1, t.y + 1]]) {
          const dist = Math.hypot(cx / 2 ** 14 - centre.x, cy / 2 ** 14 - centre.y) / metre;
          farthest = Math.max(farthest, dist);
        }
      }
      expect(farthest).toBeLessThan(SPLAT_KEEP_M);
    }
  });
});

function lngLatToMercatorTile([lng, lat]: [number, number]) {
  const p = lngLatToMercator(lng, lat);
  return { x: Math.floor(p.x * 2 ** 14), y: Math.floor(p.y * 2 ** 14) };
}
