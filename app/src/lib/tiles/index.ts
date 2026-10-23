// Tile fetching and building geometry shared by the self-fetching layers
// (sunlight, ambient occlusion, splat). Not a layer: it has no record. The store is
// generic over its sources; see `specs/spec.md`.
export * from "./grid";
export { groundFootprint } from "./footprint";
export { settle } from "./settle";
export { frameAt, localToMercator, mercatorToLocal, planTiles, toLocal, type LocalFrame } from "./frame";
export { addPrism, placeTile, TILE_UNITS, triangulateTile, type TilePrisms } from "./prisms";
export {
  decodeMvt,
  FETCH_CONCURRENCY,
  TILE_CACHE_SIZE,
  TileStore,
  type BuildingFeature,
  type TileCounts,
  type TileGeometry,
  type TileLocation,
  type TileSource,
} from "./store";
