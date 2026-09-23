import * as THREE from "three";
import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";
import { sourceId } from "@geolibre/map/style-layer-ids";
import { TREES_SOURCE_LAYER, TREE_POINTS_LAYER_ID } from "./constants";
import { formOf, type TreeForm } from "./forms";
import { buildForm, buildMaterials, TREE_FORMS, type FormGeometry } from "./formGeometry";

/** Mirrors `TreeKindFilter` in `index.ts`; kept local to avoid a module cycle. */
export type TreeKind = "all" | "street" | "park" | "custom";

/** The MapLibre style-layer id GeoLibre is told to manage on our behalf. */
export const TREE_NATIVE_LAYER_ID = "threejs-tree-native";

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

/**
 * Where a form's mesh pair starts before it grows. Sixteen meshes each sized
 * for `MAX_INSTANCES` would allocate 320,000 matrix slots — around 40 MB of
 * buffer to draw a viewport holding a few thousand trees.
 */
export const INITIAL_CAPACITY = 1_024;

/** One tree pulled out of a vector tile. */
interface TreeInstance {
  lng: number;
  lat: number;
  height: number;
  form: TreeForm;
}

/**
 * One form's pair of meshes. Allocated on the form's first instance and grown
 * by doubling, never shrunk — so a palm-lined boulevard is served, and a view
 * with no palms in it never allocates a palm buffer.
 */
interface FormMeshes {
  bark: THREE.InstancedMesh;
  canopy: THREE.InstancedMesh;
  capacity: number;
}

function setCount(pair: FormMeshes, count: number): void {
  for (const mesh of [pair.bark, pair.canopy]) {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  }
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
  /** One geometry pair per form, built once; cheap, and needed for teardown. */
  private readonly geometries = new Map<TreeForm, FormGeometry>();
  /** Filled lazily — a form with no tree in view has no buffers at all. */
  private readonly meshes = new Map<TreeForm, FormMeshes>();
  private readonly group = new THREE.Group();

  /** Rebuilt on every refresh from the viewport centre. */
  private modelMatrix = new THREE.Matrix4();
  private heightScale = 1;
  private kind: TreeKind = "all";
  private visible = true;
  private refreshQueued = false;

  constructor() {
    this.materials = buildMaterials();
    for (const form of TREE_FORMS) this.geometries.set(form, buildForm(form));
    this.scene.add(this.group, ...buildLights());
  }

  /**
   * The mesh pair for a form, sized to hold at least `needed` instances.
   *
   * Capacity doubles from `INITIAL_CAPACITY` and never shrinks, so a view that
   * fills with palms keeps its palm buffers for the rest of the session rather
   * than reallocating on every pan. Growth replaces the pair — three cannot
   * resize an `InstancedMesh` — which is bounded to at most five doublings
   * before `MAX_INSTANCES` caps it.
   */
  private meshesFor(form: TreeForm, needed: number): FormMeshes {
    const existing = this.meshes.get(form);
    if (existing && existing.capacity >= needed) return existing;

    let capacity = existing?.capacity ?? INITIAL_CAPACITY;
    while (capacity < needed) capacity *= 2;
    capacity = Math.min(capacity, MAX_INSTANCES);

    const geometry = this.geometries.get(form)!;
    const bark = new THREE.InstancedMesh(geometry.bark, this.materials[0], capacity);
    const canopy = new THREE.InstancedMesh(geometry.canopy, this.materials[1], capacity);
    for (const mesh of [bark, canopy]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      // Instances are placed per refresh across the whole viewport, so three's
      // object-level frustum culling has no useful bounding volume to test.
      mesh.frustumCulled = false;
    }

    if (existing) {
      this.group.remove(existing.bark, existing.canopy);
      // Frees the instance buffers only; the geometry and the two materials are
      // shared and outlive this pair.
      existing.bark.dispose();
      existing.canopy.dispose();
    }
    this.group.add(bark, canopy);

    const pair: FormMeshes = { bark, canopy, capacity };
    this.meshes.set(form, pair);
    return pair;
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
      this.clear();
      return;
    }

    const src = sourceId(TREE_POINTS_LAYER_ID);
    if (!map.getSource(src)) {
      this.clear();
      return;
    }

    let features;
    try {
      features = map.querySourceFeatures(src, { sourceLayer: TREES_SOURCE_LAYER });
    } catch {
      // The source exists but has not finished loading its first tiles.
      this.clear();
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
      instances.push({ lng, lat, height, form: formOf(props.species) });
    }

    // Global, and before the split by form below. Culling within a form would
    // let the shape of a tree decide whether it survives, and a palm-lined
    // street would evict the banyans behind it.
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

    // The survivors of the cull, split by shape. Each form writes into its own
    // pair of meshes, so the index a tree lands at is its index within its
    // form, not within the viewport.
    const byForm = new Map<TreeForm, TreeInstance[]>();
    for (const tree of instances) {
      const bucket = byForm.get(tree.form);
      if (bucket) bucket.push(tree);
      else byForm.set(tree.form, [tree]);
    }

    for (const form of TREE_FORMS) {
      const bucket = byForm.get(form);
      if (!bucket?.length) {
        // Nothing in view. A form that has never been allocated stays that way.
        const idle = this.meshes.get(form);
        if (idle) setCount(idle, 0);
        continue;
      }

      const pair = this.meshesFor(form, bucket.length);
      const base = this.geometries.get(form)!.baseHeightM;
      bucket.forEach((tree, i) => {
        const point = MercatorCoordinate.fromLngLat([tree.lng, tree.lat], 0);
        // Mercator deltas back into the local metre frame: east, up, south.
        position.set((point.x - origin.x) / metre, 0, (point.y - origin.y) / metre);
        scale.setScalar((tree.height / base) * this.heightScale);
        matrix.compose(position, quaternion, scale);
        pair.bark.setMatrixAt(i, matrix);
        pair.canopy.setMatrixAt(i, matrix);
      });
      setCount(pair, bucket.length);
    }
  }

  /** Empties every allocated form without giving its buffers back. */
  private clear(): void {
    for (const pair of this.meshes.values()) setCount(pair, 0);
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
    for (const pair of this.meshes.values()) {
      pair.bark.dispose();
      pair.canopy.dispose();
    }
    this.meshes.clear();
    for (const geometry of this.geometries.values()) {
      geometry.bark.dispose();
      geometry.canopy.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.gl = null;
  }
}
