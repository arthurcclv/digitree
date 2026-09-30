/**
 * Grids and images as PNG, for the ground textures and the tree models'
 * textures. See *Sunlight and temperature* and *Trees* in `specs/spec.md`.
 * `colourise` is pure; the encoders need a browser (`OffscreenCanvas`).
 */

/**
 * A value grid as RGBA: each value through `rampAt` (sRGB 0–1) at alpha 255,
 * each `nodata` cell transparent. Rows keep their order.
 */
export function colourise(
  values: Float32Array,
  nodata: number,
  rampAt: (v: number) => readonly [number, number, number],
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === nodata || Number.isNaN(v)) continue;
    const [r, g, b] = rampAt(v);
    out[i * 4] = Math.round(r * 255);
    out[i * 4 + 1] = Math.round(g * 255);
    out[i * 4 + 2] = Math.round(b * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

async function canvasPng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/** RGBA pixels, row 0 at the top, as a PNG. */
export function rgbaPng(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvasPng(canvas);
}

/** Any decoded image (a texture's, a canvas) re-encoded as PNG, unscaled. */
export function imagePng(image: CanvasImageSource, width: number, height: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
  return canvasPng(canvas);
}
