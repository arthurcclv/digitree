# HTTP/2 on `files` — spec

Status: **approved 2026-11-06, implemented.**

## Purpose

Spark draws a splat tile by reading its `.rad` header, then fetching each
`.radc` chunk it needs, and a view holds many tiles. Over HTTP/1.1 a browser
opens at most six connections per origin, so those chunk fetches queue behind
each other. HTTP/2 multiplexes them on one connection.

Browsers speak HTTP/2 only over TLS. nginx can serve cleartext HTTP/2 (`h2c`),
but no browser uses it. So `files` gets a second, HTTPS listener with HTTP/2
on, using a certificate the operator supplies. That also lifts the
`specs/network-access.md` limit that an HTTPS frontend cannot call `files`
(mixed content).

The plain-HTTP listener stays as it is. The app's Vite `/files` proxy talks
HTTP/1.1 to its upstream whatever `files` offers, so nothing changes on that
route. HTTP/2 helps a frontend that talks to `files` directly.

## Behaviour

### The certificate

1. **The operator supplies it.** It is a PEM pair in one directory,
   `FILES_TLS_DIR` (default `infra/tls/`), named `cert.pem` (the leaf
   followed by any intermediates) and `key.pem` (unencrypted). `infra/tls/`
   is in the repo holding only a README; everything else in it is
   gitignored. Keeping the directory there means Docker never creates it
   as root, which would leave the operator needing `sudo` to add a pair. Where it
   comes from is up to the operator: mkcert, an internal CA, Let's Encrypt.
   Nothing in this repo generates, renews or trusts a certificate.
2. **It is mounted read-only** at `/etc/nginx/tls/` in the `files` container.
   It is a directory rather than two file mounts because Docker creates a
   missing bind-mount source as an empty directory, which would hide a typo.
3. **TLS is on exactly when both files are there.**
   - Both present: the HTTPS listener runs (rules 5–8).
   - Neither present: `files` serves plain HTTP only, as today. This is the
     default, so a development machine needs no setup.
   - Only one present: `files` refuses to start, with a message that names the
     missing file. A half-configured certificate must not fall back to HTTP
     silently.
4. **The decision is made when the container starts**, by a script in the
   nginx image's `/docker-entrypoint.d/` (`files-tls.sh`, mounted read-only).
   It enables the HTTPS server block (`files-tls.conf`) only when rule 3 says
   so. nginx then checks the pair itself: a key that doesn't match the
   certificate, or a file that isn't PEM, fails `nginx` at startup. Changing
   the certificate needs `docker compose restart files`, which `load.sh`
   already does.

### The HTTPS listener

5. **It listens on 443 in the container**, with `http2 on`. It offers
   TLS 1.2 and 1.3 (nginx's default). ALPN negotiates `h2`, falling back to
   `http/1.1` for a client that asks for it.
6. **It is published on `"${PUBLISH_ADDR:-127.0.0.1}:${FILES_TLS_PORT:-3443}:443"`.**
   `FILES_TLS_PORT` is a twin of `FILES_PORT` and travels like it: set it for
   `./load.sh` and for any later `docker compose` command. The port is
   published even when TLS is off. Nothing listens behind it then, so a
   connection to it is reset rather than refused.
7. **It serves exactly what the plain listener serves.** The two locations,
   the 404 outside them, `sendfile`, byte ranges, ETags,
   `Cache-Control: no-cache`, no gzip, no listing, and the whole CORS set of
   `specs/network-access.md` rules 6–7. The locations move into one shared
   file, `files-locations.conf`, which both server blocks include, so the two
   listeners can't drift apart.
8. **The plain listener on 80 is unchanged.** It doesn't redirect to HTTPS
   and it doesn't speak `h2c`. The app's proxy and existing clients keep using
   it. A frontend picks `http://<host>:3080` or `https://<host>:3443`.

### `load.sh`

9. **It reports what it published.** It prints whether HTTPS is on, judged
   by the same rule 3 against `FILES_TLS_DIR` on the host. When it is on, it
   prints the HTTPS address beside the HTTP one, plus a check:
   `curl -sI --http2 https://<host>:<FILES_TLS_PORT>/3dgs-lod/<tile>-lod.rad`,
   whose status line reads `HTTP/2 200`. With exactly one of the two files
   present, it fails before starting anything (before the database load,
   too), naming the missing file. Otherwise it creates `FILES_TLS_DIR` if it
   doesn't exist, as the operator, before anything starts. That keeps rule 1's
   promise, that Docker never creates the directory as root, for a
   `FILES_TLS_DIR` outside the repo too.

### What a direct client uses

| What | URL |
| --- | --- |
| a tile's LoD header, HTTP/2 | `https://<host>:<FILES_TLS_PORT>/3dgs-lod/<stem>-lod.rad` |
| its chunks, HTTP/2 | `https://<host>:<FILES_TLS_PORT>/3dgs-lod/<stem>-lod-<n>.radc` |
| either, HTTP/1.1 | as before, `http://<host>:<FILES_PORT>/3dgs-lod/…` |

The certificate must name the host the client uses (an IP SAN for
`192.168.81.32`), and the browser must trust its CA.

## What this does not change

- **Martin.** It stays HTTP/1.1. Its tiles are small and few next to a view's
  chunks. HTTPS on Martin would be a separate change.
- **The app.** `FILES_PROXY_TARGET` keeps its `http://localhost:3080`
  default. Pointing it at the HTTPS port would also work (`proxy.ts` already
  accepts `https:`), but the proxy would still speak HTTP/1.1 to it, and Node
  would reject a certificate from a CA it doesn't trust. So the app isn't
  moved.
- **`h2c` and HTTP/3.** The first is unused by browsers; the second needs
  UDP publishing and an nginx built with QUIC. Neither is in scope.
- **`db`**, which is never published beyond `127.0.0.1`.

## Tests

- **`test/files.sh`** keeps its checks. It runs them against both listeners:
  - The scratch directory gains a throwaway self-signed pair, made with
    `openssl` for `127.0.0.1`. The container mounts it at `/etc/nginx/tls/`
    and runs the real `files-tls.sh`, `files-tls.conf` and
    `files-locations.conf`. Both ports are published on random ports.
  - Every existing case (`200`, `206` with `Content-Range`, a chunk whole,
    the `204` preflight, `304`, the `404`s, `403` on a listing, and the whole
    CORS set on each) runs once over `http://` and once over `https://`
    (`curl -k`).
  - Over HTTPS, `curl --http2 -w '%{http_version}'` reports `2`, and
    `--http1.1` still gets a `200` (rule 5).
  - Over HTTP, the version is `1.1` (rule 8).
  - It waits for each listener to come up. If one never does, it fails
    right away, once, with the container's log, rather than as every later
    case failing.
  - **No certificate**: a second container with an empty TLS directory
    serves `200` on 80. A connection to 443 is reset, not refused (rule 6):
    `curl` fails, but not with exit 7 (*couldn't connect*).
  - **Half a certificate**: a container with only `cert.pem` exits non-zero,
    and its log names `key.pem`. Likewise for only `key.pem`.
  - **A pair nginx rejects** (rule 4): a key from another pair, and two files
    that aren't PEM. Each container exits non-zero, with nginx's `[emerg]` in
    its log.
- **`test/load.sh` (new)**: rule 9, against the real `load.sh`. It runs a
  copy of the script in a scratch directory with stand-in extracts and a stub
  `docker` on `PATH` that logs its calls and starts nothing. `FILES_TLS_DIR`
  is set to a scratch path in every case, so the default `tls/` is never
  read.
  - Only `cert.pem`: exits non-zero and names `key.pem`, and `docker` was
    never called. Likewise for only `key.pem`.
  - A full pair: says HTTPS is on, and prints the HTTPS address on
    `FILES_TLS_PORT` and the `curl -sI --http2` check.
  - No pair: says plain HTTP only, and prints no `https://` line.
  - A `FILES_TLS_DIR` that doesn't exist: it exists after the run.
  - `test/run.sh` runs it with the other suites.
- **`test/compose.sh`**: `files` publishes two ports, `…:3080:80` and
  `…:3443:443`, both on `PUBLISH_ADDR`'s address in each existing case.
  `FILES_TLS_PORT=4443` moves only the second.

## Documentation changes, with the implementation

- `infra/CLAUDE.md`: *What this is* names `FILES_TLS_PORT` and
  `FILES_TLS_DIR`. The tree lists `files-locations.conf`, `files-tls.conf`,
  `files-tls.sh` and `tls/` (with its README). The `test/` entry says `files.sh` covers both
  listeners, and lists `load.sh`.
- `infra/README.md`: *Serving other machines* gains an *HTTPS and HTTP/2*
  part. It covers where the pair goes, a mkcert example with the host's IP
  as a SAN, the restart, and the `curl --http2` check. *Tests* describes
  `test/load.sh`, and the rejected-pair cases of `test/files.sh`.
- `specs/network-access.md`: *What this does not change* no longer says TLS
  is out of scope. It points here. Rules 7 and 9 and its `test/files.sh`
  entry stop naming `files.conf` as the one config file, since the locations
  now live in `files-locations.conf`.
- `app/src/layers/splat/specs/spec.md` and the `SPLATS` comment in
  `app/src/sources.ts`: the file paths are in `files-locations.conf`. The
  splat spec's `files` paragraph adds that direct readers can also use the
  HTTPS listener. The app itself is unchanged.
- `app/ai/DECISIONS.md`: a new entry at the top, "`files` serves HTTP/2 over
  operator-supplied TLS, beside plain HTTP". Rejected alternatives: a
  self-signed certificate made by `load.sh` (every browser has to click
  through it, and a cross-origin `fetch` fails until it does), `h2c` (no
  browser uses it), HTTPS only (it would move the app's proxy and the
  existing clients), and HTTP/3 (little gain on a wired LAN; needs UDP and
  QUIC). A note that the app's `/files` route is still HTTP/1.1, so the
  *splat captures plan on `moveend`* entry's revisit condition is not met for
  the app. *Revisit if*, as every entry has.
- `.gitignore`: `infra/tls/*` except `infra/tls/README.md`.
- The client integration doc (Claude Docs, "3DGS Tiles Client Integration
  with Spark"): the HTTPS URLs as the preferred route when the deploy has a
  certificate. I'll make that edit after the code lands, and only if you
  want it.

## Open items

1. **Is `:3443` free on 192.168.81.32?** As with `:3080`, check before
   deploying with `PUBLISH_ADDR`.
2. **The remote host's certificate.** It needs an IP SAN for
   `192.168.81.32` (or a DNS name the clients use), and every client machine
   has to trust its CA. That is a deploy step, not a repo change.
