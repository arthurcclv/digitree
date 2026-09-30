import { vi } from "vitest";

/**
 * Test support: the browser's PNG encoder (`OffscreenCanvas`, `ImageData`)
 * stubbed for vitest, which has neither. It keeps the pixels it was last given
 * and answers with fixed bytes. Undo it with `vi.unstubAllGlobals()`.
 */
export function stubPngEncoder(): { pixels: () => Uint8ClampedArray } {
  let last: Uint8ClampedArray = new Uint8ClampedArray();
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(readonly data: Uint8ClampedArray) {}
    },
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { putImageData: (img: { data: Uint8ClampedArray }) => (last = img.data) };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
      }
    },
  );
  return { pixels: () => last };
}
