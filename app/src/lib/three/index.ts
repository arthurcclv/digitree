/**
 * How a three.js layer shares MapLibre's GL context: one place for the rules
 * that fail silently when one layer gets them wrong. See `specs/spec.md`.
 */
import * as THREE from "three";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";

/**
 * A MapLibre custom layer drawn with three.js. The base owns the renderer's
 * lifecycle and the `idle` subscription; a subclass writes its own `render`
 * (and `prerender`, only if it has offscreen work: MapLibre gives any layer
 * with one an offscreen pass) and wraps its three.js drawing in `pass`.
 */
export abstract class ThreeLayer implements CustomLayerInterface {
  abstract readonly id: string;
  readonly type = "custom" as const;
  /** Shares MapLibre's depth buffer, so the extrusions occlude what we draw. */
  readonly renderingMode = "3d" as const;

  protected map: MapLibreMap | null = null;
  protected gl: WebGL2RenderingContext | null = null;
  protected renderer: THREE.WebGLRenderer | null = null;
  private settleQueued = false;

  abstract render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void;

  /** A new renderer on a new context: drop what the old one owned, probe capabilities. */
  protected contextChanged?(renderer: THREE.WebGLRenderer): void;
  /** After every `onAdd`, the renderer in place. */
  protected attached?(): void;
  /** The view settled: a burst of `idle`, once. Implementing it subscribes to `idle`. */
  protected viewSettled?(): void;

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    // A basemap swap removes and re-adds the layer against the same canvas and
    // context, so keep the renderer rather than rebuilding it every time.
    if (!this.renderer || this.gl !== gl) {
      this.renderer?.dispose();
      this.gl = gl;
      this.renderer = this.createRenderer(map, gl);
      this.contextChanged?.(this.renderer);
    }
    if (this.viewSettled) map.on("idle", this.onIdle);
    this.attached?.();
  }

  onRemove(): void {
    // The renderer outlives a style change; only the map reference is dropped.
    this.map?.off("idle", this.onIdle);
    this.map = null;
  }

  /** Map teardown only. A subclass frees its own resources, then calls this. */
  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.gl = null;
  }

  /** The one renderer on MapLibre's context. Overridden by tests, which have no WebGL. */
  protected createRenderer(map: MapLibreMap, gl: WebGL2RenderingContext): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    // Never clear MapLibre's buffer.
    renderer.autoClear = false;
    return renderer;
  }

  /**
   * Three.js work on the shared context, handed over and back in a known
   * state. Nothing happens without a renderer.
   */
  protected pass(fn: (renderer: THREE.WebGLRenderer) => void): void {
    const renderer = this.renderer;
    if (!renderer) return;
    renderer.resetState();
    try {
      fn(renderer);
    } finally {
      renderer.resetState();
    }
  }

  protected repaint(): void {
    this.map?.triggerRepaint();
  }

  /** Coalesce the bursts of `idle` a single gesture can produce. */
  private readonly onIdle = (): void => {
    if (this.settleQueued) return;
    this.settleQueued = true;
    queueMicrotask(() => {
      this.settleQueued = false;
      this.viewSettled?.();
    });
  };
}

/**
 * MapLibre v6's projection for a model: `defaultProjectionData.mainMatrix`,
 * which takes unit Mercator coordinates (what `MercatorCoordinate` produces)
 * to clip space, times `model`. Not `modelViewProjectionMatrix`: that is a
 * different world space and puts everything outside the frustum, silently.
 */
export function projection(args: CustomRenderMethodInput, model: THREE.Matrix4): THREE.Matrix4 {
  // `mainMatrix` is a gl-matrix mat4, which `fromArray` accepts but is not typed to.
  return new THREE.Matrix4()
    .fromArray(args.defaultProjectionData.mainMatrix as ArrayLike<number> as number[])
    .multiply(model);
}

/**
 * A local frame in metres (x east, y north, z up) onto Mercator, whose y
 * points south: a translation to `origin`, then `metre` per metre, y flipped.
 */
export function mercatorFrame(origin: { x: number; y: number; z?: number }, metre: number): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(origin.x, origin.y, origin.z ?? 0)
    .scale(new THREE.Vector3(metre, -metre, metre));
}

/**
 * A `ShaderMaterial` that emits premultiplied colour, composited over the
 * frame: MapLibre blends with `ONE, ONE_MINUS_SRC_ALPHA`.
 */
export const PREMULTIPLIED_OVER = {
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;
