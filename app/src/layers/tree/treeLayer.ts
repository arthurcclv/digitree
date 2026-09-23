import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";
import { sourceId } from "@geolibre/map/style-layer-ids";
import { TREES_SOURCE_LAYER, TREE_POINTS_LAYER_ID } from "./constants";

/** Mirrors `TreeKindFilter` in `index.ts`; kept local to avoid a module cycle. */
export type TreeKind = "all" | "street" | "park" | "custom";

/** The MapLibre style-layer id GeoLibre is told to manage on our behalf. */
export const TREE_NATIVE_LAYER_ID = "threejs-tree-native";

/** Height of the mesh as modelled, in metres; every instance scales from it. */
export const TREE_BASE_HEIGHT_M = 13;

/**
 * The inventory's median height. Used for the ~56 trees whose surveyed
 * `height_m` was missing or implausible — and nothing else is ever substituted.
 */
export const TREE_FALLBACK_HEIGHT_M = 9.1;

/** Below this the meshes are sub-pixel and the instance count explodes. */
export const TREE_MESH_MIN_ZOOM = 16;

/**
 * Measured: a z16 tile peaks at 2,623 trees, so a viewport fits well inside
 * this. When it is exceeded the *tallest* survive — the least visible failure,
 * and deterministic, rather than whichever the query happened to return first.
 */
export const MAX_INSTANCES = 20_000;

/** One tree pulled out of a vector tile. */
interface TreeInstance {
  lng: number;
  lat: number;
  height: number;
}

/**
 * A low-poly tree in metres, Y-up, its base at the origin, as two merged
 * geometries.
 *
 * Two rather than one so the layer keeps one material per geometry: `setOpacity`
 * iterates over `materials`, and collapsing bark and canopy into a single mesh
 * would break GeoLibre's paint bridge.
 *
 * `premultipliedAlpha` matters: MapLibre sets `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`
 * and expects premultiplied colours, so three.js has to emit them or the trees
 * wash out at partial opacity.
 */
function buildTree(): {
  bark: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
  materials: THREE.MeshStandardMaterial[];
} {
  const barkMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a3b2f,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    premultipliedAlpha: true,
  });
  const leafMaterial = new THREE.MeshStandardMaterial({
    color: 0x5f8f5a,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
    premultipliedAlpha: true,
  });

  const trunk = new THREE.CylinderGeometry(0.34, 0.62, 6.2, 9);
  trunk.translate(0, 3.1, 0);

  // Overlapping icosahedra read as foliage once flat-shaded. Fixed offsets and
  // rotations rather than Math.random so the shape is identical every reload.
  const blobs: { r: number; pos: [number, number, number]; rot: number }[] = [
    { r: 3.5, pos: [0, 8.2, 0], rot: 0.0 },
    { r: 2.6, pos: [1.9, 6.9, 0.9], rot: 0.7 },
    { r: 2.4, pos: [-1.7, 7.3, -1.1], rot: 1.4 },
    { r: 2.1, pos: [0.4, 10.4, -0.7], rot: 2.1 },
  ];
  const canopyParts = blobs.map(({ r, pos, rot }) => {
    const blob = new THREE.IcosahedronGeometry(r, 0);
    blob.rotateX(rot);
    blob.rotateY(rot * 1.7);
    blob.rotateZ(rot * 0.4);
    blob.translate(...pos);
    return blob;
  });

  const canopy = mergeGeometries(canopyParts, false);
  for (const part of canopyParts) part.dispose();

  return { bark: trunk, canopy, materials: [barkMaterial, leafMaterial] };
}

function buildLights(): THREE.Object3D[] {
  const sky = new THREE.HemisphereLight(0xbcd4ff, 0x1b222c, 1.5);
  const sun = new THREE.DirectionalLight(0xffe6bd, 2.2);
  sun.position.set(-26, 48, 22);
  return [sky, sun];
}

/**
 * A MapLibre custom layer that draws Taipei's tree inventory as instanced
 * three.js geometry inside the map's own GL context.
 *
 * It fetches nothing. Its data is the vector tiles MapLibre has already parsed
 * for the `tree-points` layer, read back with `querySourceFeatures` — so one
 * Martin endpoint serves both renderers and they cannot disagree.
 *
 * `renderingMode: "3d"` shares MapLibre's depth buffer, so the OSM building
 * extrusions occlude the trees instead of them always drawing in front.
 */
export class ThreeTreeLayer implements CustomLayerInterface {
  readonly id = TREE_NATIVE_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly materials: THREE.MeshStandardMaterial[];
  private readonly bark: THREE.InstancedMesh;
  private readonly canopy: THREE.InstancedMesh;
  private readonly group = new THREE.Group();

  /** Rebuilt on every refresh from the viewport centre. */
  private modelMatrix = new THREE.Matrix4();
  private heightScale = 1;
  private kind: TreeKind = "all";
  private visible = true;
  private refreshQueued = false;

  constructor() {
    const { bark, canopy, materials } = buildTree();
    this.materials = materials;
    this.bark = new THREE.InstancedMesh(bark, materials[0], MAX_INSTANCES);
    this.canopy = new THREE.InstancedMesh(canopy, materials[1], MAX_INSTANCES);
    for (const mesh of [this.bark, this.canopy]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      // Instances are placed per refresh across the whole viewport, so three's
      // object-level frustum culling has no useful bounding volume to test.
      mesh.frustumCulled = false;
    }
    this.group.add(this.bark, this.canopy);
    this.scene.add(this.group, ...buildLights());
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    map.on("idle", this.onIdle);
    // A basemap swap removes and re-adds this layer against the same canvas and
    // context, so keep the renderer rather than rebuilding it every time.
    if (!this.renderer || this.gl !== gl) {
      this.renderer?.dispose();
      this.gl = gl;
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
      this.renderer.autoClear = false;
    }
    this.refresh();
  }

  onRemove(): void {
    // The renderer outlives a style change; only the map reference is dropped.
    this.map?.off("idle", this.onIdle);
    this.map = null;
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const { renderer } = this;
    if (!renderer) return;

    // MapLibre v6 passes a `CustomRenderMethodInput`, not the bare matrix the
    // v2/v3-era three.js recipes destructure as the second argument. The field
    // to use is `defaultProjectionData.mainMatrix`: that is the one taking unit
    // Mercator coordinates (what `MercatorCoordinate` produces) to clip space.
    // `modelViewProjectionMatrix` is a different world space and puts the mesh
    // far outside the frustum.
    this.camera.projectionMatrix = new THREE.Matrix4()
      .fromArray(args.defaultProjectionData.mainMatrix as ArrayLike<number> as number[])
      .multiply(this.modelMatrix);

    // three.js and MapLibre share one GL context; hand it back in a known state.
    renderer.resetState();
    renderer.render(this.scene, this.camera);
  }

  /**
   * `querySourceFeatures` only sees tiles that are already loaded, so the
   * refresh rides `idle` — after the tiles for a movement have settled — rather
   * than `moveend`, which fires while they are still arriving.
   */
  private readonly onIdle = (): void => {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    // Coalesce the bursts of `idle` a single gesture can produce.
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  };

  private refresh(): void {
    const { map } = this;
    if (!map) return;

    if (!this.visible || map.getZoom() < TREE_MESH_MIN_ZOOM) {
      this.setCount(0);
      return;
    }

    const src = sourceId(TREE_POINTS_LAYER_ID);
    if (!map.getSource(src)) {
      this.setCount(0);
      return;
    }

    let features;
    try {
      features = map.querySourceFeatures(src, { sourceLayer: TREES_SOURCE_LAYER });
    } catch {
      // The source exists but has not finished loading its first tiles.
      this.setCount(0);
      return;
    }

    // A point within the tile buffer is repeated in every tile that covers it,
    // so the same tree arrives more than once. `tree_id` is published as a
    // property precisely so it can be deduplicated here.
    const seen = new Set<string>();
    const instances: TreeInstance[] = [];
    for (const feature of features) {
      const props = feature.properties ?? {};
      // GeoLibre cannot apply a record's `filterExpression` to a custom layer it
      // does not paint, so the kind filter has to be applied here by hand —
      // otherwise the circles narrow and the meshes do not.
      if (this.kind !== "all" && props.kind !== this.kind) continue;
      const treeId = props.tree_id as string | undefined;
      if (typeof treeId !== "string" || seen.has(treeId)) continue;
      if (feature.geometry?.type !== "Point") continue;
      seen.add(treeId);

      const [lng, lat] = feature.geometry.coordinates as [number, number];
      const raw = props.height_m;
      const height = typeof raw === "number" && raw > 0 ? raw : TREE_FALLBACK_HEIGHT_M;
      instances.push({ lng, lat, height });
    }

    if (instances.length > MAX_INSTANCES) {
      instances.sort((a, b) => b.height - a.height);
      instances.length = MAX_INSTANCES;
    }

    this.place(instances);
    map.triggerRepaint();
  }

  /**
   * Mercator is X-east / Y-south / Z-up and its units are fractions of the
   * world, while three.js is Y-up and the mesh is modelled in metres. Translate
   * to the anchor, scale metres into Mercator units (Y negated for the flipped
   * axis), then rotate three's Y-up frame onto Mercator's Z-up frame.
   *
   * The anchor is the viewport centre at the moment of this call, not a fixed
   * point: instance offsets then stay small, which keeps them precise in the
   * float32 instance matrices. In the resulting local frame `x` is east, `z` is
   * south and `y` is up.
   */
  private place(instances: TreeInstance[]): void {
    const map = this.map;
    if (!map) return;

    const centre = map.getCenter();
    const origin = MercatorCoordinate.fromLngLat([centre.lng, centre.lat], 0);
    const metre = origin.meterInMercatorCoordinateUnits();
    this.modelMatrix = new THREE.Matrix4()
      .makeTranslation(origin.x, origin.y, origin.z)
      .scale(new THREE.Vector3(metre, -metre, metre))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    instances.forEach((tree, i) => {
      const point = MercatorCoordinate.fromLngLat([tree.lng, tree.lat], 0);
      // Mercator deltas back into the local metre frame: east, up, south.
      position.set((point.x - origin.x) / metre, 0, (point.y - origin.y) / metre);
      const s = (tree.height / TREE_BASE_HEIGHT_M) * this.heightScale;
      scale.setScalar(s);
      matrix.compose(position, quaternion, scale);
      this.bark.setMatrixAt(i, matrix);
      this.canopy.setMatrixAt(i, matrix);
    });

    this.setCount(instances.length);
  }

  private setCount(count: number): void {
    for (const mesh of [this.bark, this.canopy]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Driven by GeoLibre through the external-native paint bridge. */
  setOpacity(opacity: number): void {
    for (const material of this.materials) {
      material.opacity = opacity;
      if (material.transparent !== opacity < 1) {
        material.transparent = opacity < 1;
        material.needsUpdate = true;
      }
    }
    this.map?.triggerRepaint();
  }

  /** Also driven by GeoLibre; MapLibre honours layer visibility on its own. */
  setVisibility(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
    this.refresh();
    this.map?.triggerRepaint();
  }

  /**
   * Also driven by the app directly, for the reason given in `refresh`: a
   * custom layer's features are ours to filter, not GeoLibre's.
   */
  setKind(kind: TreeKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.refresh();
    this.map?.triggerRepaint();
  }

  /** Not a GeoLibre concept — the app drives this one directly. */
  setHeightScale(scale: number): void {
    if (scale === this.heightScale) return;
    this.heightScale = scale;
    this.refresh();
    this.map?.triggerRepaint();
  }

  dispose(): void {
    this.bark.geometry.dispose();
    this.canopy.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.gl = null;
  }
}
