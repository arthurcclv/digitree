import type { ProxyOptions } from "vite";

// The same-origin `/tiles` proxy in front of Martin, for `vite.config.ts` only:
// the browser never imports this. Its target is a deploy-time setting, so a
// host whose :3000 is taken can point it elsewhere. See `specs/proxy.md`.

export const TILES_PREFIX = "/tiles";
export const TILES_PROXY_ENV = "TILES_PROXY_TARGET";
export const DEFAULT_TILES_PROXY_TARGET = "http://localhost:3000";

/**
 * The proxy entry for `/tiles`, read from Vite's loaded env. Unset or empty is
 * the default; anything that is not a bare http(s) origin throws, because a
 * typo that proxies to the wrong server fails as an undecodable tile, far from
 * its cause.
 */
export function tileProxy(env: Record<string, string | undefined>): ProxyOptions {
  return {
    target: tilesProxyTarget(env[TILES_PROXY_ENV]),
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/tiles(?=\/|$)/, ""),
  };
}

function tilesProxyTarget(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_TILES_PROXY_TARGET;
  const fail = (why: string): never => {
    throw new Error(`${TILES_PROXY_ENV}=${JSON.stringify(raw)} is not usable: ${why}`);
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("expected an absolute URL such as http://localhost:3000");
  }
  // `new URL("localhost:3000")` parses, with `localhost:` as the scheme.
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("the scheme must be http or https");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return fail("expected an origin only, with no path, query or hash");
  }
  return value.replace(/\/$/, "");
}
