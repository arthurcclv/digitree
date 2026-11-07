import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import {
  DEFAULT_FILES_URL,
  DEFAULT_TILES_URL,
  FILES_URL_ENV,
  originOf,
  TILES_URL_ENV,
} from "./src/lib/tiles/origin";

export default defineConfig(({ mode }) => {
  // The browser fetches Martin and infra's `files` directly, cross-origin: no
  // proxy (src/lib/tiles/specs/origins.md). Their origins are the build-time
  // settings VITE_TILES_URL and VITE_FILES_URL, read by src/sources.ts. They
  // are checked here too, so a malformed value stops `vite`, `vite build` and
  // `vite preview` instead of shipping a bundle that fetches from nowhere.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  originOf(TILES_URL_ENV, env[TILES_URL_ENV], DEFAULT_TILES_URL);
  originOf(FILES_URL_ENV, env[FILES_URL_ENV], DEFAULT_FILES_URL);

  return {
    plugins: [react()],
    // MapLibre resolves its worker as a sibling of its own module URL
    // (`new URL("./maplibre-gl-worker.mjs", import.meta.url)`). Vite's dependency
    // pre-bundler rewrites that module into .vite/deps without copying the worker,
    // so the worker 404s and no tile is ever parsed. Serving MapLibre unbundled
    // keeps the worker next to it, and dedupe guarantees GeoLibre's layer sync and
    // the map instance come from the same copy of the library.
    optimizeDeps: { exclude: ["maplibre-gl"] },
    // MapLibre spawns its worker with `{ type: "module" }`, so the bundled worker
    // has to be an ES module rather than Vite's default IIFE.
    worker: { format: "es" },
    resolve: { dedupe: ["maplibre-gl", "react", "react-dom"] },
    server: { port: 5173 },
  };
});
