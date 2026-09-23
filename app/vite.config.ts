import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
  server: {
    port: 5173,
    // The tree layer's tiles come from the Martin server in infra/. Proxying
    // keeps every tile request same-origin, so the app needs no CORS setup and
    // carries no absolute URL to a host that only exists in development —
    // which is also why the layer uses `source.tiles` rather than Martin's own
    // TileJSON, whose tile URL is absolute.
    proxy: {
      "/tiles": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tiles/, ""),
      },
    },
  },
});
