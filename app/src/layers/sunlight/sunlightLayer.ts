import * as THREE from "three";
import { MercatorCoordinate, type CustomRenderMethodInput } from "maplibre-gl";
import { treeTiles, type TreeFeature, type TreeSource } from "../tree";
import { buildingTiles, type BuildingSource } from "../buildings";
import {
  cellCentre,
  cellM,
  clipToSquare,
  counterClockwise,
  DOMAIN_M,
  EXPORT_MAX_CELLS,
  exportGridFor,
  FAR_DOMAIN_M,
  FAR_GRID_SIZE,
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
import { INCOMPLETE_GREY, SUNLIGHT_RAMP } from "./ramp";
import { blockedState, lpiNodeAction, readoutSun, type SunlightState } from "./state";
import { LPI_NODE, LPI_SAMPLE_GLSL, type LpiField, type NearGrid, type NearRead } from "./lpi";
import { nearGridTiff } from "./nearGrid";
import { coveredKeys, Occluders, type OccluderMaterials } from "./occluders";
import { SUNLIGHT_USD_NAME } from "./usd";
import type { Graph } from "../../lib/dag";
import { hexRgb } from "../../lib/colour";
import { mercatorFrame, PREMULTIPLIED_OVER, projection, ThreeLayer } from "../../lib/three";
import { UsdExportError, type ExportFrame } from "../../lib/usd";
import { MIN_SUN_ELEVATION_DEG, sunPosition } from "./sun";
import { classifyByTiles, exportTiles, planTiles, type TileId } from "./tileGrid";
import {
  groundFootprint,
  settle,
  TileStore,
  triangulateTile,
  type BuildingFeature,
  type TileCounts,
  type TilePrisms,
  type TileSource,
} from "../../lib/tiles";
import { BUILDING_TAU } from "./transmittance";

/** The MapLibre style-layer id GeoLibre is told to manage on our behalf. */
export const SUNLIGHT_NATIVE_LAYER_ID = "threejs-sunlight-native";

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

const rgb = (hex: string) => new THREE.Vector3(...hexRgb(hex));

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
  | { kind: "export"; job: ExportJob; resolve: (r: NearRead | null) => void }
  /** GPU work of an export pass: run inside `prerender`, or with no renderer to fail. */
  | { kind: "run"; run: (renderer: THREE.WebGLRenderer | null) => void };

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

/** Kept after an export pass: the raw index per cell, NaN where there is none. */
interface IndexGrid {
  key: string;
  domain: Domain;
  values: Float32Array;
  sunTime: number;
  azimuthDeg: number;
  elevationDeg: number;
}

export { crownMatrix, SUNLIGHT_MAX_TREES } from "./occluders";

/**
 * A MapLibre custom layer that computes the direct-sun index for the ground in
 * view and draws it as an overlay. See `specs/spec.md`.
 *
 * Unlike the tree layer it fetches its own tiles (`src/lib/tiles`): the shade at
 * the viewport's sunward edge is cast from ground MapLibre never loaded.
 */
export class ThreeSunlightLayer extends ThreeLayer {
  readonly id = SUNLIGHT_NATIVE_LAYER_ID;
  private supported = true;
  private readonly fallbackHeightM: number;
  private readonly store: TileStore<{
    trees: TileSource<TreeFeature>;
    buildings: TileSource<BuildingFeature>;
  }>;

  private readonly nearLevel: Level = { domain: makeDomain(0, 0), target: null };
  private readonly farLevel: Level = { domain: makeDomain(0, 0, FAR_GRID_SIZE, FAR_DOMAIN_M), target: null };

  private readonly overlayScene = new THREE.Scene();
  private readonly lightCamera = new THREE.Camera();
  private readonly camera = new THREE.Camera();

  /** The display's occluders, drawn by both levels. An export pass builds its own. */
  private readonly occluders: Occluders;
  /** Where the occluders are, for an export pass's own store. */
  private readonly sources: { trees: TileSource<TreeFeature>; buildings: TileSource<BuildingFeature> };
  /** The last export pass, reused by a second request for the same frame and sun. */
  /** The last export pass, keyed by frame and sun; held while it runs, so a request made meanwhile joins it. */
  private exportGrid: { key: string; grid: Promise<IndexGrid> } | null = null;
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

  /** `sources`: where the occluders are, from the host. See `src/lib/tiles/specs/spec.md`. */
  constructor(
    private readonly graph: Graph,
    sources: { trees: TreeSource; buildings: BuildingSource },
  ) {
    super();
    this.sources = { trees: treeTiles(sources.trees), buildings: buildingTiles(sources.buildings) };
    this.store = new TileStore(this.sources);
    // The same height the meshes draw a tree with none at: one value per inventory.
    this.fallbackHeightM = sources.trees.fallbackHeightM;
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
    this.occluders = new Occluders(this.occluderMaterials());

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
        uRamp: { value: SUNLIGHT_RAMP.map(([, hex]) => rgb(hex)) },
        uGrey: { value: rgb(INCOMPLETE_GREY) },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // The mesh's y is negated onto Mercator, which flips its winding.
      side: THREE.DoubleSide,
      // MapLibre composites premultiplied colour.
      ...PREMULTIPLIED_OVER,
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

  /** A new context owns none of the old targets; float targets may be missing. */
  protected contextChanged(renderer: THREE.WebGLRenderer): void {
    for (const level of [this.nearLevel, this.farLevel]) {
      level.target?.dispose();
      level.target = null;
    }
    this.supported = renderer.extensions.has("EXT_color_buffer_float");
  }

  protected attached(): void {
    this.replan = true;
    this.update();
  }

  protected viewSettled(): void {
    if (this.viewKey() === this.plannedView) return;
    this.replan = true;
    this.update();
  }

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
    this.repaint();
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
    this.repaint();
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
      this.repaint();
    });
  }

  /** The near grid as a GeoTIFF, or `null` when there is nothing to export. */
  exportGeoTiff(): Promise<Blob | null> {
    return this.readNear(DIRECT_SUN_EXPORT).then((r) => r?.tiff ?? null);
  }

  /** Direct sun over exactly `frame`, from an export pass: the USD export's. */
  exportFrame(frame: ExportFrame): Promise<NearRead> {
    return this.readFrame(frame, DIRECT_SUN_EXPORT);
  }

  private readNear(job: ExportJob): Promise<NearRead | null> {
    if (!this.result || this.state !== "ready") return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending.push({ kind: "export", job, resolve });
      this.repaint();
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
      readNear: (transform, nodata, metadata) =>
        this.readNear({ transform, nodata, metadata }).then((r) => r?.tiff ?? null),
      readFrame: (frame, transform, nodata, metadata) => this.readFrame(frame, { transform, nodata, metadata }),
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
    const placed = this.occluders.place({
      covered,
      treesOf: (tile) => this.store.featuresOf("trees", tile),
      prismsOf: (tile) => this.tilePrisms(tile),
      domain: near,
      fallbackHeightM: this.fallbackHeightM,
      nearReachM: near.domainM / 2 + MIN_SUN_ELEVATION_REACH_M,
    });
    this.placedCovered = coveredKeys(covered);
    this.counts = { ...placed, rebuildMs: performance.now() - started };
    this.passDue = true;
  }

  private occluderMaterials(): OccluderMaterials {
    return { crown: this.crownMaterial, prism: this.prismMaterial, foot: this.footMaterial, cover: this.coverMaterial };
  }

  /** A tile's buildings, triangulated in tile units — once per tile per session. */
  private tilePrisms(tile: TileId): TilePrisms {
    const features = this.store.featuresOf("buildings", tile);
    const cached = this.prismCache.get(features);
    if (cached) return cached;
    const out = triangulateTile(tile, features);
    this.prismCache.set(features, out);
    return out;
  }

  /** The model matrix: the local metre frame onto Mercator, y flipped. */
  private modelMatrix(domain: Domain): THREE.Matrix4 {
    return mercatorFrame(MercatorCoordinate.fromLngLat(domain.centre, 0), domain.metre);
  }

  // --- the frame -------------------------------------------------------------

  prerender(_gl: WebGL2RenderingContext): void {
    // Pending probes are answered even without a renderer, as `none`.
    if (!this.renderer || !this.supported) return this.flush(null);
    this.pass((renderer) => {
      if (this.passDue && this.centre && this.occluders.placedOnce) {
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
    });
  }

  private lightPass(
    renderer: THREE.WebGLRenderer,
    level: Level,
    az: number,
    el: number,
    near: boolean,
    occluders: Occluders = this.occluders,
  ): void {
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
    occluders.drawCounts(near);

    renderer.setRenderTarget(level.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(occluders.lightScene, this.lightCamera);
    renderer.render(occluders.footScene, this.lightCamera);
    renderer.render(occluders.coverScene, this.lightCamera);
    renderer.setRenderTarget(null);
  }

  /** Serve queued probes and exports. Runs inside MapLibre's offscreen pass. */
  private flush(renderer: THREE.WebGLRenderer | null): void {
    if (!this.pending.length) return;
    const jobs = this.pending;
    this.pending = [];
    const r = this.result;
    for (const job of jobs) {
      if (job.kind === "run") {
        job.run(renderer);
        continue;
      }
      if (!renderer || !r) {
        if (job.kind === "probe") job.resolve({ kind: "none" });
        else job.resolve(null);
        continue;
      }
      if (job.kind === "probe") job.resolve(this.readProbe(renderer, r, job.lng, job.lat));
      else job.resolve(this.readExport(renderer, r, job.job));
    }
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

  private readExport(renderer: THREE.WebGLRenderer, r: Result, job: ExportJob): NearRead | null {
    const target = this.nearLevel.target;
    if (!target) return null;
    const d = r.near;
    const index = this.readIndex(renderer, target, d, r.covered, r.reach);
    return nearRead(d, index, r, job);
  }

  /**
   * A target's index per cell, rows from the north, NaN for roof, outside and
   * incomplete cells. Read in strips, so the grid is never held twice at RGBA
   * width. Shared by the display export and the export pass.
   */
  private readIndex(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
    d: Domain,
    covered: ReadonlySet<string>,
    reach: Vec2,
  ): Float32Array {
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
          let v = NaN;
          // B is coverage and G roof; the reach test needs the tile set.
          if (strip[i + 2] > 0.5 && strip[i + 1] <= 0.5) {
            if (classifyByTiles(d, covered, reach, cellCentre(d, col, row)) === "complete") v = Math.exp(-strip[i]);
          }
          out[outRow * size + col] = v;
        }
      }
    }
    return out;
  }

  // --- the export pass -----------------------------------------------------

  /**
   * Direct sun over exactly `frame`, mapped through `job`: see *The export
   * pass*. A second request for the same frame and sun reuses the last pass,
   * or joins it while it still runs.
   */
  async readFrame(frame: ExportFrame, job: ExportJob): Promise<NearRead> {
    const key = `${frame.centre.lng},${frame.centre.lat},${frame.sizeM},${this.sunTime}`;
    if (this.exportGrid?.key !== key) {
      const entry = { key, grid: this.exportPass(frame, key) };
      this.exportGrid = entry;
      // A failed pass is not kept: the next request tries again.
      entry.grid.catch(() => {
        if (this.exportGrid === entry) this.exportGrid = null;
      });
    }
    const grid = await this.exportGrid.grid;
    return nearRead(grid.domain, grid.values, grid, job);
  }

  private async exportPass(frame: ExportFrame, key: string): Promise<IndexGrid> {
    const fail = (reason: "not-ready" | "failed", detail: string) => new UsdExportError(SUNLIGHT_USD_NAME, reason, detail);
    if (!this.supported) throw fail("not-ready", "this GPU cannot render float targets");
    const { lng, lat } = frame.centre;
    const sunTime = this.sunTime;
    const sun = sunPosition(new Date(sunTime), lng, lat);
    if (sun.elevationDeg < MIN_SUN_ELEVATION_DEG) throw fail("not-ready", "the sun is too low");
    const grid = exportGridFor(frame.sizeM, this.gridSize(EXPORT_MAX_CELLS));
    const domain = makeDomain(lng, lat, grid.size, grid.domainM);

    // Its own store and occluders: the display's plan and meshes are not touched.
    const store = new TileStore(this.sources);
    const tiles = exportTiles(domain);
    const counts = await settle(store, tiles);
    if (counts.failed) throw fail("failed", `${counts.failed} occluder tile(s) failed to load`);
    const occluders = new Occluders(this.occluderMaterials());
    try {
      occluders.place({
        covered: tiles,
        treesOf: (tile) => store.featuresOf("trees", tile),
        prismsOf: (tile) => triangulateTile(tile, store.featuresOf("buildings", tile)),
        domain,
        fallbackHeightM: this.fallbackHeightM,
        nearReachM: Infinity,
      });
      const covered = coveredKeys(tiles);
      const reach = reachVector(sun.azimuthDeg, sun.elevationDeg);
      const values = await new Promise<Float32Array>((resolve, reject) => {
        this.pending.push({
          kind: "run",
          run: (renderer) => {
            if (!renderer) return reject(fail("not-ready", "the layer is not on the map"));
            const level: Level = { domain, target: null };
            try {
              this.lightPass(renderer, level, sun.azimuthDeg, sun.elevationDeg, true, occluders);
              resolve(this.readIndex(renderer, level.target!, domain, covered, reach));
            } catch (e) {
              reject(fail("failed", e instanceof Error ? e.message : String(e)));
            } finally {
              level.target?.dispose();
            }
          },
        });
        this.repaint();
      });
      return { key, domain, values, sunTime, ...sun };
    } finally {
      occluders.dispose();
    }
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
    const r = this.result;
    if (!r || this.state !== "ready") return;
    this.camera.projectionMatrix = projection(args, this.modelMatrix(r.near));
    this.pass((renderer) => renderer.render(this.overlayScene, this.camera));
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.unsubscribe();
    // Dependents must stop sampling targets about to be deleted.
    if (this.state === "ready") this.graph.clear(LPI_NODE);
    this.state = "off";
    this.store.onChange = null;
    this.occluders.dispose();
    this.overlay.geometry.dispose();
    this.exportGrid = null;
    for (const m of [this.crownMaterial, this.prismMaterial, this.footMaterial, this.coverMaterial, this.overlayMaterial]) {
      m.dispose();
    }
    for (const level of [this.nearLevel, this.farLevel]) {
      level.target?.dispose();
      level.target = null;
    }
    super.dispose();
  }
}

/** A read index grid mapped through an export job, as a GeoTIFF and its values. */
function nearRead(
  d: Domain,
  index: Float32Array,
  sun: { sunTime: number; azimuthDeg: number; elevationDeg: number },
  job: ExportJob,
): NearRead {
  const values = new Float32Array(index.length);
  for (let i = 0; i < index.length; i++) values[i] = Number.isNaN(index[i]) ? job.nodata : job.transform(index[i]);
  const grid: NearGrid = {
    size: d.size,
    values,
    nodata: job.nodata,
    domain: d,
    sunTime: sun.sunTime,
    metadata: {
      sun_time: new Date(sun.sunTime).toISOString(),
      sun_azimuth_deg: sun.azimuthDeg.toFixed(4),
      sun_elevation_deg: sun.elevationDeg.toFixed(4),
      cell_m: String(cellM(d)),
      ...job.metadata,
    },
  };
  return { tiff: nearGridTiff(grid), grid };
}
