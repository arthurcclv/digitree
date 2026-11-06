#!/usr/bin/env bash
# load.sh's own checks, before and after it brings the stack up
# (specs/files-http2.md rule 9): HTTPS on `files` is judged by the same
# both-or-neither rule the container uses, half a pair fails before anything
# starts, and the summary reports what was published.
#
# Runs a copy of the real load.sh in a scratch directory, beside stand-in
# extracts, with a stub `docker` first on PATH that logs its calls and starts
# nothing. FILES_TLS_DIR is a scratch path in every case, so tls/ and data/
# are never read. Needs bash only; no Docker.
#
#   ./test/load.sh   # from infra/; test/run.sh also runs it
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail + 1)); }
case_() { printf '\n%s\n' "$1"; }
expect() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want [$3], got [$2]"; fi
}
expect_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "[$3] not in [$2]" ;; esac
}
expect_lacks() {
  case "$2" in *"$3"*) bad "$1" "[$3] is in the output" ;; *) ok "$1" ;; esac
}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/infra/data" "$scratch/bin"
cp load.sh "$scratch/infra/"
touch "$scratch/infra/data/TaipeiTree.csv" "$scratch/infra/data/TaipeiParkTree.csv"
# The stub: every call is logged; `compose ps` reports db healthy, so the
# script runs to its summary; everything else succeeds silently.
cat > "$scratch/bin/docker" << 'EOF'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case " $* " in *" ps "*) echo healthy ;; esac
exit 0
EOF
chmod +x "$scratch/bin/docker"

# pair <dir> <files…>: a TLS directory holding exactly those files. load.sh
# only looks for them, so their content does not matter.
pair() {
  local dir=$1; shift
  rm -rf "$dir"; mkdir -p "$dir"
  for f in "$@"; do echo stand-in > "$dir/$f"; done
}

# load <tls dir> [VAR=value…]: runs the copy, with only the given settings,
# so the caller's own ports and PUBLISH_ADDR never leak in. Sets out (stdout
# and stderr), rc and calls (the stub's log).
load() {
  local dir=$1; shift
  : > "$scratch/docker.log"
  rc=0
  out=$(env -u PUBLISH_ADDR -u MARTIN_PORT -u FILES_PORT -u FILES_TLS_PORT \
    PATH="$scratch/bin:$PATH" DOCKER_LOG="$scratch/docker.log" \
    FILES_TLS_DIR="$dir" "$@" bash "$scratch/infra/load.sh" 2>&1) || rc=$?
  calls=$(cat "$scratch/docker.log")
}

for half in cert.pem:key.pem key.pem:cert.pem; do
  have=${half%%:*} missing=${half#*:}
  case_ "only $have: fails before anything starts"
  pair "$scratch/half" "$have"
  load "$scratch/half"
  [ "$rc" != 0 ] && ok "exits non-zero ($rc)" || bad "exits non-zero" "exit 0"
  expect_has "names $missing" "$out" "$scratch/half/$missing is missing"
  expect "docker was never called" "$calls" ""
done

case_ "a full pair, in a FILES_TLS_DIR of its own"
pair "$scratch/certs" cert.pem key.pem
load "$scratch/certs" FILES_TLS_PORT=4443
expect "succeeds" "$rc" 0
expect_has "starts files with HTTPS on" "$out" "starting the files service (splat captures; HTTPS on)"
expect_has "prints the HTTPS address on FILES_TLS_PORT" "$out" \
  "files also serves HTTPS with HTTP/2 on 127.0.0.1:4443 (certificate from $scratch/certs)"
expect_has "prints the HTTP/2 check" "$out" \
  "curl -sI --http2 https://localhost:4443/3dgs-lod/<tile>-lod.rad"
expect_has "  after starting files" "$calls" "compose up -d files"

case_ "no pair: plain HTTP only"
pair "$scratch/empty"
load "$scratch/empty"
expect "succeeds" "$rc" 0
expect_has "starts files with HTTPS off" "$out" "starting the files service (splat captures; HTTPS off)"
expect_has "says plain HTTP only" "$out" "files serves plain HTTP only: no certificate in $scratch/empty"
expect_lacks "prints no https:// line" "$out" "https://"

case_ "a FILES_TLS_DIR that does not exist"
rm -rf "$scratch/absent"
load "$scratch/absent"
expect "succeeds" "$rc" 0
[ -d "$scratch/absent" ] && ok "creates it, as the operator" || bad "creates it, as the operator" "it is not there"
expect "  owned by the operator" "$(stat -c %u "$scratch/absent" 2> /dev/null || stat -f %u "$scratch/absent")" "$(id -u)"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
