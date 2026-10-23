# Tile proxy target — spec

Status: **approved 2026-10-12, implemented**, with the infra port change.

## Purpose

The app reaches Martin through a same-origin proxy: `/tiles/*` → Martin, with
the `/tiles` prefix stripped (the tree spec, *Why `source.tiles`*). Today the
target is hard-coded to `http://localhost:3000` in `vite.config.ts`.

That breaks any host where port 3000 is taken. On 192.168.81.32 an unrelated
nginx holds `:3000` and answers every path with its SPA `index.html` and a
`200`. The proxy relays that page as the tile, and MapLibre fails with
`Unimplemented type: 4`, because `<` (0x3C) parses as a protobuf field-7,
wire-type-4 header.

This spec makes the target a deploy-time setting, so Martin can run on any
port or host without editing the app.

## Behaviour

1. **One setting, `TILES_PROXY_TARGET`.** It is the origin the `/tiles` proxy
   forwards to, for example `http://localhost:3001` or `http://martin:3000`.
2. **It is read where Vite reads its config.** Vite's `loadEnv(mode, cwd, "")`
   reads the process environment first, then `app/.env`, `.env.local`,
   `.env.[mode]` and `.env.[mode].local`, in Vite's usual precedence.
3. **The default is `http://localhost:3000`.** Unset or empty means exactly
   today's behaviour, so local development needs no setup.
4. **The name has no `VITE_` prefix on purpose.** Vite exposes only `VITE_*`
   variables to client code, so the target never reaches the bundle. The
   browser still sees only the relative `/tiles/trees/{z}/{x}/{y}`. `TREES` in
   `src/sources.ts` does not change, and the layers learn nothing new.
5. **A malformed value fails loudly at startup.** The value must parse as an
   absolute `http:` or `https:` URL with no path beyond `/`, no query and no
   hash. Anything else makes `vite`, `vite build` and `vite preview` exit with
   an error naming `TILES_PROXY_TARGET` and the bad value. A typo must not turn
   into a proxy that silently serves something else, which is the failure this
   spec exists to fix. A trailing `/` is accepted and dropped.
6. **The dev server and the preview server use the same proxy.** It is set
   explicitly on both `server.proxy` and `preview.proxy`. Vite's
   `preview.proxy` defaults to `server.proxy` today, but `npm run preview` is
   now how the app is deployed, so the dependency is stated rather than
   inherited.
7. **Everything else about the proxy is unchanged**: `changeOrigin: true`, and
   the `/tiles` prefix stripped before forwarding.

## Where it lives

- `src/lib/tiles/proxy.ts` exports a pure `tileProxy(env)`. It takes the
  loaded env record and returns the proxy entry, or throws on a malformed
  value (rule 5). It imports nothing from `src/layers/` or from Vite's
  runtime, so the shared-module guard (`lib/tiles/structure.test.ts`) still
  holds.
- `vite.config.ts` calls `loadEnv`, passes the result to `tileProxy`, and
  places the entry on `server.proxy` and `preview.proxy`. It becomes the
  function form `defineConfig(({ mode }) => …)`.

## Invariants

All asserted by vitest in `src/lib/tiles/proxy.test.ts`:

1. With `TILES_PROXY_TARGET` unset or empty, the target is
   `http://localhost:3000`.
2. A valid value is used as given, minus one trailing `/`.
3. `ftp://x`, `localhost:3000` (no scheme), `http://h/tiles`, `http://h?x=1`
   and `not a url` each throw, and the message contains `TILES_PROXY_TARGET`.
4. The returned rewrite maps `/tiles/trees/15/1/2` to `/trees/15/1/2`, and
   leaves a path without the `/tiles` prefix unchanged.
5. `changeOrigin` is `true`.

`vite.config.ts` wiring (both servers, `loadEnv`) is checked by running
`npm run build` and `npm run preview` with the variable set, not by vitest.

## Documentation changes

- Tree spec, *Why `source.tiles`*: the proxy target is `TILES_PROXY_TARGET`,
  defaulting to `http://localhost:3000`.
- `ai/STACK.md`, *External services*: the Martin row and the paragraph under
  it name the setting. *No `.env`* becomes "no `.env` is required".
- `ai/WORKFLOWS.md`: a *Deploying* note. Run `npm run build`, then
  `TILES_PROXY_TARGET=… npm run preview -- --host`, and check that
  `curl -sI <host>:4173/tiles/trees/15/27448/14028` returns
  `application/x-protobuf` and not `text/html`.
- `ai/DECISIONS.md`: a new entry at the top for this setting.

## The infra side

Making the app's target configurable is only half the fix on the remote host.
`infra/docker-compose.yml` published Martin on a fixed `127.0.0.1:3000:3000`,
which collides with the nginx already there.

**Decided:** publish on `"127.0.0.1:${MARTIN_PORT:-3000}:3000"`. Martin keeps
listening on `3000` inside the container. `infra/README.md` and `load.sh`'s
hints then say which port to use. A remote deploy becomes
`MARTIN_PORT=3001 ./load.sh` plus `TILES_PROXY_TARGET=http://localhost:3001`.

The rejected alternative was to leave infra alone and move the other nginx.

## The `/files` proxy (approved 2026-10-20, implemented)

Added with the splat layer (`src/layers/splat/specs/spec.md`, *The files*).
Martin serves tiles only, so infra serves the splat captures from a static
`files` service (nginx), and the app reaches it the same way it reaches
Martin.

1. **One more setting, `FILES_PROXY_TARGET`.** `/files/*` is forwarded to it,
   with the `/files` prefix stripped: `/files/3dgs/KY0917A.spz` →
   `/3dgs/KY0917A.spz`.
2. **The default is `http://localhost:3080`**, infra's `FILES_PORT` default.
3. **Everything else is the `/tiles` rules**: read with `loadEnv`, no `VITE_`
   prefix, validated the same way with the same messages naming
   `FILES_PROXY_TARGET`, a trailing `/` dropped, `changeOrigin: true`, and set
   on both `server.proxy` and `preview.proxy`.
4. **The two settings are independent.** Setting one never moves the other.
5. **Byte ranges pass through** (added 2026-10-23, splat spec revision 5).
   Spark reads a paged `.rad`'s header with a `Range` request (its chunks are
   separate files, fetched whole), so a `Range` header reaches the target
   unchanged and its `206` comes back. Vite's proxy does this by default; nothing is configured
   for it.

`proxy.ts` exports `fileProxy(env)` beside `tileProxy(env)`; both are built by
one private `proxyTo(prefix, name, default, env)`. `proxy.test.ts` asserts the
default, a valid value, the rejected values, the prefix rewrite (`/filesystem/x`
is left alone), `changeOrigin`, and the independence of the two. It also
runs a real Vite server with `fileProxy` in front of a stand-in target and
checks that a `Range` request comes back `206` with its header intact.

A remote deploy whose `:3080` is taken becomes `FILES_PORT=… ./load.sh` plus
`FILES_PROXY_TARGET=http://localhost:…`.

## Out of scope

- **Detecting a wrong upstream at runtime**, for example rejecting a
  `text/html` response to a tile request. That would turn this failure into a
  clean tile error rather than a decode error. It is worth considering, but it
  is a separate behaviour change to the proxy.
- **A production web server config** (nginx or Caddy in front of `dist/`). The
  app is still served by `vite preview`.
- **Making the `/tiles` prefix or the tree tile path configurable.** They are
  the app's own names, and `TREES` in `src/sources.ts` holds them.
