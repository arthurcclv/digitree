import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { mercatorFrame, PREMULTIPLIED_OVER, projection, ThreeLayer } from "./index";

/** The part of a map the base touches: `idle` handlers and the canvas. */
function fakeMap() {
  const idle = new Set<() => void>();
  const map = {
    on: (event: string, fn: () => void) => {
      if (event === "idle") idle.add(fn);
      return map;
    },
    off: (event: string, fn: () => void) => {
      if (event === "idle") idle.delete(fn);
      return map;
    },
    getCanvas: () => ({}) as HTMLCanvasElement,
    triggerRepaint: () => {},
  };
  return { map: map as unknown as MapLibreMap, idle, fireIdle: () => [...idle].forEach((fn) => fn()) };
}

/** A renderer with nothing behind it: no WebGL in the tests. */
function fakeRenderer(log: string[]) {
  return {
    resetState: () => log.push("reset"),
    dispose: vi.fn(),
  } as unknown as THREE.WebGLRenderer & { dispose: ReturnType<typeof vi.fn> };
}

const gl = () => ({}) as WebGL2RenderingContext;
const settle = () => new Promise((r) => setTimeout(r, 0));

class Probe extends ThreeLayer {
  readonly id = "probe";
  readonly log: string[] = [];
  readonly made: ReturnType<typeof fakeRenderer>[] = [];
  contexts = 0;
  attaches = 0;
  settles = 0;
  protected createRenderer(): THREE.WebGLRenderer {
    const r = fakeRenderer(this.log);
    this.made.push(r);
    return r;
  }
  protected contextChanged(): void {
    this.contexts++;
  }
  protected attached(): void {
    this.attaches++;
  }
  protected viewSettled(): void {
    this.settles++;
  }
  render(): void {}
  /** `pass`, from outside. */
  run(fn: () => void): void {
    this.pass(() => {
      this.log.push("draw");
      fn();
    });
  }
}

/** A layer with nothing to do when the view settles. */
class Quiet extends ThreeLayer {
  readonly id = "quiet";
  protected createRenderer(): THREE.WebGLRenderer {
    return fakeRenderer([]);
  }
  render(): void {}
}

describe("ThreeLayer lifecycle", () => {
  test("keeps its renderer for the same context, and rebuilds it for a new one", () => {
    const { map } = fakeMap();
    const layer = new Probe();
    const ctx = gl();
    layer.onAdd(map, ctx);
    layer.onRemove();
    layer.onAdd(map, ctx);
    expect(layer.made).toHaveLength(1);
    expect(layer.contexts).toBe(1);
    expect(layer.attaches).toBe(2);
    layer.onAdd(map, gl());
    expect(layer.made).toHaveLength(2);
    expect(layer.made[0].dispose).toHaveBeenCalledOnce();
    expect(layer.contexts).toBe(2);
  });

  test("onRemove keeps the renderer and stops listening for idle", () => {
    const { map, idle } = fakeMap();
    const layer = new Probe();
    layer.onAdd(map, gl());
    expect(idle.size).toBe(1);
    layer.onRemove();
    expect(idle.size).toBe(0);
    expect(layer.made[0].dispose).not.toHaveBeenCalled();
  });

  test("a burst of idle settles the view once", async () => {
    const { map, fireIdle } = fakeMap();
    const layer = new Probe();
    layer.onAdd(map, gl());
    fireIdle();
    fireIdle();
    fireIdle();
    await settle();
    expect(layer.settles).toBe(1);
    fireIdle();
    await settle();
    expect(layer.settles).toBe(2);
  });

  test("a layer without viewSettled never listens for idle", () => {
    const { map, idle } = fakeMap();
    new Quiet().onAdd(map, gl());
    expect(idle.size).toBe(0);
  });

  test("dispose frees the renderer", () => {
    const { map } = fakeMap();
    const layer = new Probe();
    layer.onAdd(map, gl());
    layer.dispose();
    expect(layer.made[0].dispose).toHaveBeenCalledOnce();
  });
});

describe("pass", () => {
  test("resets state before and after the work", () => {
    const { map } = fakeMap();
    const layer = new Probe();
    layer.onAdd(map, gl());
    layer.run(() => {});
    expect(layer.log).toEqual(["reset", "draw", "reset"]);
  });

  test("resets after even when the work throws", () => {
    const { map } = fakeMap();
    const layer = new Probe();
    layer.onAdd(map, gl());
    expect(() =>
      layer.run(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(layer.log).toEqual(["reset", "draw", "reset"]);
  });

  test("does nothing without a renderer", () => {
    const layer = new Probe();
    layer.run(() => {});
    expect(layer.log).toEqual([]);
  });
});

describe("projection", () => {
  test("follows mainMatrix, never modelViewProjectionMatrix", () => {
    const main = new THREE.Matrix4().makeScale(2, 3, 4);
    const args = {
      defaultProjectionData: { mainMatrix: main.toArray() },
      modelViewProjectionMatrix: new THREE.Matrix4().makeTranslation(9, 9, 9).toArray(),
    } as unknown as CustomRenderMethodInput;
    const model = new THREE.Matrix4().makeTranslation(1, 0, 0);
    expect(projection(args, model).toArray()).toEqual(main.clone().multiply(model).toArray());
  });
});

describe("mercatorFrame", () => {
  test("maps local metres onto Mercator, y flipped", () => {
    const origin = { x: 0.8, y: 0.4, z: 0.01 };
    const metre = 1e-7;
    const p = new THREE.Vector3(10, 20, 30).applyMatrix4(mercatorFrame(origin, metre));
    expect(p.x).toBeCloseTo(0.8 + 10 * metre, 12);
    expect(p.y).toBeCloseTo(0.4 - 20 * metre, 12);
    expect(p.z).toBeCloseTo(0.01 + 30 * metre, 12);
    expect(new THREE.Vector3().applyMatrix4(mercatorFrame({ x: 1, y: 2 }, metre)).z).toBe(0);
  });
});

describe("PREMULTIPLIED_OVER", () => {
  test("composites premultiplied colour the way MapLibre blends", () => {
    expect(PREMULTIPLIED_OVER).toEqual({
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
  });
});
