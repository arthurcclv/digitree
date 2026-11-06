import type { SplatStatus } from "../layers/splat";

/**
 * The splat panel's State line (*Settings* in the splat spec). Pure, so `npm
 * test` can reach it.
 */
export const splatStateText = (s: SplatStatus | null, minZoom: number, zoom: number): string => {
  if (zoom < minZoom) return `zoom in to z${minZoom}`;
  if (!s || s.state === "idle") return "none in view";
  if (s.state === "loading")
    return `loading ${s.loading.length === 1 ? s.loading[0] : s.loading.length} (${s.loaded}/${s.known})`;
  return `${s.loaded}/${s.known} loaded` + (s.errors.length ? ` · ${s.errors.length} failed` : "");
};
