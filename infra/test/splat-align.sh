#!/usr/bin/env bash
# splat-align.mjs's test suite.
#
# Runs the real splat-align.mjs against scan folders written here by
# splat-align-scene.mjs — a street canyon, its trajectory, RTK fixes and lidar
# — in a scratch directory, so no binary fixture is checked in. Needs only
# node. How process-splat.sh acts on its result is tested in process-splat.sh.
#
#   ./test/splat-align.sh   # from infra/; test/run.sh also runs it
set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail + 1)); }
case_() { printf '\n%s\n' "$1"; }

expect() {
  local label=$1 actual=$2 want=$3
  if [ "$actual" = "$want" ]; then ok "$label"; else bad "$label" "want [$want], got [$actual]"; fi
}

expect_contains() {
  local label=$1 haystack=$2 needle=$3
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) bad "$label" "output does not mention [$needle]" ;;
  esac
}

command -v node > /dev/null || { echo "error: node is not on PATH" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# scene <name> [options]: a scan folder, see splat-align-scene.mjs.
scene() { node test/splat-align-scene.mjs -- "$work/$1" "${2:-}"; }
# align <name>: runs the step; its exit code goes to $rc, stdout and stderr to $log.
align() { rc=0; log=$(node scripts/splat-align.mjs -- "$work/$1" "$work/$1.ply" "$work/$1.json" 2>&1) || rc=$?; }
# js <name> <expression of j, the .json>: prints the expression's value.
js() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(eval(process.argv[2]));' -- "$work/$1.json" "$2"; }
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }

# The Gaussians are shifted (0.4, 0.3, 0) — 0.5 m — and turned 0.3° from the
# lidar. The correction found, applied to the misplaced corners of the true
# box, must put them back.
case_ "a known displacement"
scene shift '{"shift":[0.4,0.3,0],"turnDeg":0.3}'
align shift
expect "exits 0" "$rc" 0
expect "status corrected" "$(js shift j.status)" corrected
expect "the correction undoes it within 1 cm at the corners" "$(js shift '
  const R = j.correction.rotation, t = j.correction.translation_m, a = 0.3 * Math.PI / 180;
  let worst = 0;
  for (const x of [-20, 20]) for (const y of [-10, 10]) for (const z of [0, 8]) {
    const m = [Math.cos(a) * x - Math.sin(a) * y + 0.4, Math.sin(a) * x + Math.cos(a) * y + 0.3, z];
    const c = [0, 1, 2].map((r) => R[r][0] * m[0] + R[r][1] * m[1] + R[r][2] * m[2] + t[r]);
    worst = Math.max(worst, Math.hypot(c[0] - x, c[1] - y, c[2] - z));
  }
  worst < 0.01')" true
expect "the lever arm, turned with the scanner, fits under 1 cm" "$(js shift 'j.rtk_fit.residual_p95_m < 0.01')" true
expect "no fix is dropped" "$(js shift j.rtk_fit.false_fixes_dropped)" 0

case_ "every Gaussian moved rigidly, nothing else touched"
# Reads both PLYs and checks: centres moved by R, t; rot_0..3 = |q| · q(R)·q̂
# (a zero quaternion becomes q(R)); normals turned by R; and every other byte
# — colour, opacity, scale — the same.
expect "rotations, normals and the rest" "$(node -e '
  const fs = require("fs");
  const [dir] = process.argv.slice(1);
  const j = JSON.parse(fs.readFileSync(dir + "/shift.json", "utf8"));
  const read = (p) => { const b = fs.readFileSync(p); const e = b.indexOf("end_header\n") + 11;
    return { head: b.subarray(0, e).toString("latin1"), body: b.subarray(e) }; };
  const a = read(dir + "/shift/point_cloud.ply"), b = read(dir + "/shift.ply");
  const R = j.correction.rotation.flat(), t = j.correction.translation_m;
  const mv = (v) => [0, 1, 2].map((r) => R[3 * r] * v[0] + R[3 * r + 1] * v[1] + R[3 * r + 2] * v[2]);
  const tr = R[0] + R[4] + R[8], s = 2 * Math.sqrt(tr + 1);
  const q = [s / 4, (R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s];
  const qmul = (p, r) => [p[0]*r[0]-p[1]*r[1]-p[2]*r[2]-p[3]*r[3], p[0]*r[1]+p[1]*r[0]+p[2]*r[3]-p[3]*r[2],
    p[0]*r[2]-p[1]*r[3]+p[2]*r[0]+p[3]*r[1], p[0]*r[3]+p[1]*r[2]-p[2]*r[1]+p[3]*r[0]];
  const n = a.body.length / 68, f = (buf, i, k) => buf.readFloatLE(68 * i + 4 * k);
  const errs = [];
  const near = (x, y, tol, what) => { if (Math.abs(x - y) > tol) errs.push(`${what}: ${x} vs ${y}`); };
  for (let i = 0; i < n; i++) {
    const p = mv([0, 1, 2].map((k) => f(a.body, i, k)));
    for (let k = 0; k < 3; k++) near(f(b.body, i, k), p[k] + t[k], 1e-5, `x${k} of ${i}`);
    const nv = mv([3, 4, 5].map((k) => f(a.body, i, k)));
    for (let k = 0; k < 3; k++) near(f(b.body, i, 3 + k), nv[k], 1e-6, `n${k} of ${i}`);
    let r = [13, 14, 15, 16].map((k) => f(a.body, i, k)), m = Math.hypot(...r);
    r = m === 0 ? [1, 0, 0, 0] : r.map((v) => v / m);
    const want = qmul(q, r).map((v) => v * (m || 1));
    for (let k = 0; k < 4; k++) near(f(b.body, i, 13 + k), want[k], 1e-6, `rot_${k} of ${i}`);
    if (!a.body.subarray(68 * i + 24, 68 * i + 52).equals(b.body.subarray(68 * i + 24, 68 * i + 52))) errs.push(`bytes of ${i}`);
    if (errs.length) break;
  }
  if (Math.abs(Math.hypot(...[13, 14, 15, 16].map((k) => f(b.body, 0, k))) - Math.hypot(1.6, 0.4, -0.6, 0.2)) > 1e-5) errs.push("magnitude of 0");
  if (a.head.replace(/comment (min|max)[xyz] \S+\n/g, "") !== b.head.replace(/comment (min|max)[xyz] \S+\n/g, "")) errs.push("header");
  const minx = Number(/comment minx (\S+)/.exec(b.head)[1]);
  let lo = Infinity; for (let i = 0; i < n; i++) lo = Math.min(lo, f(b.body, i, 0));
  near(minx, lo, 1e-6, "minx");
  console.log(errs.length ? errs.join("; ") : "ok");
' -- "$work")" ok

case_ "no displacement"
scene still
align still
expect "status pass" "$(js still j.status)" pass
expect "moves the capture under 1 cm" "$(js still 'j.lidar_vs_ply.correction_max_m < 0.01')" true
expect "and applies it" "$(js still j.lidar_vs_ply.correction_applied)" true

case_ "the lever arm"
scene lever0 '{"mapLever":[0,0,0]}'
align lever0
expect "a zero arm stated for a 1 m arm fails (exit 4)" "$rc" 4
expect_contains "  on the RTK fit" "$(js lever0 j.reason)" "RTK p95"

case_ "a false fix"
scene falsefix '{"falseFix":true}'
align falsefix
expect "is dropped and counted" "$(js falsefix j.rtk_fit.false_fixes_dropped)" 1
expect "and the fit stays under 1 cm" "$(js falsefix 'j.rtk_fit.residual_p95_m < 0.01')" true
expect "status pass" "$(js falsefix j.status)" pass

case_ "lidar unrelated to the Gaussians"
scene random '{"lidar":"random"}'
align random
expect "exits 4" "$rc" 4
expect_contains "fails on the ICP inliers" "$(js random j.reason)" "ICP inliers"
expect "status fail, not applied" "$(js random '`${j.status} ${j.lidar_vs_ply.correction_applied}`')" "fail false"
expect "writes no .ply" "$([ -e "$work/random.ply" ] && echo yes || echo no)" no

case_ "RTK fixes 0.3 m off"
scene noisy '{"gnssNoise":0.3}'
align noisy
expect "exits 4" "$rc" 4
expect_contains "fails on the RTK p95" "$(js noisy j.reason)" "RTK p95"
expect "though ICP was reliable" "$(js noisy 'j.lidar_vs_ply["inliers_lt_0.1m_after"] > 0.4')" true
expect "nothing is applied, no .ply" "$(js noisy j.lidar_vs_ply.correction_applied) $([ -e "$work/noisy.ply" ] && echo yes || echo no)" "false no"

case_ "a file that is there but wrong"
scene brotli '{"encoding":"BROTLI"}'
align brotli
expect "a Potree encoding other than DEFAULT: exit 1" "$rc" 1
expect_contains "  naming the file" "$log" "brotli: metadata.json: encoding is 'BROTLI'"
scene noepsg '{"noEpsg":true}'
align noepsg
expect "a PLY without epsg: exit 1" "$rc" 1
expect_contains "  naming the file" "$log" "noepsg: point_cloud.ply: has no 'comment epsg'"
scene noarm '{"noRtkParam":true}'
align noarm
expect "a map_config.json without rtk_external_param: exit 1" "$rc" 1
expect_contains "  naming the file" "$log" "noarm: map_config.json: has no 3-number rtk_external_param"
for f in brotli noepsg noarm; do
  [ -e "$work/$f.ply" ] || [ -e "$work/$f.json" ] && bad "$f writes nothing" "an output exists"
done
ok "none of them writes an output"

case_ "a re-run"
first=$(sum "$work/shift.ply") first_json=$(sum "$work/shift.json")
align shift
expect "gives the same .ply" "$(sum "$work/shift.ply")" "$first"
expect "and the same .json" "$(sum "$work/shift.json")" "$first_json"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
