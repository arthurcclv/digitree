#!/bin/sh
# Enables the files service's HTTPS listener when, and only when, the
# operator's certificate is there (specs/files-http2.md rule 3). Run by the
# nginx image's entrypoint from /docker-entrypoint.d/ before nginx starts; a
# non-zero exit stops the container.
#
#   both cert.pem and key.pem in /etc/nginx/tls/  -> HTTPS + HTTP/2 on 443
#   neither                                       -> plain HTTP only
#   only one                                      -> refuse to start
set -eu

dir=/etc/nginx/tls
enabled=/etc/nginx/conf.d/files-tls.conf

rm -f "$enabled"
if [ -f "$dir/cert.pem" ] && [ -f "$dir/key.pem" ]; then
  cp /etc/nginx/files-tls.conf "$enabled"
  echo "files-tls: HTTPS with HTTP/2 on 443"
elif [ -f "$dir/cert.pem" ]; then
  echo "files-tls: $dir/cert.pem is there but key.pem is missing; supply both or neither" >&2
  exit 1
elif [ -f "$dir/key.pem" ]; then
  echo "files-tls: $dir/key.pem is there but cert.pem is missing; supply both or neither" >&2
  exit 1
else
  echo "files-tls: no certificate in $dir; plain HTTP only"
fi
