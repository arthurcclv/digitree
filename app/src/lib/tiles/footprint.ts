import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * The viewport's ground footprint, as lng/lat: the canvas corners unprojected
 * to the ground. A top corner above the horizon walks down its canvas edge in
 * 2% steps until it is on the ground. A corner that is merely far is kept; the
 * caller clips. Fewer than three points means no ground is in view.
 *
 * See *Coverage* in the sunlight spec, which defines it.
 */
export function groundFootprint(map: MapLibreMap): [number, number][] {
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const ground = (px: number, py: number): [number, number] | null => {
    const ll = map.unproject([px, py]);
    if (!Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return null;
    // Above the horizon, unproject does not fail: it returns a mirrored point
    // behind the camera. A real ground point projects back onto its pixel.
    const back = map.project(ll);
    if (Math.hypot(back.x - px, back.y - py) > 1) return null;
    return [ll.lng, ll.lat];
  };
  const corner = (px: number): [number, number] | null => {
    for (let step = 0; step <= 50; step++) {
      const p = ground(px, (step / 50) * h);
      if (p) return p;
    }
    return null;
  };
  return [ground(0, h), ground(w, h), corner(w), corner(0)].filter((p): p is [number, number] => p !== null);
}
