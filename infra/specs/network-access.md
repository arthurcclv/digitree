# Network access to Martin and `files` — spec

Status: **approved 2026-11-06, implemented.**

## Purpose

A frontend hosted on another machine should be able to draw the splats by
talking to infra directly: Martin for the `splats` vector tiles, `files` for
the LoD trees Spark streams. Today it cannot, for three reasons:

1. Martin is published on `127.0.0.1:${MARTIN_PORT}` only. On 192.168.81.32
   that is `127.0.0.1:3001`, and a request from another machine is refused.
2. `files` is published on `127.0.0.1:${FILES_PORT}` only, likewise.
3. `files` sends no CORS headers, so even when reachable, a browser on
   another origin cannot read a `.rad` or `.radc` response. Its `Range`
   preflight is not answered either.

The only working route today is the app's own same-origin proxy on
`:4173` (`app/src/lib/tiles/specs/proxy.md`), which a separate frontend has to
replicate in its own server.

This spec makes network exposure an **opt-in deploy setting** and makes
`files` answer cross-origin requests. Local development is unchanged.

## Behaviour

### Publishing address

1. **One setting, `PUBLISH_ADDR`.** It is the host address Compose publishes
   Martin and `files` on: `"${PUBLISH_ADDR:-127.0.0.1}:${MARTIN_PORT:-3000}:3000"`
   and `"${PUBLISH_ADDR:-127.0.0.1}:${FILES_PORT:-3080}:80"`.
2. **The default is `127.0.0.1`.** Unset or empty means exactly today's
   behaviour, so a development machine exposes nothing.
3. **`db` is never exposed.** It stays on `127.0.0.1:5432` whatever
   `PUBLISH_ADDR` says: its credentials are trivial, and only `load.sh` and
   the tests talk to it.
4. **It travels like `MARTIN_PORT`.** It must be set for `./load.sh` and for
   any later `docker compose` command, or Compose recreates the services on
   the default address. `load.sh` prints the address and ports it published on.
5. **The remote host's deploy becomes**
   `PUBLISH_ADDR=0.0.0.0 MARTIN_PORT=3001 ./load.sh`, which serves
   `http://192.168.81.32:3001` (Martin) and `http://192.168.81.32:3080`
   (`files`). A single interface's address (`192.168.81.32`) works too, to
   avoid publishing on every interface, but then nothing answers on
   `localhost`: the app on the same host must point `TILES_PROXY_TARGET` and
   `FILES_PROXY_TARGET` at that address. `load.sh` prints its checks and
   those targets with the published address.

### CORS on `files`

6. **Every response from `/3dgs/` and `/3dgs-lod/` carries**
   - `Access-Control-Allow-Origin: *`
   - `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag`

   always, including on `206`, `304` and `404`. `*` rather than an echoed
   origin, because the files are public, read-only and fetched without
   credentials. The exposed headers are what a ranged reader needs to see.
7. **A preflight is answered.** An `OPTIONS` request to either location
   returns `204`, no body, with the headers in rule 6 plus
   `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`,
   `Access-Control-Allow-Headers: Range, If-None-Match, If-Modified-Since` and
   `Access-Control-Max-Age: 86400`. These three are sent on every response
   from the two locations, not only on the preflight: a browser ignores them
   elsewhere, and one header set per location keeps the config plain. A
   `Range` request with more than one range or an unusual form is not
   CORS-safelisted, so browsers preflight it.
8. **CORS is on regardless of `PUBLISH_ADDR`.** It is harmless on
   `127.0.0.1`, and one config is simpler to test than two. The app's
   same-origin proxy ignores the headers.
9. **Everything else about `files` is unchanged**: aliases, `sendfile`,
   byte ranges, ETags, `Cache-Control: no-cache`, no gzip, no listing, `404`
   outside the two locations. `add_header` in a location replaces inherited
   ones, so the CORS headers sit in each location beside `Cache-Control`.

### Martin

10. **Martin's CORS is left at its default**, which already allows any origin
    (measured on 1.16.1 through the remote host: `Access-Control-Allow-Origin`
    echoes the request's `Origin`). This spec pins that behaviour with a test
    instead of a config change, so a Martin upgrade that changes it fails
    `test/martin.sh`.
11. **TileJSON URLs.** Martin builds the `tiles` URL in its TileJSON from the
    request's `Host`. Reached directly at `192.168.81.32:3001` it reports
    that address. A client should still build tile URLs from the documented
    path, `/splats/{z}/{x}/{y}`.

### What a direct client uses

| What | URL |
| --- | --- |
| splat placements (MVT) | `http://<host>:<MARTIN_PORT>/splats/{z}/{x}/{y}` |
| a tile's LoD header | `http://<host>:<FILES_PORT>/3dgs-lod/<stem>-lod.rad` |
| its chunks | `http://<host>:<FILES_PORT>/3dgs-lod/<stem>-lod-<n>.radc` |

Note the prefixes differ from the app's proxy: no `/tiles` and no `/files`.

## What this does not change

- The app. Its `/tiles` and `/files` proxies keep working on `127.0.0.1`
  targets; `TILES_PROXY_TARGET` and `FILES_PROXY_TARGET` are untouched.
- No authentication or rate limiting. Exposure is meant for a trusted
  LAN. An HTTPS frontend cannot call these `http://` origins (mixed
  content). `files` can now also serve HTTPS, with HTTP/2, when the operator
  supplies a certificate (`specs/files-http2.md`, 2026-11-06). Martin still
  can't, so an HTTPS frontend needs its own proxy for Martin.
- No `.env` is required.

## Tests

- **`test/files.sh` (new).** Starts the pinned `nginx:1.28.0-alpine` with the
  real config (`files.conf`; since `specs/files-http2.md`, also
  `files-locations.conf` and the HTTPS listener's files) over a scratch directory holding a small fixture `.rad`
  and `.radc`, on a random port, and checks with `curl`:
  1. `GET` with an `Origin` → `200`, `Cache-Control: no-cache`, an `ETag`.
  2. `GET` with `Range: bytes=0-15` → `206`, `Content-Range`.
  3. `OPTIONS` with `Access-Control-Request-Headers: range` → `204`, no
     body.
  4. `If-None-Match` with the ETag → `304`.
  5. A missing file in a location → `404`; a path outside the two
     locations → `404`.

  Every response in 1–5 from the two locations is checked for the whole
  CORS set of rules 6 and 7, not only `Access-Control-Allow-Origin`.
  Run from `test/run.sh`, since it needs only Docker.
- **`test/compose.sh` (new).** Runs `docker compose config` and checks the
  published addresses: with `PUBLISH_ADDR` unset or empty, Martin and
  `files` on `127.0.0.1`; with `PUBLISH_ADDR=0.0.0.0`, both on `0.0.0.0`;
  with `192.168.81.32` and `MARTIN_PORT=3001`, both there, Martin on
  `3001`; `db` on `127.0.0.1` in every case. The caller's own settings are
  cleared first. No containers start. Run from `test/run.sh`.
- **`test/martin.sh`** gains one check: a request with an `Origin` header
  gets `Access-Control-Allow-Origin` back (rule 10).

## Documentation changes, with the implementation

- `infra/CLAUDE.md`: *What this is* no longer says the ports bind to
  `127.0.0.1` without exception; it names `PUBLISH_ADDR` beside
  `MARTIN_PORT` and `FILES_PORT`, and says `db` is never published. The
  `files.conf` line mentions CORS. `test/` lists `files.sh` and `compose.sh`.
- `infra/README.md`: a *Serving other machines* section with the remote
  deploy command, the direct URLs, and `curl` checks for CORS and `206`.
- `app/ai/DECISIONS.md`: a new entry at the top, "infra can publish Martin
  and `files` on the network, opt-in". It partly reverses the localhost-only
  stance of "a development fixture, no deployment story", which no earlier
  entry records: it was stated only in `infra/CLAUDE.md`, so there is no
  entry to mark superseded.
- `app/src/layers/splat/specs/spec.md`, *The files*: `files` sends CORS
  headers and can be published beyond `127.0.0.1`. *Open items* 3: the
  remote host's `:3080` must be checked free before deploying with
  `PUBLISH_ADDR`.
- The client integration doc (Claude Docs, "3DGS Tiles Client Integration
  with Spark"): rewritten for direct access to `:3001` and `:3080`, the
  proxy route kept as the fallback for HTTPS frontends.

## Open items

1. **Is `:3080` free on 192.168.81.32?** `FILES_PORT` was chosen free on the
   development machine only. Check before deploying; if taken, pick another
   and use it in the client's URL.
2. **`0.0.0.0` or the LAN address?** `0.0.0.0` also publishes on Docker
   bridges and any other interface. The LAN address is tighter, but breaks if
   the host's address changes, and moves the app's proxy targets off
   `localhost` (rule 5). Decided at deploy time, not here.
3. **Docker and the host firewall.** Docker writes its own iptables rules, so
   a published port bypasses `ufw`. If the host should only serve part of the
   network, that is a firewall rule in `DOCKER-USER`, outside this repo.
