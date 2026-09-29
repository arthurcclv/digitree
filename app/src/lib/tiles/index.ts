// Tile fetching and building geometry shared by the self-fetching layers
// (sunlight, ambient occlusion). Not a layer: it has no record. The store is
// generic over its sources; see `specs/spec.md`.
export * from "./grid";
export { groundFootprint } from "./footprint";
export { addPrism, placeTile, TILE_UNITS, triangulateTile, type LocalFrame, type TilePrisms } from "./prisms";
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
