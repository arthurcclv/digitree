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
 * farthest. Each needs at least its root page in Spark's pool (96 pages at
 * the least, on iOS).
 */
export const SPLAT_MAX_CAPTURES = 16;

/**
 * Spark's covariance blur for captures trained with anti-aliasing, as every
 * current one is (the SPZ header's `antialiased` flag). See *Renderer*.
 */
export const SPLAT_BLUR_AMOUNT = 0.3;

/**
 * The frame's anchor moves to the view centre, once the view settles, only past
 * this many metres from it. Within it float32 loses about 1 mm. See *The frame*.
 */
export const SPLAT_REBASE_M = 20_000;
