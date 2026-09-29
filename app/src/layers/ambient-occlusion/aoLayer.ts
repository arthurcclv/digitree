import * as THREE from "three";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import {
  groundFootprint,
  lngLatToMercator,
  metreInMercator,
  TileStore,
  triangulateTile,
  type BuildingFeature,
  type LocalFrame,
  type TileId,
  type TilePrisms,
  type TileSource,
} from "../../lib/tiles";
import { buildingTiles, type BuildingSource } from "../buildings";
import { AO_FETCH_HALF_M, placeAoPrisms, planAoTiles } from "./geometry";
import { AO_NOISE_SIZE, AO_SAMPLES, aoKernel, aoNoise } from "./kernel";
import { AO_MIN_ZOOM, aoState, type AoState } from "./state";

/** The MapLibre style-layer id GeoLibre is told to manage on our behalf. */
export const AO_NATIVE_LAYER_ID = "threejs-ambient-occlusion-native";

/** The offscreen passes run at this fraction of the canvas resolution. */
export const AO_SCALE = 0.5;

/** Tile arrivals are coalesced into at most one rebuild per this. */
export const REBUILD_DEBOUNCE_MS = 150;

/**
 * The composite's polygon offset, pulling its redrawn surfaces towards the
 * camera so they pass against MapLibre's depth for the same surface.
 */
const DEPTH_OFFSET = { factor: -1, units: -4 };

export interface AoParams {
  intensity: number;
  radiusM: number;
  heightScale: number;
  minHeight: number;
}

// ---------------------------------------------------------------------------
// Shaders. Positions in the G-buffer are relative to the eye, in local metres,
// so they stay precise close to the camera where occlusion is seen.

const GBUF_VERT = /* glsl */ `
  precision highp float;
  in vec3 position;
  uniform mat4 uMVP;
  uniform vec3 uEye;
  out vec3 vRel;
  void main() {
    vRel = position - uEye;
    gl_Position = uMVP * vec4(position, 1.0);
  }
`;
const GBUF_FRAG = /* glsl */ `
  precision highp float;
  in vec3 vRel;
  layout(location = 0) out vec4 gPos;
  layout(location = 1) out vec4 gNormal;
  void main() {
    // Flat faces only, so the screen-space derivative normal is exact.
    vec3 n = normalize(cross(dFdx(vRel), dFdy(vRel)));
    if (dot(n, vRel) > 0.0) n = -n; // face the eye
    gPos = vec4(vRel, 1.0);
    gNormal = vec4(n, 1.0);
  }
`;

const QUAD_VERT = /* glsl */ `
  precision highp float;
  in vec3 position;
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const AO_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  #define SAMPLES ${AO_SAMPLES}
  #define NOISE ${AO_NOISE_SIZE}
  uniform sampler2D uPos;
  uniform sampler2D uNormal;
  uniform vec3 uKernel[SAMPLES];
  uniform vec3 uNoise[NOISE * NOISE];
  uniform mat4 uRelMVP;
  uniform float uRadius;
  in vec2 vUv;
  out vec4 fragColor;
  void main() {
    vec4 p = texture(uPos, vUv);
    if (p.w < 0.5) { fragColor = vec4(1.0); return; }
    vec3 P = p.xyz;
    vec3 N = normalize(texture(uNormal, vUv).xyz);
    ivec2 c = ivec2(gl_FragCoord.xy) % NOISE;
    vec3 r = uNoise[c.y * NOISE + c.x];
    vec3 T = r - N * dot(r, N);
    if (dot(T, T) < 1e-4) T = abs(N.z) < 0.9 ? cross(N, vec3(0.0, 0.0, 1.0)) : cross(N, vec3(1.0, 0.0, 0.0));
    T = normalize(T);
    vec3 B = cross(N, T);
    float dP = length(P);
    float bias = 0.02 * uRadius + 0.001 * dP;
    float occ = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      vec3 k = uKernel[i];
      vec3 S = P + (T * k.x + B * k.y + N * k.z) * uRadius;
      vec4 clip = uRelMVP * vec4(S, 1.0);
      if (clip.w <= 0.0) continue;
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
      vec4 q = texture(uPos, uv);
      if (q.w < 0.5) continue;
      float dQ = length(q.xyz);
      // Range check: a surface far in front of this one is not occluding it.
      float range = smoothstep(0.0, 1.0, uRadius / max(abs(dP - dQ), 1e-4));
      occ += step(dQ, length(S) - bias) * range;
    }
    fragColor = vec4(vec3(1.0 - occ / float(SAMPLES)), 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D uAo;
  uniform sampler2D uPos;
  uniform vec2 uTexel;
  in vec2 vUv;
  out vec4 fragColor;
  void main() {
    vec4 c = texture(uPos, vUv);
    if (c.w < 0.5) { fragColor = vec4(1.0); return; }
    float dC = length(c.xyz);
    float tolerance = 0.02 * dC + 0.5;
    float sum = 0.0;
    float weights = 0.0;
    for (int x = -2; x < 2; x++) {
      for (int y = -2; y < 2; y++) {
        vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
        vec4 q = texture(uPos, uv);
        if (q.w < 0.5) continue;
        // Taps across a silhouette are another surface: weight them away.
        float w = exp(-abs(length(q.xyz) - dC) / tolerance);
        sum += texture(uAo, uv).r * w;
        weights += w;
      }
    }
    fragColor = vec4(vec3(weights > 0.0 ? sum / weights : 1.0), 1.0);
  }
`;

const COMPOSITE_VERT = /* glsl */ `
  precision highp float;
  in vec3 position;
  uniform mat4 uMVP;
  void main() { gl_Position = uMVP * vec4(position, 1.0); }
`;
// compositeFactor() in kernel.ts is this line's reference.
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uAo;
  uniform vec2 uInvCanvas;
  uniform float uIntensity;
  out vec4 fragColor;
  void main() {
    float ao = texture(uAo, gl_FragCoord.xy * uInvCanvas).r;
    fragColor = vec4(vec3(clamp(1.0 + (ao - 1.0) * uIntensity, 0.0, 1.0)), 1.0);
  }
`;

function raw(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

/** Multiplies the frame's colour by the fragment's; keeps its alpha. */
function compositeMaterial(uniforms: Record<string, THREE.IUniform>, depthFunc: THREE.DepthModes, depthWrite: boolean) {
  const m = raw(COMPOSITE_VERT, COMPOSITE_FRAG, uniforms);
  m.side = THREE.DoubleSide;
  m.depthTest = true;
  m.depthFunc = depthFunc;
  m.depthWrite = depthWrite;
  m.polygonOffset = true;
  m.polygonOffsetFactor = DEPTH_OFFSET.factor;
  m.polygonOffsetUnits = DEPTH_OFFSET.units;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.DstColorFactor;
  m.blendDst = THREE.ZeroFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  return m;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, renderOrder = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.frustumCulled = false;
  m.renderOrder = renderOrder;
  return m;
}

type Frame = LocalFrame & { centre: [number, number] };

/**
 * A MapLibre custom layer that darkens the drawn buildings, and the ground at
 * their feet, by screen-space ambient occlusion. See `specs/spec.md`.
 *
 * MapLibre's depth buffer cannot be sampled, so the layer redraws the same
 * z14 buildings into a G-buffer of its own, from tiles it fetches itself.
 */
export class ThreeAoLayer implements CustomLayerInterface {
  readonly id = AO_NATIVE_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private supported = true;
  private readonly store: TileStore<{ buildings: TileSource<BuildingFeature> }>;
  /** Keyed by the store's feature array, so an evicted tile's entry goes with it. */
  private readonly prismCache = new WeakMap<BuildingFeature[], TilePrisms>();

  private visible = false;
  private params: AoParams = { intensity: 1, radiusM: 6, heightScale: 1, minHeight: 0 };
  private state: AoState = "off";
  private frame: Frame | null = null;
  private buildings = 0;

  private replan = true;
  private stale = true;
  private plannedView = "";
  private refreshQueued = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly prismGeometry = new THREE.BufferGeometry();
  private readonly groundGeometry = new THREE.BufferGeometry();
  private readonly quadGeometry = new THREE.BufferGeometry();

  private readonly gbufMaterial: THREE.RawShaderMaterial;
  private readonly aoMaterial: THREE.RawShaderMaterial;
  private readonly blurMaterial: THREE.RawShaderMaterial;
  private readonly prismCompMaterial: THREE.RawShaderMaterial;
  private readonly groundCompMaterial: THREE.RawShaderMaterial;
  private readonly compUniforms: Record<string, THREE.IUniform>;

  private readonly gScene = new THREE.Scene();
  private readonly aoScene = new THREE.Scene();
  private readonly blurScene = new THREE.Scene();
  private readonly compScene = new THREE.Scene();
  private readonly camera = new THREE.Camera();

  private gbuf: THREE.WebGLRenderTarget | null = null;
  private aoTarget: THREE.WebGLRenderTarget | null = null;
  private blurTarget: THREE.WebGLRenderTarget | null = null;

  /** The frame's local → clip matrix, set in `prerender` and reused by `render`. */
  private readonly mvp = new THREE.Matrix4();

  /** Lets the panel say why nothing is drawn. */
  onStatus: ((state: AoState) => void) | null = null;

  /** `buildings`: where the footprints are, from the host. See `src/lib/tiles/specs/spec.md`. */
  constructor(buildings: BuildingSource) {
    // Buildings only: a tile is covered on them alone.
    this.store = new TileStore({ buildings: buildingTiles(buildings) });
    this.quadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

    this.gbufMaterial = raw(GBUF_VERT, GBUF_FRAG, {
      uMVP: { value: new THREE.Matrix4() },
      uEye: { value: new THREE.Vector3() },
    });
    this.gbufMaterial.side = THREE.DoubleSide;
    this.gbufMaterial.depthTest = true;
    this.gbufMaterial.depthWrite = true;

    this.aoMaterial = raw(QUAD_VERT, AO_FRAG, {
      uPos: { value: null },
      uNormal: { value: null },
      uKernel: { value: aoKernel().map(([x, y, z]) => new THREE.Vector3(x, y, z)) },
      uNoise: { value: aoNoise().map(([x, y, z]) => new THREE.Vector3(x, y, z)) },
      uRelMVP: { value: new THREE.Matrix4() },
      uRadius: { value: this.params.radiusM },
    });
    this.blurMaterial = raw(QUAD_VERT, BLUR_FRAG, {
      uAo: { value: null },
      uPos: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });

    // One set of uniforms for both composite draws.
    this.compUniforms = {
      uMVP: { value: this.mvp },
      uAo: { value: null },
      uInvCanvas: { value: new THREE.Vector2() },
      uIntensity: { value: this.params.intensity },
    };
    // Prisms: strict, and writing depth, so a building repeated by the tile
    // buffer darkens once — its second copy meets the first's offset depth.
    this.prismCompMaterial = compositeMaterial(this.compUniforms, THREE.LessDepth, true);
    // Ground: never writes, so the overlay drawn after it still meets the
    // ground's own depth.
    this.groundCompMaterial = compositeMaterial(this.compUniforms, THREE.LessEqualDepth, false);

    this.gScene.add(mesh(this.prismGeometry, this.gbufMaterial), mesh(this.groundGeometry, this.gbufMaterial));
    this.aoScene.add(mesh(this.quadGeometry, this.aoMaterial));
    this.blurScene.add(mesh(this.quadGeometry, this.blurMaterial));
    this.compScene.add(
      mesh(this.prismGeometry, this.prismCompMaterial, 0),
      mesh(this.groundGeometry, this.groundCompMaterial, 1),
    );

    this.store.onChange = () => this.scheduleRebuild();
  }

  // --- lifecycle -----------------------------------------------------------

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    map.on("idle", this.onIdle);
    if (!this.renderer || this.gl !== gl) {
      this.renderer?.dispose();
      this.disposeTargets();
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

  /** Everything the plan depends on. `idle` follows every repaint we ask for. */
  private viewKey(): string {
    const map = this.map;
    if (!map) return "";
    const c = map.getCenter();
    const canvas = map.getCanvas();
    return [c.lng, c.lat, map.getZoom(), map.getPitch(), map.getBearing(), canvas.clientWidth, canvas.clientHeight]
      .map((v) => v.toFixed(7))
      .join(",");
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.stale = true;
      this.update();
    }, REBUILD_DEBOUNCE_MS);
  }

  // --- controls ------------------------------------------------------------

  setVisibility(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.replan = true;
    this.update();
  }

  /** GeoLibre's opacity has no meaning here; `intensity` is the strength. */
  setOpacity(_opacity: number): void {}

  setParams(next: Partial<AoParams>): void {
    const prev = this.params;
    this.params = { ...prev, ...next };
    this.aoMaterial.uniforms.uRadius.value = this.params.radiusM;
    this.compUniforms.uIntensity.value = this.params.intensity;
    if (this.params.heightScale !== prev.heightScale || this.params.minHeight !== prev.minHeight) {
      this.stale = true;
      this.update();
    } else {
      this.map?.triggerRepaint();
    }
  }

  // --- the work ------------------------------------------------------------

  private setState(state: AoState): void {
    if (state === this.state) return;
    this.state = state;
    this.onStatus?.(state);
  }

  private update(): void {
    const map = this.map;
    if (!map) return;
    const state = aoState({ visible: this.visible, supported: this.supported, zoom: map.getZoom() });
    if (state !== "ready") {
      const changed = state !== this.state;
      this.setState(state);
      // Once, so the shading goes; repainting on every idle would loop.
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
    this.setState("ready");
    map.triggerRepaint();
  }

  /** Recentre the frame on the view and ask the store for its tiles. */
  private plan(): void {
    const map = this.map!;
    const c = map.getCenter();
    this.plannedView = this.viewKey();
    this.frame = { centre: [c.lng, c.lat], origin: lngLatToMercator(c.lng, c.lat), metre: metreInMercator(c.lat) };
    this.store.want(planAoTiles(this.frame, groundFootprint(map)));
    const h = AO_FETCH_HALF_M;
    this.groundGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-h, -h, 0, h, -h, 0, h, h, 0, -h, -h, 0, h, h, 0, -h, h, 0], 3),
    );
    // The centre moved, so every placed prism is in the wrong frame.
    this.stale = true;
  }

  private rebuild(): void {
    const frame = this.frame;
    if (!frame) return;
    const parts = this.store.covered().map((tile) => ({ tile, prisms: this.tilePrisms(tile) }));
    const { positions, buildings } = placeAoPrisms(frame, parts, this.params.heightScale, this.params.minHeight);
    this.prismGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this.prismGeometry.setDrawRange(0, positions.length / 3);
    this.buildings = buildings;
  }

  private tilePrisms(tile: TileId): TilePrisms {
    const features = this.store.featuresOf("buildings", tile);
    const cached = this.prismCache.get(features);
    if (cached) return cached;
    const out = triangulateTile(tile, features);
    this.prismCache.set(features, out);
    return out;
  }

  /** Whether this frame is drawn: ready, zoomed in, and something to occlude. */
  private drawable(): boolean {
    return (
      this.state === "ready" &&
      this.buildings > 0 &&
      this.frame !== null &&
      this.renderer !== null &&
      // Checked per frame: `idle` does not fire mid-zoom.
      (this.map?.getZoom() ?? 0) >= AO_MIN_ZOOM
    );
  }

  /** The local metre frame onto Mercator, y flipped, then MapLibre's matrix. */
  private setMatrix(args: CustomRenderMethodInput): void {
    const f = this.frame!;
    const model = new THREE.Matrix4()
      .makeTranslation(f.origin.x, f.origin.y, 0)
      .scale(new THREE.Vector3(f.metre, -f.metre, f.metre));
    // `mainMatrix` is a gl-matrix mat4, which `fromArray` accepts but is not typed to.
    this.mvp.fromArray(args.defaultProjectionData.mainMatrix as ArrayLike<number> as number[]).multiply(model);
  }

  private ensureTargets(w: number, h: number): void {
    if (this.gbuf && this.gbuf.width === w && this.gbuf.height === h) return;
    this.disposeTargets();
    const nearest = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
    this.gbuf = new THREE.WebGLRenderTarget(w, h, {
      ...nearest,
      count: 2,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });
    this.aoTarget = new THREE.WebGLRenderTarget(w, h, { ...nearest, depthBuffer: false });
    // Sampled at full resolution by the composite, so filtered.
    this.blurTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
    const [pos, normal] = this.gbuf.textures;
    this.aoMaterial.uniforms.uPos.value = pos;
    this.aoMaterial.uniforms.uNormal.value = normal;
    this.blurMaterial.uniforms.uPos.value = pos;
    this.blurMaterial.uniforms.uAo.value = this.aoTarget.texture;
    this.blurMaterial.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.compUniforms.uAo.value = this.blurTarget.texture;
  }

  private disposeTargets(): void {
    for (const t of [this.gbuf, this.aoTarget, this.blurTarget]) t?.dispose();
    this.gbuf = this.aoTarget = this.blurTarget = null;
  }

  // --- the frame -------------------------------------------------------------

  /** G-buffer, AO and blur, offscreen, with this frame's camera. */
  prerender(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const renderer = this.renderer;
    if (!renderer || !this.drawable()) return;
    this.setMatrix(args);

    // The eye is where clip w vanishes: the inverse of (0, 0, 1, 0).
    const eye = new THREE.Vector4(0, 0, 1, 0).applyMatrix4(this.mvp.clone().invert());
    eye.divideScalar(eye.w);
    this.gbufMaterial.uniforms.uMVP.value.copy(this.mvp);
    this.gbufMaterial.uniforms.uEye.value.set(eye.x, eye.y, eye.z);
    // Eye-relative position → clip, for projecting the AO samples.
    this.aoMaterial.uniforms.uRelMVP.value.copy(this.mvp).multiply(new THREE.Matrix4().makeTranslation(eye.x, eye.y, eye.z));

    const w = Math.max(1, Math.round(gl.drawingBufferWidth * AO_SCALE));
    const h = Math.max(1, Math.round(gl.drawingBufferHeight * AO_SCALE));
    this.ensureTargets(w, h);

    renderer.resetState();
    renderer.setRenderTarget(this.gbuf);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.gScene, this.camera);
    renderer.setRenderTarget(this.aoTarget);
    renderer.render(this.aoScene, this.camera);
    renderer.setRenderTarget(this.blurTarget);
    renderer.render(this.blurScene, this.camera);
    renderer.setRenderTarget(null);
    renderer.resetState();
  }

  /** Multiply the occlusion over the frame, where the redrawn surfaces are in front. */
  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const renderer = this.renderer;
    if (!renderer || !this.drawable() || !this.blurTarget) return;
    this.setMatrix(args);
    this.compUniforms.uInvCanvas.value.set(1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    renderer.resetState();
    renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    renderer.render(this.compScene, this.camera);
    renderer.resetState();
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.store.onChange = null;
    for (const g of [this.prismGeometry, this.groundGeometry, this.quadGeometry]) g.dispose();
    for (const m of [this.gbufMaterial, this.aoMaterial, this.blurMaterial, this.prismCompMaterial, this.groundCompMaterial]) {
      m.dispose();
    }
    this.disposeTargets();
    this.renderer?.dispose();
    this.renderer = null;
    this.gl = null;
  }
}
