import * as THREE from "three";
import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";

/** The MapLibre style-layer id GeoLibre is told to manage on our behalf. */
export const TREE_NATIVE_LAYER_ID = "threejs-tree-native";

/** 25.0431° N, 121.5374° E — Da'an, Taipei. MapLibre takes [lng, lat]. */
export const TREE_LOCATION: [number, number] = [121.5374, 25.0431];

/** Height of the mesh as modelled, in metres; the height control scales from it. */
export const TREE_BASE_HEIGHT_M = 13;

/**
 * Mercator is X-east / Y-south / Z-up and its units are fractions of the world,
 * while three.js is Y-up and our mesh is modelled in metres. Translate to the
 * anchor, scale metres into Mercator units (Y negated for the flipped axis),
 * then rotate three's Y-up frame onto Mercator's Z-up frame.
 */
function buildModelMatrix(): THREE.Matrix4 {
  const origin = MercatorCoordinate.fromLngLat(TREE_LOCATION, 0);
  const metre = origin.meterInMercatorCoordinateUnits();
  return new THREE.Matrix4()
    .makeTranslation(origin.x, origin.y, origin.z)
    .scale(new THREE.Vector3(metre, -metre, metre))
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
}

/**
 * A low-poly tree in metres, Y-up, its base at the origin. Built from
 * primitives so the app carries no model asset and no loader.
 *
 * `premultipliedAlpha` matters: MapLibre sets `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`
 * and expects premultiplied colours, so three.js has to emit them or the tree
 * washes out at partial opacity.
 */
function buildTree(): { group: THREE.Group; materials: THREE.MeshStandardMaterial[] } {
  const bark = new THREE.MeshStandardMaterial({
    color: 0x4a3b2f,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    premultipliedAlpha: true,
  });
  const leaf = new THREE.MeshStandardMaterial({
    color: 0x5f8f5a,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
    premultipliedAlpha: true,
  });

  const group = new THREE.Group();

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.62, 6.2, 9), bark);
  trunk.position.y = 3.1;
  group.add(trunk);

  // Overlapping icosahedra read as foliage once flat-shaded. Fixed offsets and
  // rotations rather than Math.random so the tree is identical every reload.
  const canopy: { r: number; pos: [number, number, number]; rot: number }[] = [
    { r: 3.5, pos: [0, 8.2, 0], rot: 0.0 },
    { r: 2.6, pos: [1.9, 6.9, 0.9], rot: 0.7 },
    { r: 2.4, pos: [-1.7, 7.3, -1.1], rot: 1.4 },
    { r: 2.1, pos: [0.4, 10.4, -0.7], rot: 2.1 },
  ];
  for (const { r, pos, rot } of canopy) {
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), leaf);
    blob.position.set(...pos);
    blob.rotation.set(rot, rot * 1.7, rot * 0.4);
    group.add(blob);
  }

  return { group, materials: [bark, leaf] };
}

function buildLights(): THREE.Object3D[] {
  const sky = new THREE.HemisphereLight(0xbcd4ff, 0x1b222c, 1.5);
  const sun = new THREE.DirectionalLight(0xffe6bd, 2.2);
  sun.position.set(-26, 48, 22);
  return [sky, sun];
}

/**
 * A MapLibre custom layer that draws a three.js scene into the map's own GL
 * context.
 *
 * `renderingMode: "3d"` shares MapLibre's depth buffer, so the OSM building
 * extrusions occlude the tree instead of always drawing behind it.
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
  private readonly tree: THREE.Group;
  private readonly materials: THREE.MeshStandardMaterial[];
  private readonly modelMatrix = buildModelMatrix();

  constructor() {
    const { group, materials } = buildTree();
    this.tree = group;
    this.materials = materials;
    this.scene.add(group, ...buildLights());
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    // A basemap swap removes and re-adds this layer against the same canvas and
    // context, so keep the renderer rather than rebuilding it every time.
    if (this.renderer && this.gl === gl) return;
    this.renderer?.dispose();
    this.gl = gl;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
  }

  onRemove(): void {
    // The renderer outlives a style change; only the map reference is dropped.
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
    this.tree.visible = visible;
    this.map?.triggerRepaint();
  }

  /** Not a GeoLibre concept — the app drives this one directly. */
  setHeight(metres: number): void {
    this.tree.scale.setScalar(metres / TREE_BASE_HEIGHT_M);
    this.map?.triggerRepaint();
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.gl = null;
  }
}
