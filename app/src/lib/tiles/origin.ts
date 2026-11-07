// The origins of the servers the app fetches from directly (Martin, infra's
// `files`), read from build-time settings. Used by `src/sources.ts`, which
// builds the descriptors' URLs, and by `vite.config.ts`, which checks the
// same values at startup so a typo stops the build. See `specs/origins.md`.

export const TILES_URL_ENV = "VITE_TILES_URL";
export const DEFAULT_TILES_URL = "http://localhost:3000";

export const FILES_URL_ENV = "VITE_FILES_URL";
export const DEFAULT_FILES_URL = "http://localhost:3080";

/**
 * The origin a setting names, without a trailing `/`. Unset or blank is the
 * fallback; anything but a bare http(s) origin throws, naming the setting and
 * the value, because a wrong origin fails far from its cause.
 */
export function originOf(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? "";
  if (value === "") return fallback;
  const fail = (why: string): never => {
    throw new Error(`${name}=${JSON.stringify(raw)} is not usable: ${why}`);
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`expected an absolute URL such as ${fallback}`);
  }
  // `new URL("localhost:3000")` parses, with `localhost:` as the scheme.
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("the scheme must be http or https");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return fail("expected an origin only, with no path, query or hash");
  }
  return value.replace(/\/$/, "");
}
