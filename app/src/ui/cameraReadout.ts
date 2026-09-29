/**
 * The status bar's figures, formatted. Pure, so it is the one part of the bar
 * `npm test` can reach.
 */

/** `25.0339° N` — four decimals is about 11 m, finer than a click can mean. */
export const formatCoord = (value: number, axis: "lat" | "lng"): string => {
  const hemi = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(4)}° ${hemi}`;
};

/** `15.20` — two decimals, the true zoom, not a rounded level. */
export const formatZoom = (zoom: number): string => zoom.toFixed(2);

/** `k` is omitted where the value names itself: `25.0339° N` needs no "Lat". */
export interface ReadoutItem {
  k?: string;
  v: string;
}

/** The bar's three figures, in reading order. */
export const cameraReadout = (camera: { lat: number; lng: number; zoom: number }): ReadoutItem[] => [
  { v: formatCoord(camera.lat, "lat") },
  { v: formatCoord(camera.lng, "lng") },
  { k: "Zoom", v: formatZoom(camera.zoom) },
];
