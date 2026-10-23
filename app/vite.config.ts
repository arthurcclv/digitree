import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileProxy, tileProxy } from "./src/lib/tiles/proxy";

export default defineConfig(({ mode }) => {
  // The tree layer's tiles come from the Martin server in infra/. Proxying
  // keeps every tile request same-origin, so the app needs no CORS setup and
  // carries no absolute URL to a host that only exists in development —
  // which is also why the layer uses `source.tiles` rather than Martin's own
  // TileJSON, whose tile URL is absolute. Where Martin runs is
  // TILES_PROXY_TARGET (default http://localhost:3000), read from the
  // environment or app/.env*; see src/lib/tiles/specs/proxy.md. The preview
  // server is how the app is deployed, so it gets the proxy explicitly.
  // The splat captures come from infra's static file service the same way:
  // `/files` → FILES_PROXY_TARGET (default http://localhost:3080).
  // The "" prefix loads every variable, not only VITE_*: none reach the bundle.
  const env = loadEnv(mode, process.cwd(), "");
  const proxy = { "/tiles": tileProxy(env), "/files": fileProxy(env) };

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
    server: { port: 5173, proxy },
    preview: { proxy },
  };
});
