import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { MercatorCoordinate, type CustomRenderMethodInput, type Map as MapLibreMap } from "maplibre-gl";
import { mercatorFrame } from "../../lib/three";
import { TREE_HOVER_COLOR, TREE_SELECTED_COLOR } from "./constants";
import { MARK_GAIN, ThreeTreeLayer } from "./treeLayer";

const CENTRE = { lng: 121.5654, lat: 25.033 };
const SIZE = { w: 800, h: 600 };
/** Metres east of the centre, as a longitude. */
const east = (m: number) => CENTRE.lng + m / (111_320 * Math.cos((CENTRE.lat * Math.PI) / 180));

/** Mesh picking runs CPU-side, so the GL half is a renderer that does nothing. */
class TestTreeLayer extends ThreeTreeLayer {
  protected createRenderer(): THREE.WebGLRenderer {
    return { resetState() {}, render() {}, dispose() {} } as unknown as THREE.WebGLRenderer;
  }
}

const feature = (id: number, treeId: string, lng: number, height: number) => ({
  id,
  properties: { tree_id: treeId, kind: "street", species: "榕樹", height_m: height },
  geometry: { type: "Point", coordinates: [lng, CENTRE.lat] },
});

/** A map at z17 whose loaded tiles hold `features`, which a test may reorder. */
function setup(features: ReturnType<typeof feature>[]) {
  const map = {
    getZoom: () => 17,
    getCenter: () => CENTRE,
    getSource: () => ({}),
    querySourceFeatures: () => features,
    getVerticalFieldOfView: () => 36.87,
    getCanvas: () => ({ clientWidth: SIZE.w, clientHeight: SIZE.h }),
    getPitch: () => 0,
    getBearing: () => 0,
    on: () => map,
    off: () => map,
    triggerRepaint: () => {},
  };
  const layer = new TestTreeLayer({ sourceLayer: "trees", fallbackHeightM: 9.1 });
  layer.onAdd(map as unknown as MapLibreMap, {} as WebGL2RenderingContext);

  // A camera 300 m straight above the centre, in the instances' frame (y up,
  // z south), turned into the mainMatrix MapLibre would hand the layer.
  const camera = new THREE.PerspectiveCamera(40, SIZE.w / SIZE.h, 1, 2000);
  camera.position.set(0, 300, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const origin = MercatorCoordinate.fromLngLat([CENTRE.lng, CENTRE.lat], 0);
  const model = mercatorFrame(origin, origin.meterInMercatorCoordinateUnits()).multiply(
    new THREE.Matrix4().makeRotationX(Math.PI / 2),
  );
  const main = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).multiply(model.invert());
  layer.render({} as WebGL2RenderingContext, {
    defaultProjectionData: { mainMatrix: main.toArray() },
  } as unknown as CustomRenderMethodInput);

  /** Where a point in the instances' frame lands on screen. */
  const screenOf = (x: number, y: number, z: number) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((p.x + 1) / 2) * SIZE.w, y: ((1 - p.y) / 2) * SIZE.h };
  };
  return { layer, screenOf };
}

/** A mark as the float32 instance-colour buffer holds it: its colour times its gain. */
const mark = (hex: string, gain: number) =>
  Array.from(new Float32Array(new THREE.Color(hex).multiplyScalar(gain).toArray()));
const HOVERED = mark(TREE_HOVER_COLOR, MARK_GAIN.hover);
const SELECTED = mark(TREE_SELECTED_COLOR, MARK_GAIN.selected);

describe("ThreeTreeLayer.pickMesh", () => {
  test("a ray through a tree picks it, with its MVT id; a ray through nothing picks nothing", () => {
    const { layer, screenOf } = setup([feature(11, "A", CENTRE.lng, 10), feature(12, "B", east(40), 10)]);
    expect(layer.pickMesh(screenOf(0, 5, 0))).toMatchObject({ tree: { id: "A" }, featureId: 11 });
    expect(layer.pickMesh(screenOf(40, 5, 0))).toMatchObject({ tree: { id: "B" }, featureId: 12 });
    expect(layer.pickMesh(screenOf(-60, 0, 60))).toBeNull();
  });

  test("of two trees on one ray, the one nearer the camera wins", () => {
    // Same spot, seen from straight above: the taller crown is hit first.
    const { layer, screenOf } = setup([feature(1, "short", CENTRE.lng, 6), feature(2, "tall", CENTRE.lng, 20)]);
    expect(layer.pickMesh(screenOf(0, 0, 0))?.tree.id).toBe("tall");
  });

  test("picks nothing while the meshes are hidden", () => {
    const { layer, screenOf } = setup([feature(1, "A", CENTRE.lng, 10)]);
    layer.setVisibility(false);
    expect(layer.pickMesh(screenOf(0, 5, 0))).toBeNull();
  });
});

describe("ThreeTreeLayer.setMarks", () => {
  test("a mark brightens: some channel of either mark is above 1", () => {
    expect(Math.max(...HOVERED)).toBeGreaterThan(1);
    expect(Math.max(...SELECTED)).toBeGreaterThan(1);
  });

  test("tints the hovered and the selected tree, selected winning, and leaves the rest white", () => {
    const { layer } = setup([feature(1, "A", CENTRE.lng, 10), feature(2, "B", east(40), 10)]);
    expect(layer.markColorOf("A")).toEqual([1, 1, 1]);
    layer.setMarks({ hover: "A", selected: "B" });
    expect(layer.markColorOf("A")).toEqual(HOVERED);
    expect(layer.markColorOf("B")).toEqual(SELECTED);
    layer.setMarks({ hover: "B", selected: "B" });
    expect(layer.markColorOf("A")).toEqual([1, 1, 1]);
    expect(layer.markColorOf("B")).toEqual(SELECTED);
    layer.setMarks({ hover: null, selected: null });
    expect(layer.markColorOf("B")).toEqual([1, 1, 1]);
  });

  test("a marked tree keeps its mark when a refresh moves it to another instance", () => {
    const features = [feature(1, "A", CENTRE.lng, 10), feature(2, "B", east(40), 10)];
    const { layer } = setup(features);
    layer.setMarks({ hover: null, selected: "A" });
    features.reverse();
    layer.setHeightScale(2); // any refresh
    expect(layer.markColorOf("A")).toEqual(SELECTED);
    expect(layer.markColorOf("B")).toEqual([1, 1, 1]);
  });

  test("a tree marked while out of view is marked when it is placed", () => {
    const features = [feature(1, "A", CENTRE.lng, 10)];
    const { layer } = setup(features);
    layer.setMarks({ hover: null, selected: "B" });
    expect(layer.markColorOf("B")).toBeNull();
    features.push(feature(2, "B", east(40), 10));
    layer.setHeightScale(2);
    expect(layer.markColorOf("B")).toEqual(SELECTED);
  });
});
