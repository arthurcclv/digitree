import type { ProxyOptions } from "vite";

// The same-origin proxies in front of infra, for `vite.config.ts` only: the
// browser never imports this. `/tiles` reaches Martin, `/files` the static
// file service. Each target is a deploy-time setting, so a host whose port is
// taken can point it elsewhere. See `specs/proxy.md`.

export const TILES_PREFIX = "/tiles";
export const TILES_PROXY_ENV = "TILES_PROXY_TARGET";
export const DEFAULT_TILES_PROXY_TARGET = "http://localhost:3000";

export const FILES_PREFIX = "/files";
export const FILES_PROXY_ENV = "FILES_PROXY_TARGET";
export const DEFAULT_FILES_PROXY_TARGET = "http://localhost:3080";

/** One same-origin proxy: the path it answers, and the env var naming its target. */
interface ProxyRoute {
  prefix: string;
  env: string;
  fallback: string;
}

const TILES: ProxyRoute = { prefix: TILES_PREFIX, env: TILES_PROXY_ENV, fallback: DEFAULT_TILES_PROXY_TARGET };
const FILES: ProxyRoute = { prefix: FILES_PREFIX, env: FILES_PROXY_ENV, fallback: DEFAULT_FILES_PROXY_TARGET };

/**
 * The proxy entry for `/tiles`, read from Vite's loaded env. Unset or empty is
 * the default; anything that is not a bare http(s) origin throws, because a
 * typo that proxies to the wrong server fails as an undecodable tile, far from
 * its cause.
 */
export function tileProxy(env: Record<string, string | undefined>): ProxyOptions {
  return proxyTo(TILES, env);
}

/** The proxy entry for `/files`, on the same rules as `/tiles`. */
export function fileProxy(env: Record<string, string | undefined>): ProxyOptions {
  return proxyTo(FILES, env);
}

function proxyTo(route: ProxyRoute, env: Record<string, string | undefined>): ProxyOptions {
  const strip = new RegExp(`^${route.prefix}(?=/|$)`);
  return {
    target: proxyTarget(route.env, route.fallback, env[route.env]),
    changeOrigin: true,
    rewrite: (path) => path.replace(strip, ""),
  };
}

function proxyTarget(name: string, fallback: string, raw: string | undefined): string {
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
