/**
 * The layer's own ids. Shared by the GeoLibre record and the three.js layer,
 * hence its own module, so neither of those has to import the other. Where the
 * captures are served is not here: that is the host's `SplatSource`.
 */

/** GeoLibre record id. */
export const SPLAT_LAYER_ID = "threejs-splat";

/** The MapLibre custom layer's id, which GeoLibre moves into the record's slot. */
export const SPLAT_NATIVE_LAYER_ID = "threejs-splat-native";

/**
 * Below this zoom nothing new is fetched or loaded, and loaded captures are not
 * drawn. A ~150 m capture is a few dozen pixels at z14, not worth 90 MB.
 */
export const SPLAT_MIN_ZOOM = 15;

/** Tiles are fetched over the view, clipped to this many metres around its centre. */
export const SPLAT_FETCH_HALF_M = 2048;

/**
 * On a settled view, a loaded capture farther than this from the centre is
 * unloaded. It exceeds the farthest a capture can load from (the fetch
 * half-square, a partial z14 tile and one ring: about 9.1 km on the diagonal),
 * so a capture just loaded is never unloaded on the next settle. See *Which
 * captures load*.
 */
export const SPLAT_KEEP_M = 10_000;

/**
 * At most this many captures are loaded at once; a nearer one unloads the
 * farthest. A capture is a 100 m tile of infra's mosaic, and the cap is set
 * well above the tiles the delivered scans make, so every tile loads. Each
 * needs at least its root page in Spark's pool (128 pages on desktop, 96 on
 * iOS). See *Which captures load*.
 */
export const SPLAT_MAX_CAPTURES = 256;

/**
 * At most this many captures load at once (`SplatMesh` through its `.rad`
 * header). Header requests share the origin's 6 HTTP/1.1 connections with
 * Spark's chunk fetchers. See *Which captures load*.
 */
export const SPLAT_LOAD_CONCURRENCY = 3;

/**
 * Spark's `numLodFetchers`: chunk files fetched at once, across every capture
 * (Spark's default is 3). 4 leaves 2 of the origin's 6 HTTP/1.1 connections
 * for tiles and headers. See *Level of detail*.
 */
export const SPLAT_LOD_FETCHERS = 4;

/**
 * Spark's covariance blur for captures trained with anti-aliasing, as every
 * current one is (the scans' `antialiased` flag). See *Renderer*.
 */
export const SPLAT_BLUR_AMOUNT = 0.3;

/**
 * Spark's page pool on desktop, in pages of 65,536 splats: half its default,
 * because each splat takes 32 B with `pagedExtSplats` (float32 centres), so
 * the pool holds the same 256 MB as before. Mobile keeps Spark's default. See
 * *Level of detail*.
 */
export const SPLAT_DESKTOP_POOL_PAGES = 128;

/** Splats in one of Spark's LoD pages; `maxPagedSplats` must be a multiple. */
export const SPARK_PAGE_SPLATS = 65_536;

/**
 * Spark's own defaults for `SparkRenderer.sortRadial` and `coneFoveate`, which
 * the layer starts from, so the image is unchanged until they are moved. See
 * *Settings*.
 */
export const SPARK_SORT_RADIAL = true;
export const SPARK_CONE_FOVEATE = 0.4;

/**
 * The frame's anchor moves to the view centre, once the view settles, only past
 * this many metres from it. Within it float32 loses about 1 mm. See *The frame*.
 */
export const SPLAT_REBASE_M = 20_000;
