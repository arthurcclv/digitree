import * as THREE from "three";
import { MercatorCoordinate, type CustomRenderMethodInput } from "maplibre-gl";
import { LPI_NODE, LPI_SAMPLE_GLSL, type Domain, type LpiField, type SunlightState } from "../sunlight";
import type { Graph } from "../../lib/dag";
import type { ExportFrame } from "../../lib/usd";
import { mercatorFrame, PREMULTIPLIED_OVER, projection, ThreeLayer } from "../../lib/three";
import {
  PET_NODE,
  PET_RAMP,
  PET_RAMP_MIN,
  PET_RAMP_RGB,
  PET_RAMP_STEP,
  petGlsl,
  petOf,
  petProbeOf,
  petRange,
  type PetField,
  type PetParams,
  type PetRead,
  type PetProbe,
} from "./pet";
import { temperatureState, type TemperatureState } from "./state";

/** The MapLibre style-layer id GeoLibre is told to manage on our behalf. */
export const TEMPERATURE_NATIVE_LAYER_ID = "threejs-temperature-native";

/** Export NoData. Not the direct-sun `-1`, which is a reachable PET. */
export const PET_NODATA = -9999;

/** The direct-sun overlay's incomplete grey, so hatching reads the same. */
const INCOMPLETE_GREY: [number, number, number] = [0x8a / 255, 0x8f / 255, 0x98 / 255];

export interface TemperatureStatus {
  state: TemperatureState;
  params: PetParams;
  petRange: [number, number];
}

const OVERLAY_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    // The quad is a unit square scaled to the far grid: vPos is in metres.
    vPos = (modelMatrix * vec4(position, 1.0)).xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const OVERLAY_FRAG = /* glsl */ `
  ${LPI_SAMPLE_GLSL}
  uniform float uOpacity;
  uniform vec2 uReach;
  uniform float uG0;
  uniform float uTa;
  uniform float uV;
  uniform vec3 uRamp[${PET_RAMP.length}];
  uniform vec3 uGrey;
  varying vec2 vPos;

  float petOf(float lpi) { return ${petGlsl()}; }

  vec3 ramp(float pet) {
    float s = clamp((pet - ${PET_RAMP_MIN.toFixed(1)}) / ${PET_RAMP_STEP.toFixed(1)}, 0.0, ${(PET_RAMP.length - 1).toFixed(1)});
    int i = int(min(floor(s), ${(PET_RAMP.length - 2).toFixed(1)}));
    return mix(uRamp[i], uRamp[i + 1], s - float(i));
  }

  void main() {
    vec4 t = sampleAt(vPos);
    if (t.b < 0.5) discard;          // no fetched occluders here
    if (t.g > 0.5) discard;          // roof, not ground
    vec3 colour;
    float a;
    if (sampleAt(vPos + uReach).b < 0.5) {
      // Incomplete: hatched grey, as on the direct-sun overlay.
      float stripe = step(0.5, fract((vPos.x + vPos.y) / 6.0));
      colour = uGrey;
      a = uOpacity * 0.5 * stripe;
    } else {
      colour = ramp(petOf(exp(-t.r)));
      a = uOpacity;
    }
    gl_FragColor = vec4(colour * a, a);
  }
`;

export const DEFAULT_PET_PARAMS: PetParams = { g0: 800, ta: 32, v: 1 };

/**
 * A MapLibre custom layer that draws PET over the ground, derived per fragment
 * from the direct-sun layer's published result. It runs no pass of its own
 * and fetches nothing. See `specs/spec.md`.
 */
export class ThreeTemperatureLayer extends ThreeLayer {
  readonly id = TEMPERATURE_NATIVE_LAYER_ID;

  // Wrappers over the direct-sun layer's textures. Never dispose them: three
  // would delete the GL texture, which is not ours.
  private readonly nearTexture = new THREE.ExternalTexture();
  private readonly farTexture = new THREE.ExternalTexture();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly material: THREE.ShaderMaterial;
  private readonly overlay: THREE.Mesh;

  private visible = false;
  private params: PetParams = { ...DEFAULT_PET_PARAMS };
  private upstream: SunlightState = "off";
  /** The result drawn from, or `null`. */
  private field: LpiField | null = null;
  /** `temperature.pet` must be (re)published on the next frame. */
  private publishDue = false;
  private published = false;
  private readonly unsubscribe: () => void;

  /** Lets the panel follow the readouts. */
  onStatus: ((status: TemperatureStatus) => void) | null = null;

  constructor(private readonly graph: Graph) {
    super();
    this.material = new THREE.ShaderMaterial({
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      uniforms: {
        uNear: { value: this.nearTexture },
        uFar: { value: this.farTexture },
        uNearDomain: { value: 0 },
        uFarDomain: { value: 0 },
        uOpacity: { value: 0.8 },
        uReach: { value: new THREE.Vector2() },
        uG0: { value: this.params.g0 },
        uTa: { value: this.params.ta },
        uV: { value: this.params.v },
        uRamp: { value: PET_RAMP_RGB.map(([r, g, b]) => new THREE.Vector3(r, g, b)) },
        uGrey: { value: new THREE.Vector3(...INCOMPLETE_GREY) },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // The frame's y is negated onto Mercator, which flips the winding.
      side: THREE.DoubleSide,
      // MapLibre composites premultiplied colour.
      ...PREMULTIPLIED_OVER,
    });
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.overlay.frustumCulled = false;
    this.overlay.visible = false;
    this.scene.add(this.overlay);

    this.unsubscribe = graph.subscribe(PET_NODE, (e) => {
      if (e.kind === "upstream") this.pull();
    });
    this.pull();
  }

  // --- controls ------------------------------------------------------------

  /** Whether the overlay is drawn. It also sets the node's own demand. */
  setVisibility(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.graph.setOwnDemand(PET_NODE, visible);
    this.changed();
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.uOpacity.value = opacity;
    this.repaint();
  }

  /** New G0, Ta, V: three uniforms and a repaint. The direct-sun result is untouched. */
  setParams(params: PetParams): void {
    const p = this.params;
    if (p.g0 === params.g0 && p.ta === params.ta && p.v === params.v) return;
    this.params = { ...params };
    const u = this.material.uniforms;
    u.uG0.value = params.g0;
    u.uTa.value = params.ta;
    u.uV.value = params.v;
    this.changed();
  }

  // --- readback ------------------------------------------------------------

  /** PET at a point, from the direct-sun layer's own probe. */
  probe(lng: number, lat: number): Promise<PetProbe> {
    const field = this.field;
    if (!field || this.state() !== "ready") return Promise.resolve({ kind: "none" });
    const params = { ...this.params };
    return field.probe(lng, lat).then((r) => petProbeOf(r, params));
  }

  /** The near grid in PET, through the direct-sun layer's strip reader. */
  exportGeoTiff(): Promise<Blob | null> {
    const field = this.field;
    if (!field || this.state() !== "ready") return Promise.resolve(null);
    const p = { ...this.params };
    return field.readNear((lpi) => petOf(lpi, p), PET_NODATA, petMetadata(p));
  }

  /**
   * PET over exactly `frame`, from the direct-sun layer's export pass, which
   * the direct-sun USD package shares: the USD export's. `null` without a field.
   */
  exportFrame(frame: ExportFrame): Promise<PetRead | null> {
    const field = this.field;
    if (!field || this.state() !== "ready") return Promise.resolve(null);
    const p = { ...this.params };
    return field.readFrame(frame, (lpi) => petOf(lpi, p), PET_NODATA, petMetadata(p)).then((read) => ({ read, params: p }));
  }

  status(): TemperatureStatus {
    return { state: this.state(), params: { ...this.params }, petRange: petRange(this.params) };
  }

  // --- the work ------------------------------------------------------------

  private state(): TemperatureState {
    const s = temperatureState(this.visible, this.upstream);
    // Ready only once there is a result to draw from.
    return s === "ready" && !this.field ? "waiting" : s;
  }

  /**
   * Read the direct-sun node: its state, which this layer's follows, and its
   * result. Both arrive through the DAG. Runs inside a DAG notification.
   */
  private pull(): void {
    this.upstream = this.graph.state<SunlightState>(LPI_NODE);
    const field = this.graph.value<LpiField>(LPI_NODE);
    if (field !== this.field) this.take(field);
    else this.changed();
  }

  /** A new upstream result, or none. Runs inside a DAG notification. */
  private take(field: LpiField | null): void {
    this.field = field;
    if (field) {
      this.nearTexture.sourceTexture = field.near.texture;
      this.farTexture.sourceTexture = field.far.texture;
      const u = this.material.uniforms;
      u.uNearDomain.value = field.near.domain.domainM;
      u.uFarDomain.value = field.far.domain.domainM;
      u.uReach.value.set(field.reach[0], field.reach[1]);
      this.overlay.scale.set(field.far.domain.domainM, field.far.domain.domainM, 1);
    } else {
      // Stop sampling textures that may be about to go.
      this.nearTexture.sourceTexture = null;
      this.farTexture.sourceTexture = null;
    }
    this.changed();
  }

  /** Something the drawing or the node depends on changed. */
  private changed(): void {
    const ready = this.state() === "ready";
    this.overlay.visible = ready;
    if (!ready && this.published) {
      // Clearing is allowed inside a notification; publishing is not.
      this.published = false;
      this.graph.clear(PET_NODE);
    }
    this.publishDue = ready;
    this.onStatus?.(this.status());
    this.repaint();
  }

  /** The model matrix: the local metre frame onto Mercator, y flipped. */
  private modelMatrix(domain: Domain): THREE.Matrix4 {
    return mercatorFrame(MercatorCoordinate.fromLngLat(domain.centre, 0), domain.metre);
  }

  // --- the frame -------------------------------------------------------------

  prerender(_gl: WebGL2RenderingContext): void {
    if (!this.publishDue || !this.field) return;
    this.publishDue = false;
    const value: PetField = { lpi: this.field, params: { ...this.params }, petRange: petRange(this.params) };
    this.published = true;
    this.graph.publish(PET_NODE, value);
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const field = this.field;
    if (!field || !this.overlay.visible) return;
    this.camera.projectionMatrix = projection(args, this.modelMatrix(field.near.domain));
    this.pass((renderer) => renderer.render(this.scene, this.camera));
  }

  dispose(): void {
    this.unsubscribe();
    if (this.published) this.graph.clear(PET_NODE);
    this.published = false;
    this.field = null;
    this.overlay.geometry.dispose();
    this.material.dispose();
    // The external textures are deliberately not disposed; see their field.
    super.dispose();
  }
}

/** The PET GeoTIFF's GDAL metadata: the parameters and the definition. */
function petMetadata(p: PetParams): Record<string, string> {
  return {
    g0_w_m2: String(p.g0),
    ta_c: String(p.ta),
    v_m_s: String(p.v),
    definition:
      "physiological equivalent temperature (PET, degC) = 0.0126*(G0*(0.5986*LPI+0.0116)) + 1.2537*Ta - 2.5537*V - 1.6374; " +
      "see app/src/layers/temperature/specs/spec.md",
  };
}
