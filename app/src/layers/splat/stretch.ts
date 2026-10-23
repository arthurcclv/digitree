import * as THREE from "three";
import type { GsplatModifier } from "@sparkjsdev/spark";
import type { MetreAxes } from "../../lib/tiles";

type Dyno = typeof import("@sparkjsdev/spark").dyno;

/** A capture's per-axis scale, as a Spark world modifier. */
export interface Stretch {
  modifier: GsplatModifier;
  /** The capture's origin in the layer's frame: what the stretch is about. */
  setOrigin(origin: THREE.Vector3): void;
}

/**
 * Moves each splat's centre to `o + diag(east, north, 1)·(c − o)`, with `o`
 * the capture's origin, in world space (the layer's frame, after the mesh's
 * transform). Spark reduces a mesh's matrix to one scale, so the per-axis part
 * of `placement` cannot ride in `mesh.matrix`. The Gaussians' shapes are left
 * as they are: a 0.4% stretch of a splat is invisible. See *The frame*.
 */
export function makeStretch(dyno: Dyno, axes: MetreAxes): Stretch {
  const origin = new dyno.DynoVec3({ value: new THREE.Vector3() });
  const scale = new dyno.DynoVec3({ value: new THREE.Vector3(axes.east, axes.north, 1) });
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error("stretch: no gsplat");
    const { center } = dyno.splitGsplat(gsplat).outputs;
    const moved = dyno.add(origin, dyno.mul(scale, dyno.sub(center, origin)));
    return { gsplat: dyno.combineGsplat({ gsplat, center: moved }) };
  });
  return { modifier, setOrigin: (o) => origin.value.copy(o) };
}
