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

# The Lixel L3's delivery: poses relative to #OFFSET, the lidar absolute in
# metadata.oct. The same displacement must come out the same.
case_ "the L3: a known displacement"
scene l3shift '{"l3":true,"shift":[0.4,0.3,0],"turnDeg":0.3}'
align l3shift
expect "exits 0" "$rc" 0
expect "status corrected" "$(js l3shift j.status)" corrected
expect "the correction undoes it within 1 cm at the corners" "$(js l3shift '
  const R = j.correction.rotation, t = j.correction.translation_m, a = 0.3 * Math.PI / 180;
  let worst = 0;
  for (const x of [-20, 20]) for (const y of [-10, 10]) for (const z of [0, 8]) {
    const m = [Math.cos(a) * x - Math.sin(a) * y + 0.4, Math.sin(a) * x + Math.cos(a) * y + 0.3, z];
    const c = [0, 1, 2].map((r) => R[r][0] * m[0] + R[r][1] * m[1] + R[r][2] * m[2] + t[r]);
    worst = Math.max(worst, Math.hypot(c[0] - x, c[1] - y, c[2] - z));
  }
  worst < 0.01')" true

case_ "the L3: no displacement"
scene l3still '{"l3":true}'
align l3still
expect "status pass" "$(js l3still j.status)" pass
expect "moves the capture under 1 cm" "$(js l3still 'j.lidar_vs_ply.correction_max_m < 0.01')" true

# The same absolute lidar read as metadata.json by the L2 Pro module, i.e.
# without the #OFFSET subtraction: it lands ~2,800 km off, and must fail.
case_ "the L3's lidar not carried by #OFFSET"
scene l3json '{"l3":true,"meta":"json","source":"L2Pro"}'
align l3json
expect "exits 4" "$rc" 4
expect_contains "fails on the ICP inliers" "$(js l3json j.reason)" "ICP inliers"

# The scanner is named by the PLY's header, so a metadata.json beside the
# L3's metadata.oct is not read.
case_ "the L3 with a stray metadata.json"
scene l3both '{"l3":true,"meta":"both"}'
align l3both
expect "is aligned" "$(js l3both '`${j.scanner} ${j.status}`')" "lixel-l3 pass"
expect "  as without it" "$(js l3both 'JSON.stringify(j.correction)')" "$(js l3still 'JSON.stringify(j.correction)')"
expect "  to the same .ply" "$(sum "$work/l3both.ply")" "$(sum "$work/l3still.ply")"

case_ "the L3's files there but wrong"
scene l3nooff '{"l3":true,"poseOffset":null}'
align l3nooff
expect "metadata.oct with no #OFFSET: exit 1" "$rc" 1
expect_contains "  naming the file" "$log" "l3nooff: poses.csv: has no #OFFSET [x,y,z] line"
scene l3two '{"l3":true,"poseOffset":[1,2]}'
align l3two
expect "an #OFFSET of two numbers: exit 1" "$rc" 1
expect_contains "  naming the file" "$log" "l3two: poses.csv: line 2: #OFFSET must be [x,y,z]"

# Revision 3 samples octree.bin by offset with a sparse shuffle; it must draw
# exactly what revision 2 drew. These are revision 2's outputs; revision 4
# adds only the `"scanner": "l2pro",` line after "scan", so it is taken out
# before the sum.
case_ "the L2 Pro cases unchanged by revisions 3 and 4"
sum_without_scanner() { grep -v '^  "scanner": "l2pro",$' "$1" | shasum -a 256 | cut -d' ' -f1; }
expect "shift.json" "$(sum_without_scanner "$work/shift.json")" 944530ff42af07157168dc22f5cf63f142c583b24026e44412e0415f11e9d6f7
expect "shift.ply" "$(sum "$work/shift.ply")" 9b4300c51d1b8bd026ab4a7f581d307ce164aa69e2a0926a6fe1d403c0a30b69
expect "still.json" "$(sum_without_scanner "$work/still.json")" 11cf3b29dadf51e06a3e05ebd23190022750c315328e911249c385ff7a62049d
expect "falsefix.json" "$(sum_without_scanner "$work/falsefix.json")" dc5cbcedc1f69eaf05bd3170941233243c7ebc908cad44cb3f9b3357721e3b87
expect "random.json" "$(sum_without_scanner "$work/random.json")" 5388c7a22e910c7a4b074a081f73c5c4ef8d46e48ebf5212bd4aaf900ff32940
expect "noisy.json" "$(sum_without_scanner "$work/noisy.json")" a57c00d7d45ff33fd126bdfeaca5904f6716c5ed52b8cbdf1af8e9e540950532
expect "and each names its scanner" "$(js shift j.scanner)" l2pro
# Revision 4's own outputs, the `scanner` line in: re-recorded once.
expect "shift.json, revision 4" "$(sum "$work/shift.json")" 33e029d5c6724ac3bd7dcd30e8c4b7ce56223e5c2cf8897babf2062300e06bc5
expect "still.json, revision 4" "$(sum "$work/still.json")" 4495d51d68e372d7841f0111f1b35cdc391056c057f2a64077b5ea9ba9c8f2cd
expect "falsefix.json, revision 4" "$(sum "$work/falsefix.json")" 239a38c162d8038f8c755eeb463476af81bcc88a463ca8fbebe605eea22fbb1a
expect "random.json, revision 4" "$(sum "$work/random.json")" efca1b9512c581e30ac30a5aba74d5f264d42be17d3aef13d43d70a2da76baae
expect "noisy.json, revision 4" "$(sum "$work/noisy.json")" ae5a59b58116ef09d978e5e4a029571035478b055adadb2944762f0a0bd793ed

# Which module reads a scan is the PLY's `comment source`.
case_ "the scanner modules"
scene k2 '{"source":"K2","shift":[0.4,0.3,0],"turnDeg":0.3}'
align k2
expect "a K2 scan is read by k2" "$(js k2 j.scanner)" k2
expect "  with the L2 Pro's correction" "$(js k2 'JSON.stringify(j.correction)')" "$(js shift 'JSON.stringify(j.correction)')"
scene drone '{"source":"Drone"}'
align drone
expect "a source no module claims: exit 5" "$rc" 5
expect "  skipped, naming the source" "$(js drone '`${j.status} ${j.scanner} ${j.reason}`')" "skipped null no scanner module for source 'Drone'"
expect "  and writes no .ply" "$([ -e "$work/drone.ply" ] && echo yes || echo no)" no
scene nosource '{"source":null}'
align nosource
expect "a PLY without comment source: exit 5" "$rc" 5
expect "  skipped" "$(js nosource j.reason)" "point_cloud.ply has no 'comment source'"
scene nometa '{"omit":["metadata.json"]}'
align nometa
expect "an L2 Pro scan without metadata.json: exit 5" "$rc" 5
expect "  skipped, naming the file" "$(js nometa '`${j.scanner} ${j.reason}`')" "l2pro no metadata.json"
scene gnssdir '{"omit":["gnss.csv"]}'
mkdir "$work/gnssdir/gnss.csv"
align gnssdir
expect "a directory under a file's name: exit 5" "$rc" 5
expect "  skipped, as missing" "$(js gnssdir j.reason)" "no gnss.csv"
# The PLY's header is checked before the skip is decided.
scene badnosource '{"source":null,"noEpsg":true}'
align badnosource
expect "a broken PLY without comment source: exit 1, not skipped" "$rc" 1
expect_contains "  naming the file" "$log" "badnosource: point_cloud.ply: has no 'comment epsg'"
expect "two modules claiming one source throw, naming both" "$(node --input-type=module -e '
  const { registry } = await import(process.argv[1]);
  try { registry([{ name: "a", sources: ["X"] }, { name: "b", sources: ["Y", "X"] }]); console.log("no throw"); }
  catch (e) { console.log(e.message); }' -- "$PWD/scripts/scanners/index.mjs")" "scanner modules a and b both claim source 'X'"

case_ "a re-run"
first=$(sum "$work/shift.ply") first_json=$(sum "$work/shift.json")
align shift
expect "gives the same .ply" "$(sum "$work/shift.ply")" "$first"
expect "and the same .json" "$(sum "$work/shift.json")" "$first_json"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
