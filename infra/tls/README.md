# `tls/` — the files service's certificate

Put a PEM pair here to turn on HTTPS with HTTP/2 on `files`
(`../specs/files-http2.md`):

- `cert.pem`: the leaf certificate, followed by any intermediates
- `key.pem`: its private key, unencrypted

Both or neither: with neither, `files` serves plain HTTP only; with one,
`load.sh` and the container refuse to start. Everything here but this README
is gitignored. `FILES_TLS_DIR` points elsewhere instead. See `../README.md`,
*HTTPS and HTTP/2*.
