/// <reference types="vite/client" />

// The servers the app fetches from directly; see `src/lib/tiles/specs/origins.md`.
interface ImportMetaEnv {
  readonly VITE_TILES_URL?: string;
  readonly VITE_FILES_URL?: string;
}
