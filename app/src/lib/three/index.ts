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

/** A perspective camera split into its two halves. See `decomposeCamera`. */
export interface DecomposedCamera {
  /** Perspective; its `w` row is exactly (0, 0, −1, 0). */
  projection: THREE.Matrix4;
  /** Rigid: a rotation (det +1) and a translation. */
  view: THREE.Matrix4;
}

/** How far the depth row may stray from the view's z axis, relative to it. */
const DEPTH_ROW_TOLERANCE = 1e-9;

/**
 * Split a clip-from-local matrix (`projection(args, model)`) back into a
 * perspective projection and a rigid view, with `P · V` equal to the input
 * times one positive scale. A renderer that needs view space (Spark's splat
 * footprints and culling) gets it from here, so `mainMatrix` is still read in
 * one place. Throws when the input is not a perspective camera of that form.
 * See `specs/spec.md`, *`decomposeCamera`*.
 */
export function decomposeCamera(clipFromLocal: THREE.Matrix4): DecomposedCamera {
  const e = clipFromLocal.elements;
  if (!e.every(Number.isFinite)) throw new Error("decomposeCamera: the matrix is not finite");
  // Rows of the column-major matrix.
  const row = (i: number) => [e[i], e[i + 4], e[i + 8], e[i + 12]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const wLen = Math.hypot(e[3], e[7], e[11]);
  if (!(wLen > 0)) throw new Error("decomposeCamera: no perspective w row");
  // A positive scale keeps w's sign, so what was in front stays in front.
  const [r0, r1, r2, r3] = [0, 1, 2, 3].map((i) => row(i).map((v) => v / wLen));

  // The camera looks down −z, so the view's z row is minus the w row.
  const z = r3.map((v) => -v);
  const cy = dot(r1, z);
  const yRaw = [0, 1, 2].map((i) => r1[i] - cy * z[i]);
  const fy = Math.hypot(...yRaw);
  const y = yRaw.map((v) => v / fy);
  const cx = dot(r0, z);
  const skew = dot(r0, y);
  const xRaw = [0, 1, 2].map((i) => r0[i] - cx * z[i] - skew * y[i]);
  const fx = Math.hypot(...xRaw);
  const x = xRaw.map((v) => v / fx);
  if (!(fx > 0 && fy > 0)) throw new Error("decomposeCamera: degenerate projection");

  const det = dot([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], z);
  if (det < 0) throw new Error("decomposeCamera: the frame is a reflection (det V < 0)");

  // Depth: (0, 0, A, B) in view space must reproduce the z row.
  const a = dot(r2, z);
  const off = Math.hypot(...[0, 1, 2].map((i) => r2[i] - a * z[i]));
  if (off > DEPTH_ROW_TOLERANCE * Math.abs(a)) throw new Error("decomposeCamera: the depth row is not a perspective depth");

  const tz = z[3];
  const ty = (r1[3] - cy * tz) / fy;
  const tx = (r0[3] - skew * ty - cx * tz) / fx;
  const b = r2[3] - a * tz;

  // `set` takes rows.
  const projection = new THREE.Matrix4().set(fx, skew, cx, 0, 0, fy, cy, 0, 0, 0, a, b, 0, 0, -1, 0);
  const view = new THREE.Matrix4().set(x[0], x[1], x[2], tx, y[0], y[1], y[2], ty, z[0], z[1], z[2], tz, 0, 0, 0, 1);
  return { projection, view };
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
