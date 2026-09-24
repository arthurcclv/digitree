/**
 * The z14 tile grid the self-fetching layers share, and the Web Mercator
 * formulas it rests on. Pure — no fetch, no GL.
 *
 * The formulas match MapLibre's own `MercatorCoordinate`, so a frame placed
 * on the map and one computed here are the same frame.
 */

/** Both self-fetching layers fetch on this one grid. It is the buildings' max zoom. */
export const TILE_ZOOM = 14;

export interface TileId {
  x: number;
  y: number;
  z: number;
}

export const tileKey = (t: TileId) => `${t.z}/${t.x}/${t.y}`;

export interface MercatorPoint {
  x: number;
  y: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;

export function lngLatToMercator(lng: number, lat: number): MercatorPoint {
  return {
    x: (180 + lng) / 360,
    y: (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360,
  };
}

/** Mercator units per metre on the ground at a latitude. */
export function metreInMercator(lat: number): number {
  return 1 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180));
}

/** The tile holding a Mercator point. */
export function tileOfMercator(p: MercatorPoint, z = TILE_ZOOM): TileId {
  const n = 2 ** z;
  return { x: Math.floor(p.x * n), y: Math.floor(p.y * n), z };
}

export function tileOfLngLat(lng: number, lat: number, z = TILE_ZOOM): TileId {
  return tileOfMercator(lngLatToMercator(lng, lat), z);
}

/** Is a tile inside a lng/lat box (`[west, south, east, north]`)? */
export function tileIntersects(t: TileId, bounds: [number, number, number, number]): boolean {
  const n = 2 ** t.z;
  const west = (t.x / n) * 360 - 180;
  const east = ((t.x + 1) / n) * 360 - 180;
  const lat = (y: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const north = lat(t.y);
  const south = lat(t.y + 1);
  return east > bounds[0] && west < bounds[2] && north > bounds[1] && south < bounds[3];
}
