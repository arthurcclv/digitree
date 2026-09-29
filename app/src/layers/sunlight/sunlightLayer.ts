import * as THREE from "three";
import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";
import {
  canopyHullOf,
  formOf,
  rotationOf,
  TREE_FALLBACK_HEIGHT_M,
  TREE_FORMS,
  type TreeForm,
} from "../tree";
import {
  cellCentre,
  cellM,
  clipToSquare,
  counterClockwise,
  DOMAIN_M,
  FAR_DOMAIN_M,
  FAR_GRID_SIZE,
  geoTransform3857,
  levelOf,
  lightMatrixRowMajor,
  makeDomain,
  MIN_SUN_ELEVATION_REACH_M,
  nearGridFor,
  reachVector,
  toLocal,
  type Domain,
  type Vec2,
} from "./frame";
import { writeGeoTiff } from "./geotiff";
import { blockedState, lpiNodeAction, readoutSun, type SunlightState } from "./state";
import { LPI_NODE, LPI_SAMPLE_GLSL, type LpiField } from "./lpi";
import type { Graph } from "../../lib/dag";
import { MIN_SUN_ELEVATION_DEG, sunPosition } from "./sun";
import { classifyByTiles, planTiles, tileKey, tileSquareLocal, type TileId } from "./tileGrid";
import {
  groundFootprint,
  placeTile,
  TileStore,
  triangulateTile,
  type BuildingFeature,
  type TileCounts,
  type TilePrisms,
} from "../../lib/tiles";
import { alphaOf, BUILDING_TAU, tauOf } from "./transmittance";

/** The MapLibre style-layer id GeoLibre is told to manage on our behalf. */
export const SUNLIGHT_NATIVE_LAYER_ID = "threejs-sunlight-native";

/** More than the whole inventory, so in practice nothing is dropped. */
export const SUNLIGHT_MAX_TREES = 200_000;

/** Tile arrivals are coalesced into at most one rebuild per this. */
export const REBUILD_DEBOUNCE_MS = 150;

/** Rows per readback during export: 4096 × 256 × RGBA float is 16 MB. */
const EXPORT_STRIP_ROWS = 256;

/** Export NoData: roof, outside coverage, incomplete. */
export const NODATA = -1;

export interface SunlightStatus {
  state: SunlightState;
  azimuthDeg: number;
  elevationDeg: number;
  trees: number;
  buildings: number;
  cellM: number;
  rebuildMs: number;
  tiles: TileCounts;
}

export type ProbeResult =
  | { kind: "value"; index: number }
  | { kind: "roof" | "incomplete" | "outside" | "none" };

/** The ramp in the spec's *Ramp* table, as sRGB — written raw, never colour-managed. */
const RAMP: [number, string][] = [
  [0, "#2b2f6b"],
  [0.25, "#5a4f9c"],
  [0.5, "#a0679e"],
  [0.75, "#e39a6d"],
  [1, "#ffe3a1"],
];
const INCOMPLETE_GREY = "#8a8f98";

const rgb = (hex: string) =>
  new THREE.Vector3(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );

// ---------------------------------------------------------------------------
// Shaders

/** Every light-pass material: additive, double-sided, no depth. */
function lightMaterial(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

/**
 * Crowns: each form's canopy hull, instanced per tree. Every ray crosses the
 * closed convex surface twice, so each face writes τ / 2.
 */
const CROWN_VERT = /* glsl */ `
  uniform mat4 uLight;
  attribute float aTau;
  varying float vTau;
  void main() {
    vTau = aTau;
    gl_Position = uLight * instanceMatrix * vec4(position, 1.0);
  }
`;
const CROWN_FRAG = /* glsl */ `
  varying float vTau;
  void main() { gl_FragColor = vec4(0.5 * vTau, 0.0, 0.0, 0.0); }
`;

/** Building prisms (τ into R), footprints (into G) and coverage squares (into B). */
const FLAT_VERT = /* glsl */ `
  uniform mat4 uLight;
  void main() { gl_Position = uLight * vec4(position, 1.0); }
`;
const FLAT_FRAG = /* glsl */ `
  uniform vec4 uValue;
  void main() { gl_FragColor = uValue; }
`;

const OVERLAY_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// `sampleAt` is the finest level holding a point: R τ, G roof, B coverage.
const OVERLAY_FRAG = /* glsl */ `
  ${LPI_SAMPLE_GLSL}
  uniform float uOpacity;
  uniform vec2 uReach;
  uniform vec3 uRamp[5];
  uniform vec3 uGrey;
  varying vec2 vPos;

  vec3 ramp(float t) {
    float s = clamp(t, 0.0, 1.0) * 4.0;
    int i = int(min(floor(s), 3.0));
    return mix(uRamp[i], uRamp[i + 1], s - float(i));
  }

  void main() {
    vec4 t = sampleAt(vPos);
    if (t.b < 0.5) discard;          // no fetched occluders here
    if (t.g > 0.5) discard;          // roof, not ground
    float index = exp(-t.r);
    vec3 colour;
    float a;
    if (sampleAt(vPos + uReach).b < 0.5) {
      // Incomplete: hatched grey, whatever the value.
      float stripe = step(0.5, fract((vPos.x + vPos.y) / 6.0));
      colour = uGrey;
      a = uOpacity * 0.5 * stripe;
    } else {
      colour = ramp(index);
      a = uOpacity * (0.35 + 0.65 * (1.0 - index));
    }
    gl_FragColor = vec4(colour * a, a);
  }
`;

// ---------------------------------------------------------------------------

/** One grid: its domain and its render target. */
interface Level {
  domain: Domain;
  target: THREE.WebGLRenderTarget | null;
}

/** What the last pass produced, and everything needed to read it back. */
interface Result {
  near: Domain;
  far: Domain;
  covered: Set<string>;
  azimuthDeg: number;
  elevationDeg: number;
  reach: Vec2;
  sunTime: number;
}

type Pending =
  | { kind: "probe"; lng: number; lat: number; resolve: (r: ProbeResult) => void }
  | { kind: "export"; job: ExportJob; resolve: (b: Blob | null) => void };

/** What an export writes: see `LpiField.readNear`. */
interface ExportJob {
  transform: (index: number) => number;
  nodata: number;
  metadata: Record<string, string>;
}

const DIRECT_SUN_EXPORT: ExportJob = {
  transform: (index) => index,
  nodata: NODATA,
  metadata: { definition: "direct-sun transmittance; see app/src/layers/sunlight/specs/spec.md" },
};

type PlacedTree = { id: string; x: number; y: number; h: number; species: unknown; form: TreeForm };

/** One form's crowns: its hull, instanced, near trees first. */
interface CrownSet {
  mesh: THREE.InstancedMesh;
  /** This layer's own copy of the hull — it carries `aTau`, the tree layer's must not. */
  geometry: THREE.BufferGeometry;
  matrix: THREE.InstancedBufferAttribute;
  tau: THREE.InstancedBufferAttribute;
  capacity: number;
  /** Instances drawn by the near pass: the prefix that can shade the near grid. */
  nearCount: number;
  count: number;
}

/** The tree layer's Y-up frame onto this layer's east-north-up one: (x, y, z) → (x, −z, y). */
const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/**
 * A tree's hull instance: scaled by its height, yawed as the tree layer yaws
 * it, stood up into this frame, moved to its trunk. The tree layer's yaw about
 * its +Y is the same angle about +Z here. See *Trees*.
 */
export function crownMatrix(x: number, y: number, h: number, yaw: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out
    .makeRotationZ(yaw)
    .multiply(Y_UP_TO_Z_UP)
    .multiply(new THREE.Matrix4().makeScale(h, h, h))
    .setPosition(x, y, 0);
}

/**
 * A MapLibre custom layer that computes the direct-sun index for the ground in
 * view and draws it as an overlay. See `specs/spec.md`.
 *
 * Unlike the tree layer it fetches its own tiles (`src/lib/tiles`): the shade at
 * the viewport's sunward edge is cast from ground MapLibre never loaded.
 */
export class ThreeSunlightLayer implements CustomLayerInterface {
  readonly id = SUNLIGHT_NATIVE_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private supported = true;
  private readonly store = new TileStore();

  private readonly nearLevel: Level = { domain: makeDomain(0, 0), target: null };
  private readonly farLevel: Level = { domain: makeDomain(0, 0, FAR_GRID_SIZE, FAR_DOMAIN_M), target: null };

  private readonly lightScene = new THREE.Scene();
  private readonly footScene = new THREE.Scene();
  private readonly coverScene = new THREE.Scene();
  private readonly overlayScene = new THREE.Scene();
  private readonly lightCamera = new THREE.Camera();
  private readonly camera = new THREE.Camera();

  /** One instanced hull per form, drawn by both levels. Allocated on first use. */
  private readonly crowns = new Map<TreeForm, CrownSet>();
  /** Occluders have been placed at least once, so a pass has something to draw. */
  private placedOnce = false;

  private readonly prisms = new THREE.Mesh(new THREE.BufferGeometry());
  private readonly floors = new THREE.Mesh(new THREE.BufferGeometry());
  private readonly squares = new THREE.Mesh(new THREE.BufferGeometry());
  private readonly overlay: THREE.Mesh;

  private readonly crownMaterial: THREE.ShaderMaterial;
  private readonly prismMaterial: THREE.ShaderMaterial;
  private readonly footMaterial: THREE.ShaderMaterial;
  private readonly coverMaterial: THREE.ShaderMaterial;
  private readonly overlayMaterial: THREE.ShaderMaterial;

  /** The overlay is drawn. */
  private visible = false;
  /** The result is wanted — drawn here or by a dependent. Gates all work. */
  private demanded = false;
  private readonly unsubscribe: () => void;
  private opacity = 0.8;
  private sunTime = Date.now();
  /** The view moved or the layer came on: plan tiles on the next update. */
  private replan = true;
  /** Occluders must be regathered from the store. */
  private stale = true;
  /** The light pass must run. */
  private passDue = false;
  private refreshQueued = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Pending[] = [];

  /** The centre of the current plan, and the covered tiles placed around it. */
  private centre: [number, number] | null = null;
  /**
   * The view the current plan was made for. `idle` fires after every repaint
   * this layer asks for, so replanning on an unchanged view would loop.
   */
  private plannedView = "";
  private placedCovered: Set<string> = new Set();
  /** Keyed by the store's feature array, so an evicted tile's entry goes with it. */
  private readonly prismCache = new WeakMap<BuildingFeature[], TilePrisms>();
  private result: Result | null = null;
  private counts = { trees: 0, buildings: 0, rebuildMs: 0 };
  private state: SunlightState = "off";

  /** Lets the panel follow the readouts. */
  onStatus: ((status: SunlightStatus) => void) | null = null;

  constructor(private readonly graph: Graph) {
    this.crownMaterial = lightMaterial(CROWN_VERT, CROWN_FRAG, { uLight: { value: new THREE.Matrix4() } });
    this.prismMaterial = lightMaterial(FLAT_VERT, FLAT_FRAG, {
      uLight: { value: new THREE.Matrix4() },
      uValue: { value: new THREE.Vector4(0.5 * BUILDING_TAU, 0, 0, 0) },
    });
    this.footMaterial = lightMaterial(FLAT_VERT, FLAT_FRAG, {
      uLight: { value: new THREE.Matrix4() },
      uValue: { value: new THREE.Vector4(0, 1, 0, 0) },
    });
    this.coverMaterial = lightMaterial(FLAT_VERT, FLAT_FRAG, {
      uLight: { value: new THREE.Matrix4() },
      uValue: { value: new THREE.Vector4(0, 0, 1, 0) },
    });
    this.prisms.material = this.prismMaterial;
    this.floors.material = this.footMaterial;
    this.squares.material = this.coverMaterial;
    for (const m of [this.prisms, this.floors, this.squares]) m.frustumCulled = false;
    this.lightScene.add(this.prisms);
    this.footScene.add(this.floors);
    this.coverScene.add(this.squares);

    this.overlayMaterial = new THREE.ShaderMaterial({
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      uniforms: {
        uNear: { value: null },
        uFar: { value: null },
        uNearDomain: { value: DOMAIN_M },
        uFarDomain: { value: FAR_DOMAIN_M },
        uOpacity: { value: this.opacity },
        uReach: { value: new THREE.Vector2() },
        uRamp: { value: RAMP.map(([, hex]) => rgb(hex)) },
        uGrey: { value: rgb(INCOMPLETE_GREY) },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // The mesh's y is negated onto Mercator, which flips its winding.
      side: THREE.DoubleSide,
      // MapLibre composites premultiplied colour.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(FAR_DOMAIN_M, FAR_DOMAIN_M), this.overlayMaterial);
    this.overlay.frustumCulled = false;
    this.overlay.visible = false;
    this.overlayScene.add(this.overlay);

    this.store.onChange = () => this.scheduleRebuild();
    this.unsubscribe = graph.subscribe(LPI_NODE, (e) => {
      if (e.kind === "demand") this.setDemanded(e.demanded);
    });
    this.demanded = graph.demanded(LPI_NODE);
  }

  // --- lifecycle -----------------------------------------------------------

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    map.on("idle", this.onIdle);
    if (!this.renderer || this.gl !== gl) {
      this.renderer?.dispose();
      for (const level of [this.nearLevel, this.farLevel]) {
        level.target?.dispose();
        level.target = null;
      }
      this.gl = gl;
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
      this.renderer.autoClear = false;
      this.supported = this.renderer.extensions.has("EXT_color_buffer_float");
    }
    this.replan = true;
    this.update();
  }

  onRemove(): void {
    this.map?.off("idle", this.onIdle);
    this.map = null;
  }

  private readonly onIdle = (): void => {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.viewKey() === this.plannedView) return;
      this.replan = true;
      this.update();
    });
  };

  /** Everything the plan depends on: centre, zoom, pitch, bearing, canvas size. */
  private viewKey(): string {
    const map = this.map;
    if (!map) return "";
    const c = map.getCenter();
    const canvas = map.getCanvas();
    return [c.lng, c.lat, map.getZoom(), map.getPitch(), map.getBearing(), canvas.clientWidth, canvas.clientHeight]
      .map((v) => v.toFixed(7))
      .join(",");
  }

  /** Tile arrivals come in bursts; rebuild once per burst. */
  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.stale = true;
      this.update();
    }, REBUILD_DEBOUNCE_MS);
  }

  // --- controls ------------------------------------------------------------

  /** Whether the overlay is drawn. It also sets the node's own demand. */
  setVisibility(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.overlay.visible = this.state === "ready" && visible;
    // May call back into setDemanded, synchronously.
    this.graph.setOwnDemand(LPI_NODE, visible);
    this.map?.triggerRepaint();
  }

  /** Demand gates the work; see *The LPI node*. */
  private setDemanded(demanded: boolean): void {
    if (demanded === this.demanded) return;
    this.demanded = demanded;
    this.replan = true;
    this.passDue = true;
    this.update();
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.overlayMaterial.uniforms.uOpacity.value = opacity;
    this.map?.triggerRepaint();
  }

  /** A new sun needs only a new pass — the occluders do not move, and no tile is new. */
  setSunTime(ms: number): void {
    if (ms === this.sunTime) return;
    this.sunTime = ms;
    this.passDue = true;
    this.update();
  }

  // --- readback ------------------------------------------------------------

  /** The index at a point. Resolved on the next frame, inside MapLibre's pass. */
  probe(lng: number, lat: number): Promise<ProbeResult> {
    if (!this.result || this.state !== "ready") return Promise.resolve({ kind: "none" });
    return new Promise((resolve) => {
      this.pending.push({ kind: "probe", lng, lat, resolve });
      this.map?.triggerRepaint();
    });
  }

  /** The near grid as a GeoTIFF, or `null` when there is nothing to export. */
  exportGeoTiff(): Promise<Blob | null> {
    return this.readNear(DIRECT_SUN_EXPORT);
  }

  private readNear(job: ExportJob): Promise<Blob | null> {
    if (!this.result || this.state !== "ready") return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending.push({ kind: "export", job, resolve });
      this.map?.triggerRepaint();
    });
  }

  status(): SunlightStatus {
    const sun = readoutSun(this.state, this.result, this.sunNow());
    return {
      state: this.state,
      azimuthDeg: sun?.azimuthDeg ?? 0,
      elevationDeg: sun?.elevationDeg ?? 0,
      trees: this.counts.trees,
      buildings: this.counts.buildings,
      // The drawn result's grid; a newer plan's is not in use until its pass.
      cellM: cellM(this.result?.near ?? this.nearLevel.domain),
      rebuildMs: this.counts.rebuildMs,
      tiles: this.store.counts(),
    };
  }

  // --- the work ------------------------------------------------------------

  private gridSize(wanted: number): number {
    const max = this.renderer?.capabilities.maxTextureSize ?? wanted;
    return Math.min(wanted, max);
  }

  private sunNow(): { azimuthDeg: number; elevationDeg: number } | null {
    const map = this.map;
    if (!map) return null;
    const c = this.centre ?? [map.getCenter().lng, map.getCenter().lat];
    return sunPosition(new Date(this.sunTime), c[0], c[1]);
  }

  /** `passed`: a light pass has just produced a new result. */
  private setState(state: SunlightState, passed = false): void {
    const action = lpiNodeAction(this.state, state, passed);
    this.state = state;
    this.overlay.visible = state === "ready" && this.visible;
    // Before the publish or clear, so a dependent sees both together.
    this.graph.setState(LPI_NODE, state);
    if (action === "clear") this.graph.clear(LPI_NODE);
    if (action === "publish") this.graph.publish(LPI_NODE, this.field());
    this.onStatus?.(this.status());
  }

  /** The published result: see *The LPI node*. */
  private field(): LpiField {
    const r = this.result!;
    return {
      near: { texture: this.webglTexture(this.nearLevel.target!), domain: r.near },
      far: { texture: this.webglTexture(this.farLevel.target!), domain: r.far },
      covered: r.covered,
      reach: r.reach,
      sunTime: r.sunTime,
      azimuthDeg: r.azimuthDeg,
      elevationDeg: r.elevationDeg,
      probe: (lng, lat) => this.probe(lng, lat),
      readNear: (transform, nodata, metadata) => this.readNear({ transform, nodata, metadata }),
    };
  }

  /** A target's GL texture; three has no public getter for it. */
  private webglTexture(target: THREE.WebGLRenderTarget): WebGLTexture {
    return (this.renderer!.properties.get(target.texture) as { __webglTexture: WebGLTexture }).__webglTexture;
  }

  /** Decide what the next frame must do, and ask for it. */
  private update(): void {
    const map = this.map;
    if (!map) return;
    // Decided before planning, so a blocked layer fetches and builds nothing.
    const blocked = blockedState({
      visible: this.demanded,
      supported: this.supported,
      zoom: map.getZoom(),
      elevationDeg: this.sunNow()!.elevationDeg, // non-null: the map is set
    });
    if (blocked) {
      const changed = blocked !== this.state;
      this.setState(blocked);
      // Once, so the overlay goes. Every repaint ends in `idle`, which calls
      // back here while the view is unplanned, so repainting each time loops.
      if (changed) map.triggerRepaint();
      return;
    }
    if (this.replan) {
      this.replan = false;
      this.plan();
    }
    if (this.stale) {
      this.stale = false;
      this.rebuild();
    }
    // A pass is due only if something new arrived: a rebuild, a sun, the
    // layer coming on. Asking for one on every update would repaint forever.
    if (this.state !== "ready") this.setState("waiting");
    else this.onStatus?.(this.status());
    if (this.passDue) map.triggerRepaint();
  }

  /** Recentre both levels on the view and ask the store for its tiles. */
  private plan(): void {
    const map = this.map!;
    const c = map.getCenter();
    this.centre = [c.lng, c.lat];
    this.plannedView = this.viewKey();
    const nearGrid = nearGridFor(map.getZoom());
    this.nearLevel.domain = makeDomain(c.lng, c.lat, this.gridSize(nearGrid.size), nearGrid.domainM);
    this.farLevel.domain = makeDomain(c.lng, c.lat, this.gridSize(FAR_GRID_SIZE), FAR_DOMAIN_M);
    this.store.want(
      planTiles(this.farLevel.domain, this.footprint(this.farLevel.domain), this.nearLevel.domain.domainM / 2),
    );
    // The centre moved, so every placed occluder is in the wrong frame.
    this.stale = true;
  }

  /**
   * The viewport's ground footprint, in a domain's frame, clipped to it. A top
   * corner above the horizon — behind the camera — walks down its canvas edge
   * in 2% steps until it is on the ground. A corner that is merely far (a flat
   * z12 view is ±8 km) is kept and clipped, not walked. See *Coverage*.
   */
  private footprint(domain: Domain): Vec2[] {
    const quad = groundFootprint(this.map!).map(([lng, lat]) => toLocal(domain, lng, lat));
    if (quad.length < 3) return [];
    return counterClockwise(clipToSquare(counterClockwise(quad), domain.domainM / 2));
  }

  /** Gather every covered tile's occluders into the current frame. */
  private rebuild(): void {
    const started = performance.now();
    const near = this.nearLevel.domain;
    const covered = this.store.covered();

    const trees: PlacedTree[] = [];
    const seen = new Set<string>();
    for (const tile of covered) {
      for (const t of this.store.treesOf(tile)) {
        // The tile buffer repeats a tree in each tile it overlaps.
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const [x, y] = toLocal(near, t.lng, t.lat);
        const form = formOf(t.species);
        trees.push({ id: t.id, x, y, h: t.heightM ?? TREE_FALLBACK_HEIGHT_M, species: t.species, form });
      }
    }
    if (trees.length > SUNLIGHT_MAX_TREES) {
      trees.sort((a, b) => b.h - a.h);
      trees.length = SUNLIGHT_MAX_TREES;
    }
    // Trees that can shade the near grid first, so the near pass draws a prefix.
    const nearReach = near.domainM / 2 + MIN_SUN_ELEVATION_REACH_M;
    const isNear = (t: PlacedTree) => Math.abs(t.x) < nearReach && Math.abs(t.y) < nearReach;
    this.placeCrowns(trees, isNear);

    let buildings = 0;
    const parts = covered.map((tile) => {
      const p = this.tilePrisms(tile);
      buildings += p.count;
      return { tile, p };
    });
    const prism = new Float32Array(parts.reduce((n, { p }) => n + p.prism.length, 0));
    const floor = new Float32Array(parts.reduce((n, { p }) => n + p.floor.length, 0));
    let pi = 0;
    let fi = 0;
    for (const { tile, p } of parts) {
      pi = placeTile(near, tile, p.prism, prism, pi);
      fi = placeTile(near, tile, p.floor, floor, fi);
    }
    setPositions(this.prisms.geometry, prism);
    setPositions(this.floors.geometry, floor);

    // Coverage: one square per covered tile.
    const sq: number[] = [];
    for (const tile of covered) {
      const [w, s, e, n] = tileSquareLocal(near, tile);
      sq.push(w, s, 0, e, s, 0, e, n, 0, w, s, 0, e, n, 0, w, n, 0);
    }
    setPositions(this.squares.geometry, sq);

    this.placedCovered = new Set(covered.map(tileKey));
    this.counts = { trees: trees.length, buildings, rebuildMs: performance.now() - started };
    this.passDue = true;
  }

  /** A tile's buildings, triangulated in tile units — once per tile per session. */
  private tilePrisms(tile: TileId): TilePrisms {
    const features = this.store.buildingsOf(tile);
    const cached = this.prismCache.get(features);
    if (cached) return cached;
    const out = triangulateTile(tile, features);
    this.prismCache.set(features, out);
    return out;
  }

  /** Write every tree into its form's hull instances, near trees first. */
  private placeCrowns(trees: PlacedTree[], isNear: (t: PlacedTree) => boolean): void {
    const byForm = new Map<TreeForm, { near: PlacedTree[]; far: PlacedTree[] }>();
    for (const t of trees) {
      let g = byForm.get(t.form);
      if (!g) byForm.set(t.form, (g = { near: [], far: [] }));
      (isNear(t) ? g.near : g.far).push(t);
    }
    const m = new THREE.Matrix4();
    for (const form of TREE_FORMS) {
      const g = byForm.get(form);
      const total = g ? g.near.length + g.far.length : 0;
      const set = total ? this.crownSet(form, total) : this.crowns.get(form);
      if (!set) continue;
      set.nearCount = g?.near.length ?? 0;
      set.count = total;
      if (!g) continue;
      const matrices = set.matrix.array;
      const tau = set.tau.array;
      [...g.near, ...g.far].forEach((t, i) => {
        crownMatrix(t.x, t.y, t.h, rotationOf(t.id), m).toArray(matrices, i * 16);
        tau[i] = tauOf(alphaOf(t.species));
      });
      set.matrix.needsUpdate = true;
      set.tau.needsUpdate = true;
    }
    this.placedOnce = true;
  }

  /** A form's instanced hull, grown by doubling to hold `needed` trees. */
  private crownSet(form: TreeForm, needed: number): CrownSet {
    const existing = this.crowns.get(form);
    if (existing && existing.capacity >= needed) return existing;
    let capacity = Math.max(1024, existing?.capacity ?? 0);
    while (capacity < needed) capacity *= 2;
    if (existing) {
      this.lightScene.remove(existing.mesh);
      existing.mesh.dispose();
    }
    const geometry = existing?.geometry ?? canopyHullOf(form).clone();
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    const tau = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geometry.setAttribute("aTau", tau);
    const mesh = new THREE.InstancedMesh(geometry, this.crownMaterial, capacity);
    mesh.instanceMatrix = matrix;
    mesh.frustumCulled = false;
    this.lightScene.add(mesh);
    const set: CrownSet = { mesh, geometry, matrix, tau, capacity, nearCount: 0, count: 0 };
    this.crowns.set(form, set);
    return set;
  }

  /** The model matrix: the local metre frame onto Mercator, y flipped. */
  private modelMatrix(domain: Domain): THREE.Matrix4 {
    const o = MercatorCoordinate.fromLngLat(domain.centre, 0);
    return new THREE.Matrix4()
      .makeTranslation(o.x, o.y, o.z)
      .scale(new THREE.Vector3(domain.metre, -domain.metre, domain.metre));
  }

  // --- the frame -------------------------------------------------------------

  prerender(_gl: WebGL2RenderingContext): void {
    const renderer = this.renderer;
    if (!renderer || !this.supported) return this.flush(null);

    if (this.passDue && this.centre && this.placedOnce) {
      this.passDue = false;
      const sun = this.sunNow();
      if (sun && sun.elevationDeg >= MIN_SUN_ELEVATION_DEG) {
        // A published texture stays valid until a clear: a grid that changes
        // size is about to replace its target, so dependents let go first.
        const resizing = [this.nearLevel, this.farLevel].some((l) => l.target && l.target.width !== l.domain.size);
        if (resizing && this.state === "ready") this.setState("waiting");
        this.lightPass(renderer, this.nearLevel, sun.azimuthDeg, sun.elevationDeg, true);
        this.lightPass(renderer, this.farLevel, sun.azimuthDeg, sun.elevationDeg, false);
        this.result = {
          near: this.nearLevel.domain,
          far: this.farLevel.domain,
          covered: this.placedCovered,
          azimuthDeg: sun.azimuthDeg,
          elevationDeg: sun.elevationDeg,
          reach: reachVector(sun.azimuthDeg, sun.elevationDeg),
          sunTime: this.sunTime,
        };
        const u = this.overlayMaterial.uniforms;
        u.uReach.value.set(this.result.reach[0], this.result.reach[1]);
        u.uNear.value = this.nearLevel.target!.texture;
        u.uFar.value = this.farLevel.target!.texture;
        u.uNearDomain.value = this.nearLevel.domain.domainM;
        u.uFarDomain.value = this.farLevel.domain.domainM;
        this.setState("ready", true);
      }
    }
    this.flush(renderer);
  }

  private lightPass(renderer: THREE.WebGLRenderer, level: Level, az: number, el: number, near: boolean): void {
    const { domain } = level;
    const size = domain.size;
    if (!level.target || level.target.width !== size) {
      level.target?.dispose();
      level.target = new THREE.WebGLRenderTarget(size, size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
      });
    }
    // frame.ts returns a plain number[] so it stays free of three; `set` takes
    // exactly 16 numbers, which that array always is.
    const m = (straightDown: boolean) =>
      new THREE.Matrix4().set(
        ...(lightMatrixRowMajor(az, el, domain.domainM, straightDown) as Parameters<THREE.Matrix4["set"]>),
      );
    const shear = m(false);
    const down = m(true);
    this.crownMaterial.uniforms.uLight.value = shear;
    this.prismMaterial.uniforms.uLight.value = shear;
    this.footMaterial.uniforms.uLight.value = down;
    this.coverMaterial.uniforms.uLight.value = down;
    // The near pass draws each form's near prefix; the far pass draws them all.
    for (const set of this.crowns.values()) set.mesh.count = near ? set.nearCount : set.count;

    renderer.resetState();
    renderer.setRenderTarget(level.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.lightScene, this.lightCamera);
    renderer.render(this.footScene, this.lightCamera);
    renderer.render(this.coverScene, this.lightCamera);
    renderer.setRenderTarget(null);
    renderer.resetState();
  }

  /** Serve queued probes and exports. Runs inside MapLibre's offscreen pass. */
  private flush(renderer: THREE.WebGLRenderer | null): void {
    if (!this.pending.length) return;
    const jobs = this.pending;
    this.pending = [];
    const r = this.result;
    for (const job of jobs) {
      if (!renderer || !r) {
        if (job.kind === "probe") job.resolve({ kind: "none" });
        else job.resolve(null);
        continue;
      }
      if (job.kind === "probe") job.resolve(this.readProbe(renderer, r, job.lng, job.lat));
      else job.resolve(this.readExport(renderer, r, job.job));
    }
    renderer?.resetState();
  }

  private readProbe(renderer: THREE.WebGLRenderer, r: Result, lng: number, lat: number): ProbeResult {
    // The result's grids, not the levels': a replan since the last pass has
    // already recentred those, and the targets still hold the old frame.
    const hit = levelOf(r.near, r.far, lng, lat);
    const target = hit && (hit.level === "near" ? this.nearLevel : this.farLevel).target;
    if (!hit || !target) return { kind: "outside" };
    const cover = classifyByTiles(hit.domain, r.covered, r.reach, hit.point);
    if (cover === "outside") return { kind: "outside" };
    const px = new Float32Array(4);
    this.readPixels(renderer, target, hit.cell[0], hit.cell[1], 1, 1, px);
    if (px[1] > 0.5) return { kind: "roof" };
    if (cover !== "complete") return { kind: cover };
    return { kind: "value", index: Math.exp(-px[0]) };
  }

  private readExport(renderer: THREE.WebGLRenderer, r: Result, job: ExportJob): Blob | null {
    const target = this.nearLevel.target;
    if (!target) return null;
    const d = r.near;
    const size = d.size;
    const out = new Float32Array(size * size);
    const strip = new Float32Array(size * EXPORT_STRIP_ROWS * 4);
    for (let row0 = 0; row0 < size; row0 += EXPORT_STRIP_ROWS) {
      const rows = Math.min(EXPORT_STRIP_ROWS, size - row0);
      this.readPixels(renderer, target, 0, row0, size, rows, strip);
      for (let j = 0; j < rows; j++) {
        const row = row0 + j; // from the south
        const outRow = size - 1 - row; // image rows run from the north
        for (let col = 0; col < size; col++) {
          const i = (j * size + col) * 4;
          let v = job.nodata;
          // B is coverage and G roof; the reach test needs the tile set.
          if (strip[i + 2] > 0.5 && strip[i + 1] <= 0.5) {
            if (classifyByTiles(d, r.covered, r.reach, cellCentre(d, col, row)) === "complete") {
              v = job.transform(Math.exp(-strip[i]));
            }
          }
          out[outRow * size + col] = v;
        }
      }
    }
    const gt = geoTransform3857(d);
    const bytes = writeGeoTiff({
      width: size,
      height: size,
      data: out,
      originX: gt.originX,
      originY: gt.originY,
      pixelSize: gt.pixel,
      epsg: 3857,
      noData: job.nodata,
      metadata: {
        sun_time: new Date(r.sunTime).toISOString(),
        sun_azimuth_deg: r.azimuthDeg.toFixed(4),
        sun_elevation_deg: r.elevationDeg.toFixed(4),
        cell_m: String(cellM(d)),
        ...job.metadata,
      },
    });
    return new Blob([bytes], { type: "image/tiff" });
  }

  /**
   * Read a target as RGBA / FLOAT — the one pair WebGL 2 guarantees for a
   * float colour buffer, where HALF_FLOAT is implementation-defined. three's
   * `readRenderTargetPixels` would read in the texture's own (half) type.
   */
  private readPixels(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
    x: number,
    y: number,
    w: number,
    h: number,
    out: Float32Array,
  ): void {
    const gl = this.gl!;
    // three has no public getter for a target's framebuffer, and its own
    // readback cannot ask for FLOAT; the cast names the one private field used.
    const fb = (renderer.properties.get(target) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!fb) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const renderer = this.renderer;
    const r = this.result;
    if (!renderer || !r || this.state !== "ready") return;
    // The same MapLibre matrix hand-off as `treeLayer.ts`: `mainMatrix` is a
    // gl-matrix mat4, which `fromArray` accepts but is not typed to.
    this.camera.projectionMatrix = new THREE.Matrix4()
      .fromArray(args.defaultProjectionData.mainMatrix as ArrayLike<number> as number[])
      .multiply(this.modelMatrix(r.near));
    renderer.resetState();
    renderer.render(this.overlayScene, this.camera);
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.unsubscribe();
    // Dependents must stop sampling targets about to be deleted.
    if (this.state === "ready") this.graph.clear(LPI_NODE);
    this.state = "off";
    this.store.onChange = null;
    for (const set of this.crowns.values()) {
      set.mesh.dispose();
      // The layer's own copy; the tree layer's cached hull is left alone.
      set.geometry.dispose();
    }
    this.crowns.clear();
    for (const m of [this.prisms, this.floors, this.squares, this.overlay]) m.geometry.dispose();
    for (const m of [this.crownMaterial, this.prismMaterial, this.footMaterial, this.coverMaterial, this.overlayMaterial]) {
      m.dispose();
    }
    for (const level of [this.nearLevel, this.farLevel]) {
      level.target?.dispose();
      level.target = null;
    }
    this.renderer?.dispose();
    this.renderer = null;
    this.gl = null;
  }
}

/** Replace a geometry's positions; a non-indexed triangle soup. */
function setPositions(geometry: THREE.BufferGeometry, positions: number[] | Float32Array): void {
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setDrawRange(0, positions.length / 3);
}
