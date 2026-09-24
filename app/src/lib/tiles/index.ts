// Tile fetching and building geometry shared by the self-fetching layers
// (sunlight, ambient occlusion). Not a layer: it has no record and no spec of
// its own; the sunlight spec's *Data* section defines the behaviour.
export * from "./grid";
export { groundFootprint } from "./footprint";
export { addPrism, placeTile, TILE_UNITS, triangulateTile, type LocalFrame, type TilePrisms } from "./prisms";
export {
  buildingHeight,
  FETCH_CONCURRENCY,
  TILE_CACHE_SIZE,
  TileStore,
  type BuildingFeature,
  type TileCounts,
  type TileSourceName,
  type TreeFeature,
} from "./store";
