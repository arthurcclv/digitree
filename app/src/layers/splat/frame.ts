import * as THREE from "three";
import {
  frameAt,
  lngLatToMercator,
  mercatorToLocal,
  metreInMercator,
  trueMetreAxes,
  type LocalFrame,
  type MetreAxes,
} from "../../lib/tiles";
import { SPLAT_REBASE_M } from "./constants";
import type { Splat } from "./schema";

/**
 * Where the layer's frame is built: a `LocalFrame`, fixed while navigating,
 * moved only by `rebased`. Drawn as `mercatorFrame(origin, metre)`. See *The
 * frame* in `specs/spec.md`.
 */
export type Anchor = LocalFrame;

/**
 * The anchor at the view centre, once the centre is past `SPLAT_REBASE_M` from
 * `anchor`; `null` within it, where the anchor stays.
 */
export function rebased(anchor: Anchor, lng: number, lat: number): Anchor | null {
  const m = lngLatToMercator(lng, lat);
  const { origin, metre } = anchor;
  return Math.hypot(m.x - origin.x, m.y - origin.y) / metre <= SPLAT_REBASE_M ? null : frameAt(lng, lat);
}

/** A capture placed in an anchor's frame: everything its mesh needs. */
export interface Placed {
  /** The mesh's transform, `translation · k · similarity`: what Spark can carry. */
  matrix: THREE.Matrix4;
  /** The capture's origin in the frame: what the stretch is about. */
  origin: THREE.Vector3;
  /** The per-axis scale the stretch applies about `origin`. */
  axes: MetreAxes;
}

/**
 * The capture in the anchor's frame, its size in its own latitude's metres.
 * Its whole transform is `translation · k · diag(east, north, 1) · similarity`,
 * split in two because Spark reduces a mesh's matrix to one scale: `matrix`
 * carries the rest, and the stretch (`makeStretch`) moves each splat to
 * `origin + diag(axes)·(c − origin)`. The two agree because `k` is uniform.
 * The offset from the anchor is in double precision, so it stays exact far
 * from it. See *The frame*.
 */
export function placeCapture(splat: Pick<Splat, "lngLat" | "altitudeM" | "headingDeg" | "scale">, anchor: Anchor): Placed {
  const [lng, lat] = splat.lngLat;
  const k = metreInMercator(lat) / anchor.metre;
  const [east, north] = mercatorToLocal(anchor, lngLatToMercator(lng, lat));
  const at = new THREE.Vector3(east, north, splat.altitudeM * k);
  const matrix = new THREE.Matrix4().makeTranslation(at).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(similarity(splat));
  return { matrix, origin: at, axes: axesOf(splat) };
}

/**
 * The part of the transform a Spark mesh's matrix can carry: a rotation and
 * one scale, in true metres. A heading turns local +y clockwise from north,
 * which is −heading about up.
 */
export function similarity(splat: Pick<Splat, "headingDeg" | "scale">): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeRotationZ(THREE.MathUtils.degToRad(-splat.headingDeg))
    .scale(new THREE.Vector3(splat.scale, splat.scale, splat.scale));
}

/**
 * The rest: the map's metres per true metre on each axis, at the capture's
 * latitude. One value per capture: across 300 m they vary by under 1e-7.
 */
export function axesOf(splat: Pick<Splat, "lngLat">): MetreAxes {
  return trueMetreAxes(splat.lngLat[1]);
}
