import { Map as MapLibreMap } from "maplibre-gl";
import { groundPackage, imagePng, mercatorBounds, UsdExportError, type ExportFrame, type UsdPackage } from "../../lib/usd";

/**
 * The basemap as a USD package: the current style rendered top-down in a
 * hidden map, fitted to the frame, on a ground quad. See *Basemap* in
 * `src/lib/usd/specs/spec.md`.
 */

export const BASEMAP_USD_NAME = "basemap";
/** Texture pixels per ground metre, before the GPU's cap. */
export const BASEMAP_PX_PER_M = 2;
/** A capture that has not settled by then is given up. */
export const BASEMAP_CAPTURE_TIMEOUT_MS = 60_000;
/**
 * The largest capture canvas, MapLibre's own default `maxCanvasSize`. Browsers
 * refuse larger WebGL canvases on common GPUs even when `MAX_TEXTURE_SIZE`
 * allows them (8,192² failed where the limit said 8,192).
 */
export const BASEMAP_MAX_CANVAS_PX = 4096;
/** MapLibre's tile size: the world is `512 · 2^zoom` pixels across. */
const WORLD_TILE_PX = 512;

/** The ground square: the frame, grown to `extentM` (a half-side) when that is larger. */
export function groundFrame(frame: ExportFrame, extentM?: number): ExportFrame {
  return { centre: frame.centre, sizeM: Math.max(frame.sizeM, 2 * (extentM ?? 0)) };
}

/** The hidden map's view: a square canvas of `px`, whose zoom fits the square exactly. */
export function captureView(frame: ExportFrame, maxTexturePx: number): { px: number; zoom: number; center: [number, number] } {
  const px = Math.min(Math.round(frame.sizeM * BASEMAP_PX_PER_M), maxTexturePx, BASEMAP_MAX_CANVAS_PX);
  const b = mercatorBounds(frame);
  const zoom = Math.log2(px / (WORLD_TILE_PX * (b.maxX - b.minX)));
  return { px, zoom, center: [frame.centre.lng, frame.centre.lat] };
}

/** The largest texture this browser's WebGL allows; the canvas cap if it cannot say. */
function maxTextureSize(): number {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return BASEMAP_MAX_CANVAS_PX;
  // `getParameter` is typed `any`; for MAX_TEXTURE_SIZE it is a GLint.
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return max;
}

/** The two calls `hideForCapture` makes on a map; a MapLibre map is one. */
interface StyledMap {
  getStyle(): { layers?: readonly { id: string; type: string }[] };
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
}

/**
 * Everything the ground texture must not carry: buildings (the extrusion's) and
 * labels (screen-space). `hideBuildings` is `hideBasemapBuildings`, passed in
 * because `index.ts` imports this module and importing it back would be a
 * cycle.
 */
export function hideForCapture<M extends StyledMap>(map: M, hideBuildings: (map: M) => void): void {
  hideBuildings(map);
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === "symbol") map.setLayoutProperty(layer.id, "visibility", "none");
  }
}

/** Render the style over the frame and read it back as PNG. */
async function capture(styleUrl: string, frame: ExportFrame, hideBuildings: (map: MapLibreMap) => void): Promise<Uint8Array> {
  const view = captureView(frame, maxTextureSize());
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${view.px}px`,
    height: `${view.px}px`,
    pointerEvents: "none",
  });
  document.body.appendChild(container);
  let map: MapLibreMap | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const m = new MapLibreMap({
      container,
      style: styleUrl,
      center: view.center,
      zoom: view.zoom,
      pitch: 0,
      bearing: 0,
      pixelRatio: 1,
      maxCanvasSize: [view.px, view.px],
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      renderWorldCopies: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    map = m;
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("the basemap did not finish loading")), BASEMAP_CAPTURE_TIMEOUT_MS);
      m.once("style.load", () => {
        hideForCapture(m, hideBuildings);
        m.once("idle", () => resolve());
      });
      m.on("error", (e) => {
        if (!m.isStyleLoaded()) reject(e.error ?? new Error("the basemap style failed"));
      });
    });
    const canvas = m.getCanvas();
    return await imagePng(canvas, canvas.width, canvas.height);
  } finally {
    clearTimeout(timer);
    map?.remove();
    container.remove();
  }
}

export async function basemapPackage(
  styleUrl: string,
  frame: ExportFrame,
  attribution: string,
  hideBuildings: (map: MapLibreMap) => void,
  extentM?: number,
): Promise<UsdPackage> {
  const ground = groundFrame(frame, extentM);
  let png: Uint8Array;
  try {
    png = await capture(styleUrl, ground, hideBuildings);
  } catch (e) {
    throw new UsdExportError(BASEMAP_USD_NAME, "failed", e instanceof Error ? e.message : String(e));
  }
  return groundPackage({
    name: BASEMAP_USD_NAME,
    prim: "Basemap",
    frame,
    z: 0,
    halfM: ground.sizeM / 2,
    png,
    masked: false,
    attribution: [attribution],
    custom: { style: styleUrl, groundSizeM: ground.sizeM },
  });
}
