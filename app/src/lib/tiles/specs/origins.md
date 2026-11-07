# Direct origins for Martin and `files` — spec

Status: **approved 2026-11-07, implemented.** Supersedes `specs/proxy.md`
(the `/tiles` and `/files` proxies), deleted with the implementation.

## Purpose

The app reaches infra through two same-origin Vite proxies: `/tiles` →
`TILES_PROXY_TARGET` (Martin), `/files` → `FILES_PROXY_TARGET` (`files`). They
existed because neither server sent CORS headers usable by the app. Since
`infra/specs/network-access.md` (2026-11-06) both do: Martin allows any origin
(pinned by `infra/test/martin.sh`), and `files` sends
`Access-Control-Allow-Origin: *`, exposes the range headers and answers the
`Range` preflight. The proxies are now only cost:

- a Node hop in front of every tile and chunk, on HTTP/1.1;
- `/tiles` and `/files` share the app's one origin, so the six-connection cap
  is split between them (DECISIONS 2026-11-06, *splat captures plan on
  `moveend`*);
- the app cannot use `files`' HTTPS + HTTP/2 listener on `:3443`;
- the app is tied to `vite`/`vite preview` as its server: `dist/` cannot be
  served by anything that lacks the proxy.

This spec removes both proxies. The browser fetches Martin and `files`
directly, cross-origin.

## Behaviour

1. **Two build-time settings, `VITE_TILES_URL` and `VITE_FILES_URL`.** Each is
   the origin of one server: Martin, and `files`. Example:
   `VITE_TILES_URL=http://192.168.81.32:3001`,
   `VITE_FILES_URL=https://192.168.81.32:3443`.
2. **They are read by Vite** (`import.meta.env`), from the process environment
   or `app/.env*`, in Vite's usual precedence. The `VITE_` prefix is required:
   unlike the proxy targets, the values now **do** reach the bundle, because
   the browser is the one that connects. They are fixed at `npm run build`
   time (and at `npm run dev` start); changing one means rebuilding.
3. **Defaults are `http://localhost:3000` and `http://localhost:3080`**, the
   old proxy defaults, so local development with infra on its default ports
   needs no setup.
4. **Validation is unchanged from the proxy's rule**: an absolute `http:` or
   `https:` URL with no path beyond `/`, no query, no hash; one trailing `/`
   dropped; unset or blank means the default. A malformed value makes `vite`,
   `vite build` and `vite preview` exit with an error naming the variable and
   the value: `vite.config.ts` validates both at config time, so a typo never
   ships as a bundle that fetches from nowhere.
5. **`src/sources.ts` builds absolute URLs from them** and stays the only
   place an endpoint lives:

   | field | value |
   | --- | --- |
   | `TREES.tiles` | `${TILES_URL}/trees/{z}/{x}/{y}` |
   | `SPLATS.tiles` | `${TILES_URL}/splats/{z}/{x}/{y}` |
   | `SPLATS.files` | `${FILES_URL}/3dgs/` |
   | `SPLATS.lodFiles` | `${FILES_URL}/3dgs-lod/` |

   The `/tiles` and `/files` prefixes disappear; the paths are the servers'
   own (`network-access.md`, *What a direct client uses*). Layers are
   unchanged: they already take every URL from the descriptor.
6. **The tree layer still uses `source.tiles`, never Martin's TileJSON.** The
   reason changes: not CORS, but that Martin builds the TileJSON's tile URL
   from the request's `Host`, and `tiles` with explicit `minzoom`, `maxzoom`
   and `bounds` stays independent of that.
7. **No proxy remains.** `vite.config.ts` sets no `server.proxy` or
   `preview.proxy`, and `src/lib/tiles/proxy.ts` and its test are deleted.
   `TILES_PROXY_TARGET` and `FILES_PROXY_TARGET` are no longer read; a stale
   one in an `.env` is ignored.
8. **Byte ranges** are the browser's and `files`' business: Spark's `Range`
   request goes straight to `files`, which answers `206` with
   `Content-Range` exposed.
9. **When a server is down** the layer renders nothing and the map keeps
   working, as before. The failure now shows as a network/CORS error in the
   console instead of a proxy `502`.
10. **Concurrency numbers stay as they are** (`SPLAT_LOAD_CONCURRENCY` 3,
    `SPLAT_LOD_FETCHERS` 4). Separate origins and HTTP/2 meet that decision's
    *revisit if*, but raising them is a separate, measured change.

## Deploy consequences

- **The browser must be able to reach both servers**, not only the app's host.
  A remote deploy therefore needs infra published beyond `127.0.0.1`
  (`PUBLISH_ADDR=0.0.0.0 MARTIN_PORT=3001 ./load.sh`), and the app built with
  that host's address:
  `VITE_TILES_URL=http://192.168.81.32:3001 VITE_FILES_URL=http://192.168.81.32:3080 npm run build`.
  The `localhost` defaults only work when the browser runs on the infra host.
- **Mixed content.** An app served over HTTPS cannot fetch `http://` Martin.
  `files` can be `https://…:3443` (operator certificate); Martin has no TLS.
  The app is served over plain HTTP today (`vite preview`), so this is a
  limit, not a regression.
- `dist/` becomes servable by any static server; `vite preview` is no longer
  required, only conventional.

## Where it lives

- `src/lib/tiles/origin.ts`: a pure `originOf(name, value, fallback)` —
  rule 4, returning the origin without a trailing `/` or throwing. Imports
  nothing from `src/layers/` or Vite.
- `src/sources.ts`: reads `import.meta.env.VITE_TILES_URL` /
  `VITE_FILES_URL` through `originOf`, and builds the four fields of rule 5.
- `vite.config.ts`: `loadEnv` + `originOf` on both, for rule 4's fail-fast;
  no proxy.
- `src/vite-env.d.ts`: types for the two variables.

## Invariants (vitest)

1. `origin.test.ts`: unset/blank → fallback; a valid value as given, minus a
   trailing `/`; `ftp://x`, `localhost:3000`, `http://h/tiles`,
   `http://h?x=1`, `http://h#x` and `not a url` each throw with the
   variable's name and the value. (The proxy's assertions, moved.)
2. `sources.test.ts`: with the variables unset, `TREES.tiles` is
   `http://localhost:3000/trees/{z}/{x}/{y}`, `SPLATS.tiles`
   `http://localhost:3000/splats/{z}/{x}/{y}`, `SPLATS.lodFiles`
   `http://localhost:3080/3dgs-lod/`; with them stubbed (`vi.stubEnv` +
   re-import), the fields follow.
3. `structure.test.ts`, data-sources invariant 2: the forbidden literals in
   layer code become any quoted string containing `{z}`, `openfreemap.org`,
   `/3dgs/` or `/3dgs-lod/`; only `src/sources.ts` may name the files paths.
   The `/tiles/` and `/files/` literals and the `proxy.ts` exemption go.

`vite.config.ts`'s fail-fast is checked by running `npm run build` with a bad
value, not by vitest.

## Documentation changes, with the implementation

- `src/lib/tiles/specs/spec.md`: module list drops `proxy.ts`, adds
  `origin.ts`; the `sources.ts` table gets the absolute values; invariant 2
  as above.
- `src/lib/tiles/specs/proxy.md`: deleted (its history stays in git and
  DECISIONS).
- Tree spec, *Why `source.tiles`*: rule 6's reason; the proxy paragraph goes.
- Splat spec, *The files*: direct, cross-origin, `VITE_FILES_URL`.
- `app/CLAUDE.md`: `vite.config.ts` line, `lib/tiles` line.
- `ai/STACK.md` (*External services*, *Build configuration*),
  `ai/WORKFLOWS.md` (*Deploying*: build-time variables, the curl checks
  against the servers directly with an `Origin` header).
- `ai/DECISIONS.md`: new top entry "the app fetches Martin and `files`
  directly; no proxy", superseding 2026-10-12 (*the tile proxy's target is a
  setting*) and the `/files` proxy part of the splat entry.
- `infra/README.md`, `infra/CLAUDE.md`, `infra/specs/network-access.md`
  rule 5: the app's settings are `VITE_TILES_URL` / `VITE_FILES_URL`, and
  the remote deploy needs `PUBLISH_ADDR`.

## Out of scope

- Runtime configuration (a `config.json` fetched at startup) so one `dist/`
  serves any host. Build-time is simpler and matches how the app is built
  today; revisit if one build must serve several hosts.
- TLS for Martin.
- Raising the splat concurrency numbers (rule 10).
