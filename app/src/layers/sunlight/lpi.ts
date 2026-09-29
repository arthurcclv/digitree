import type { Domain, Vec2 } from "./frame";
import type { ProbeResult } from "./sunlightLayer";

/**
 * The layer's DAG node and what it publishes. See *The LPI node* in
 * `specs/spec.md`.
 */

export const LPI_NODE = "sunlight.lpi";

/** One level of a published result: its render target's texture and its grid. */
export interface LpiLevel {
  /** Valid until the node is cleared or re-published. Never delete it. */
  texture: WebGLTexture;
  domain: Domain;
}

export interface LpiField {
  near: LpiLevel;
  far: LpiLevel;
  covered: ReadonlySet<string>;
  reach: Vec2;
  sunTime: number;
  azimuthDeg: number;
  elevationDeg: number;
  /** The index at a point, for this result. */
  probe(lng: number, lat: number): Promise<ProbeResult>;
  /**
   * The near grid as a GeoTIFF, every complete cell's index mapped through
   * `transform`, every other cell `nodata`. `metadata` replaces the export's
   * `definition` and adds items.
   */
  readNear(
    transform: (index: number) => number,
    nodata: number,
    metadata: Record<string, string>,
  ): Promise<Blob | null>;
}

/**
 * The GLSL both overlays sample a result with: `sampleAt(p)` gives R τ, G roof,
 * B coverage at a point of the near frame, and `vec4(0)` outside both grids.
 * It needs the uniforms `uNear`, `uFar`, `uNearDomain`, `uFarDomain`.
 */
export const LPI_SAMPLE_GLSL = /* glsl */ `
  uniform sampler2D uNear;
  uniform sampler2D uFar;
  uniform float uNearDomain;
  uniform float uFarDomain;

  bool inNear(vec2 p) { return abs(p.x) < 0.5 * uNearDomain && abs(p.y) < 0.5 * uNearDomain; }

  vec4 sampleAt(vec2 p) {
    if (inNear(p)) return texture2D(uNear, p / uNearDomain + 0.5);
    vec2 uv = p / uFarDomain + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec4(0.0);
    return texture2D(uFar, uv);
  }
`;
