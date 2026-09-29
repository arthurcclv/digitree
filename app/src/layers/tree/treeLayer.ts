import * as THREE from "three";
import { MercatorCoordinate, type CustomRenderMethodInput } from "maplibre-gl";
import { sourceId } from "@geolibre/map/style-layer-ids";
import { mercatorFrame, projection, ThreeLayer } from "../../lib/three";
import { TREE_POINTS_LAYER_ID } from "./constants";
import { formOf, type TreeForm } from "./forms";
import { buildForm, buildMaterials, TREE_FORMS, type FormGeometry } from "./formGeometry";
import {
  lodFor,
  loadFormModel,
  MODEL_LODS,
  type FormModel,
  type ModelLod,
  type ModelPart,
} from "./models";
import { rotationOf } from "./placement";
import { treeOf } from "./schema";

/** Mirrors `TreeKindFilter` in `index.ts`; kept local to avoid a module cycle. */
export type TreeKind = "all" | "street" | "park" | "custom";

/** Mirrors `TreeMeshSource` in `index.ts`, for the same reason. */
export type MeshSource = "procedural" | "model";

/** What the panel shows: how much of the modelled source actually arrived. */
export interface ModelStatus {
  loaded: number;
  failed: number;
  total: number;
}

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
  /** Carried past dedup because it is also what the tree's yaw is hashed from. */
  id: string;
  lng: number;
  lat: number;
  height: number;
  form: TreeForm;
}

/** The local frame's up axis — `y`, per *The model matrix and the instance frame*. */
const UP = new THREE.Vector3(0, 1, 0);

/** Every rung of the ladder, in the order buckets are filled. */
const LODS: readonly ModelLod[] = MODEL_LODS.map((rung) => rung.level);

/** MapLibre's world is this many pixels across at z0. */
const TILE_SIZE_PX = 512;

/**
 * One form's meshes. Allocated on the form's first instance and grown by
 * doubling, never shrunk — so a palm-lined boulevard is served, and a view with
 * no palms in it never allocates a palm buffer.
 *
 * The procedural source contributes a bark/canopy pair and a modelled one
 * between one and five parts, but the rule is the same either way: a form is a
 * list of meshes over **one shared instance-matrix attribute**, written and
 * counted together. Capacity is therefore a property of the form, and a
 * five-part model costs the same matrix buffer as the pair does.
 */
interface FormMeshes {
  meshes: THREE.InstancedMesh[];
  instanceMatrix: THREE.InstancedBufferAttribute;
  capacity: number;
  /** Which source built these; a switch discards the ones that no longer match. */
  source: MeshSource;
}

/** What a bucket draws this frame — the two sources reduce to the same shape. */
interface FormParts {
  parts: readonly ModelPart[];
  baseHeightM: number;
  source: MeshSource;
}

/**
 * Buckets are per form *and* per level of detail, so `spreading` at level 0 and
 * `spreading` at level 1 are separate mesh sets over separate instance lists.
 * The procedural source has one level and only ever fills level 0.
 */
type BucketKey = `${TreeForm}|${number}`;

const bucketKey = (form: TreeForm, lod: ModelLod): BucketKey => `${form}|${lod}`;

function setCount(group: FormMeshes, count: number): void {
  for (const mesh of group.meshes) mesh.count = count;
  // One attribute behind every mesh in the bucket, so one upload, not five.
  group.instanceMatrix.needsUpdate = true;
}

/** Empty a bucket without re-uploading a buffer nothing is going to read. */
function clearCount(group: FormMeshes): void {
  if (group.meshes[0]?.count === 0) return;
  for (const mesh of group.meshes) mesh.count = 0;
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
export class ThreeTreeLayer extends ThreeLayer {
  readonly id = TREE_NATIVE_LAYER_ID;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly materials: THREE.MeshStandardMaterial[];
  /**
   * Every material the layer draws with, procedural and loaded alike.
   *
   * This is what `setOpacity` iterates, and it replaces the old rule that there
   * were exactly two materials — a rule no source whose materials come out of a
   * file can keep. A mesh built against a material that is not in here is
   * invisible to GeoLibre's paint bridge: it stays opaque while the rest of the
   * canopy fades, which looks like a rendering bug and is a contract bug.
   */
  private readonly materialRegistry = new Set<THREE.Material>();
  /** One geometry pair per form, built once; cheap, and needed for teardown. */
  private readonly geometries = new Map<TreeForm, FormGeometry>();
  /** Filled as models arrive. A form absent from here draws procedurally. */
  private readonly models = new Map<TreeForm, FormModel>();
  /** Every form that has been asked for, so nothing is fetched twice. */
  private readonly modelState = new Map<TreeForm, "loading" | "loaded" | "failed">();
  /** Filled lazily — a bucket with no tree in view has no buffers at all. */
  private readonly meshes = new Map<BucketKey, FormMeshes>();
  private readonly group = new THREE.Group();

  /** Rebuilt on every refresh from the viewport centre. */
  private modelMatrix = new THREE.Matrix4();
  private heightScale = 1;
  private kind: TreeKind = "all";
  private meshSource: MeshSource = "procedural";
  private opacity = 1;
  private visible = true;

  /** Lets the panel report how much of the modelled source actually arrived. */
  onModelsChanged: (() => void) | null = null;

  /** `sourceLayer`: the MVT layer of the tree source the points record reads. */
  constructor(private readonly sourceLayer: string) {
    super();
    this.materials = buildMaterials();
    for (const material of this.materials) this.materialRegistry.add(material);
    for (const form of TREE_FORMS) this.geometries.set(form, buildForm(form));
    this.scene.add(this.group, ...buildLights());
  }

  /**
   * What a form draws right now.
   *
   * A form is modelled only once its file has arrived, so this is also where
   * the spec's loading policy lives: until then — and permanently, if the load
   * failed — it falls back to the procedural shape. Nothing is invented by
   * doing so. The position and the height are the data and are already on
   * screen; only the silhouette is pending, and the shape drawn a moment ago is
   * a better answer for the next second than a hole in the canopy.
   */
  private partsFor(form: TreeForm, lod: ModelLod): FormParts {
    const model = this.meshSource === "model" ? this.models.get(form) : undefined;
    if (model) {
      // The whole ladder shares level 0's height, so a level change cannot
      // alter how tall a tree draws. See `matchHeight` in models.ts.
      return {
        parts: model.levels[lod].parts,
        baseHeightM: model.baseHeightM,
        source: "model",
      };
    }
    const geometry = this.geometries.get(form)!;
    return {
      parts: [
        { geometry: geometry.bark, material: this.materials[0] },
        { geometry: geometry.canopy, material: this.materials[1] },
      ],
      baseHeightM: geometry.baseHeightM,
      source: "procedural",
    };
  }

  /**
   * The meshes for a form, sized to hold at least `needed` instances and built
   * from whichever source that form is drawing from.
   *
   * Capacity doubles from `INITIAL_CAPACITY` and never shrinks, so a view that
   * fills with palms keeps its palm buffers for the rest of the session rather
   * than reallocating on every pan. Growth replaces the meshes — three cannot
   * resize an `InstancedMesh` — which is bounded to at most five doublings
   * before `MAX_INSTANCES` caps it.
   *
   * A source switch also replaces them, and resets capacity: the meshes are
   * built against one source's geometries and cannot be repointed at another's.
   */
  private meshesFor(form: TreeForm, lod: ModelLod, needed: number): FormMeshes {
    const desired = this.partsFor(form, lod);
    const key = bucketKey(form, lod);
    const existing = this.meshes.get(key);
    const sameSource = existing?.source === desired.source;
    if (existing && sameSource && existing.capacity >= needed) return existing;

    let capacity = sameSource ? existing!.capacity : INITIAL_CAPACITY;
    while (capacity < needed) capacity *= 2;
    capacity = Math.min(capacity, MAX_INSTANCES);

    // One attribute behind every part, so a five-part model costs the same
    // matrix buffer as the procedural pair rather than two and a half times it.
    const instanceMatrix = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 16),
      16,
    );
    instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const meshes = desired.parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      mesh.instanceMatrix = instanceMatrix;
      mesh.count = 0;
      // Instances are placed per refresh across the whole viewport, so three's
      // object-level frustum culling has no useful bounding volume to test.
      mesh.frustumCulled = false;
      return mesh;
    });

    if (existing) {
      this.group.remove(...existing.meshes);
      // Frees the instance buffers only; the geometries and the materials are
      // shared with the other forms and outlive these meshes.
      for (const mesh of existing.meshes) mesh.dispose();
    }
    this.group.add(...meshes);

    const group: FormMeshes = { meshes, instanceMatrix, capacity, source: desired.source };
    this.meshes.set(key, group);
    return group;
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    // See `projection`: MapLibre v6's `mainMatrix`, never the older recipes' matrix.
    this.camera.projectionMatrix = projection(args, this.modelMatrix);
    this.pass((renderer) => renderer.render(this.scene, this.camera));
  }

  /**
   * `querySourceFeatures` only sees tiles that are already loaded, so the
   * refresh rides `idle` — after the tiles for a movement have settled — rather
   * than `moveend`, which fires while they are still arriving.
   */
  protected viewSettled(): void {
    this.refresh();
  }

  protected attached(): void {
    this.refresh();
  }

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
      features = map.querySourceFeatures(src, { sourceLayer: this.sourceLayer });
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
      // The same reading of a tree the direct-sun layer casts shade from.
      const tree = treeOf(feature.properties, feature.geometry);
      if (!tree) continue;
      // GeoLibre cannot apply a record's `filterExpression` to a custom layer it
      // does not paint, so the kind filter has to be applied here by hand —
      // otherwise the circles narrow and the meshes do not.
      if (this.kind !== "all" && tree.kind !== this.kind) continue;
      if (seen.has(tree.id)) continue;
      seen.add(tree.id);

      const height = tree.heightM ?? TREE_FALLBACK_HEIGHT_M;
      instances.push({ id: tree.id, lng: tree.lng, lat: tree.lat, height, form: formOf(tree.species) });
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
    // The meshes are modelled y-up; the frame is z-up.
    this.modelMatrix = mercatorFrame(origin, metre).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    // Unproject once, here, rather than again inside the per-bucket loop: the
    // level of detail is chosen from this position, so it has to exist first.
    const placed = instances.map((tree) => {
      const point = MercatorCoordinate.fromLngLat([tree.lng, tree.lat], 0);
      // Mercator deltas back into the local metre frame: east, up, south.
      return { tree, x: (point.x - origin.x) / metre, z: (point.y - origin.y) / metre };
    });

    const camera = this.cameraMetres(metre);

    // The survivors of the cull, split by shape *and* by level of detail. Each
    // bucket writes into its own meshes, so the index a tree lands at is its
    // index within its bucket, not within the viewport.
    const buckets = new Map<BucketKey, typeof placed>();
    for (const item of placed) {
      // True 3D distance from the eye. Not from the anchor: the anchor is the
      // viewport centre, and at this map's pitch the trees nearest the camera
      // sit well in front of it — ranking by anchor distance would hand the
      // decimated mesh to the largest trees on screen.
      const lod =
        this.meshSource === "model"
          ? lodFor(Math.hypot(item.x - camera.x, camera.y, item.z - camera.z))
          : 0;
      const key = bucketKey(item.tree.form, lod);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }

    // Anything not refilled below holds no tree this frame. A bucket that has
    // never been allocated stays that way.
    for (const [key, idle] of this.meshes) {
      if (!buckets.has(key)) clearCount(idle);
    }

    for (const form of TREE_FORMS) {
      for (const lod of LODS) {
        const bucket = buckets.get(bucketKey(form, lod));
        if (!bucket?.length) continue;

        const group = this.meshesFor(form, lod, bucket.length);
        // Measured from whichever geometry is drawing, never declared — which
        // is what lets a source change *and* a level change leave every tree
        // the same height.
        const { baseHeightM } = this.partsFor(form, lod);
        const matrices = group.instanceMatrix.array as Float32Array;
        bucket.forEach((item, i) => {
          const { tree } = item;
          position.set(item.x, 0, item.z);
          scale.setScalar((tree.height / baseHeightM) * this.heightScale);
          // Yaw only, and hashed from the tree's own id rather than drawn — so
          // it is the same angle on every reload, under either mesh source and
          // at either level. The refresh runs on `idle`, so a random one would
          // spin as you panned.
          quaternion.setFromAxisAngle(UP, rotationOf(tree.id));
          matrix.compose(position, quaternion, scale);
          // Written once, into the attribute every mesh in this bucket shares.
          matrix.toArray(matrices, i * 16);
        });
        setCount(group, bucket.length);
      }
    }
  }

  /**
   * The camera's own position, in the same local metre frame the instances use.
   *
   * Derived from public camera state — `getVerticalFieldOfView`, `getZoom`,
   * `getPitch`, `getBearing` and the canvas height — rather than read off the
   * transform. MapLibre v6 removed `getFreeCameraOptions`, and its
   * `transform.cameraPosition` is marked `@internal`; this layer already
   * depends on one v6 signature change (see the spec on the projection matrix)
   * and does not need to depend on an unpublished one as well.
   *
   * The arithmetic: the camera sits `d` metres from the viewport centre along
   * the view ray, where `d` is the perspective distance that makes the canvas
   * subtend the field of view. Pitch splits `d` into an altitude and a ground
   * offset, and the offset runs *backwards* along the bearing — the camera is
   * behind what it is looking at.
   *
   * The altitude is load-bearing rather than a refinement: at this map's pitch
   * the camera is well above the ground, and a flat 2D distance would call the
   * entire foreground "near".
   */
  private cameraMetres(metre: number): THREE.Vector3 {
    const map = this.map;
    if (!map) return new THREE.Vector3();

    const fov = (map.getVerticalFieldOfView() * Math.PI) / 180;
    const distancePx = map.getCanvas().clientHeight / 2 / Math.tan(fov / 2);
    // Mercator spans [0, 1] across the world, so `metre * worldSizePx` is
    // pixels per metre at this latitude and zoom.
    const worldSizePx = TILE_SIZE_PX * 2 ** map.getZoom();
    const distance = distancePx / (metre * worldSizePx);

    const pitch = (map.getPitch() * Math.PI) / 180;
    const bearing = (map.getBearing() * Math.PI) / 180;
    const ground = distance * Math.sin(pitch);
    // x is east and z is south, and north is -z — hence the signs.
    return new THREE.Vector3(
      -ground * Math.sin(bearing),
      distance * Math.cos(pitch),
      ground * Math.cos(bearing),
    );
  }

  /** Empties every allocated bucket without giving its buffers back. */
  private clear(): void {
    for (const group of this.meshes.values()) clearCount(group);
  }

  /**
   * Driven by GeoLibre through the external-native paint bridge.
   *
   * Iterates the registry rather than a fixed pair, so a model's own materials
   * fade with everything else the moment they are registered.
   */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
    for (const material of this.materialRegistry) this.fade(material);
    this.repaint();
  }

  /** One material brought to the layer's current opacity. */
  private fade(material: THREE.Material): void {
    material.opacity = this.opacity;
    if (material.transparent !== this.opacity < 1) {
      material.transparent = this.opacity < 1;
      material.needsUpdate = true;
    }
  }

  /** Also driven by GeoLibre; MapLibre honours layer visibility on its own. */
  setVisibility(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
    this.refresh();
    this.repaint();
  }

  /**
   * Also driven by the app directly, for the reason given in `refresh`: a
   * custom layer's features are ours to filter, not GeoLibre's.
   */
  setKind(kind: TreeKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.refresh();
    this.repaint();
  }

  /**
   * Which of the two sources draws. Not a GeoLibre concept either — which
   * geometry a plugin chooses is ours, and a record field for it would be
   * silently inert.
   *
   * Switching to `"model"` is what first triggers any fetching at all; before
   * that the layer carries no asset and makes no request.
   */
  setMeshSource(source: MeshSource): void {
    if (source === this.meshSource) return;
    this.meshSource = source;
    if (source === "model") this.loadModels();
    // The meshes were built against the other source's geometries and cannot be
    // repointed, so drop them; `meshesFor` rebuilds on the next refresh.
    this.discardMeshes();
    this.refresh();
    this.repaint();
  }

  /**
   * Fetch every form's model once, in parallel, and swap each in as it lands.
   *
   * A failure leaves that form procedural for the rest of the session. There is
   * no retry and no substitute — a form never borrows another form's file —
   * and the panel reports the count, because a canopy quietly missing its palms
   * is exactly the kind of thing nobody notices.
   */
  private loadModels(): void {
    for (const form of TREE_FORMS) {
      if (this.modelState.has(form)) continue;
      this.modelState.set(form, "loading");
      loadFormModel(form).then(
        (model) => {
          this.models.set(form, model);
          this.modelState.set(form, "loaded");
          for (const part of model.levels.flatMap((level) => level.parts)) {
            // Registered before anything draws with them, or they would ignore
            // the paint bridge until the next opacity change.
            this.materialRegistry.add(part.material);
            this.fade(part.material);
          }
          // Only this form's meshes are stale; the others are still correct.
          this.discardMeshes(form);
          this.refresh();
          this.repaint();
          this.onModelsChanged?.();
        },
        () => {
          this.modelState.set(form, "failed");
          this.onModelsChanged?.();
        },
      );
    }
  }

  /** How much of the modelled source arrived. Read by the panel. */
  modelStatus(): ModelStatus {
    let loaded = 0;
    let failed = 0;
    for (const state of this.modelState.values()) {
      if (state === "loaded") loaded += 1;
      else if (state === "failed") failed += 1;
    }
    return { loaded, failed, total: TREE_FORMS.length };
  }

  /**
   * Give back the instance buffers of one form, or of all of them.
   *
   * Only the buffers: the geometries and materials behind them are shared and
   * are disposed in `dispose`.
   */
  private discardMeshes(only?: TreeForm): void {
    for (const [key, group] of this.meshes) {
      // A form owns both of its levels, so dropping one drops the pair.
      if (only && !key.startsWith(`${only}|`)) continue;
      this.group.remove(...group.meshes);
      for (const mesh of group.meshes) mesh.dispose();
      this.meshes.delete(key);
    }
  }

  /** Not a GeoLibre concept — the app drives this one directly. */
  setHeightScale(scale: number): void {
    if (scale === this.heightScale) return;
    this.heightScale = scale;
    this.refresh();
    this.repaint();
  }

  dispose(): void {
    this.discardMeshes();
    for (const geometry of this.geometries.values()) {
      geometry.bark.dispose();
      geometry.canopy.dispose();
    }
    for (const model of this.models.values()) {
      for (const level of model.levels) {
        for (const part of level.parts) part.geometry.dispose();
      }
    }
    this.models.clear();
    this.modelState.clear();
    // The registry holds both sources' materials, so this is the one loop that
    // frees a model's textures too.
    for (const material of this.materialRegistry) material.dispose();
    this.materialRegistry.clear();
    super.dispose();
  }
}
