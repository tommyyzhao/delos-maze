// Accuracy of det-math.mjs against Math.* over dense samples, plus the guarantee it is built from exact ops only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sin, cos, asin, acos, hypot } from '../det-math.mjs';

const rows = [];
function check(name, fn, ref, lo, hi, n, tol, relative = false) {
  let worst = 0, at = 0;
  for (let i = 0; i <= n; i++) {
    const x = lo + (hi - lo) * i / n, want = ref(x), err = Math.abs(fn(x) - want) / (relative ? Math.max(Math.abs(want), 1e-300) : 1);
    if (err > worst) { worst = err; at = x; }
  }
  rows.push({ fn: name, range: `[${lo}, ${hi}]`, samples: n + 1, metric: relative ? 'max rel err' : 'max abs err', worst, at, tol });
  assert(worst <= tol, `${name} on [${lo},${hi}]: ${worst} at ${at} > ${tol}`);
}
const E = 2.3e-16; // ~1 ulp at 1
check('sin', sin, Math.sin, -Math.PI, Math.PI, 400000, E);
check('sin', sin, Math.sin, -100, 100, 400000, 5e-15);
check('cos', cos, Math.cos, -Math.PI, Math.PI, 400000, E);
check('cos', cos, Math.cos, -100, 100, 400000, 5e-15);
check('sin', sin, Math.sin, 0, Math.PI / 6, 200000, 1e-16 * 2);       // physics: tilt / 2 and tilt
check('cos', cos, Math.cos, 0, Math.PI / 6, 200000, 2.3e-16);
check('sin', sin, Math.sin, 1e-8, 1e-3, 100000, 1e-15, true);          // small angles keep relative accuracy
check('sin', sin, Math.sin, 0, 2 * Math.PI, 100000, 3e-16);            // parseMaze ellipse contour
check('cos', cos, Math.cos, 0, 2 * Math.PI, 100000, 3e-16);
check('asin', asin, Math.asin, -1, 1, 400000, 4.5e-16);
check('asin', asin, Math.asin, -0.5, 0.5, 200000, 3e-16);
check('asin', asin, Math.asin, 0, Math.sin(Math.PI / 6), 200000, 3e-16, false); // physics: SIN_TILT * m
check('asin', asin, Math.asin, 1e-8, 1e-2, 100000, 1e-15, true);
check('acos', acos, Math.acos, -1, 1, 400000, 4.5e-16);
check('acos', acos, Math.acos, 1 - 1e-3, 1, 100000, 1e-15);           // parseMaze: acos(1 - 0.05 / 371)
rows.push({ fn: 'acos', range: 'x = 1 - 0.05/371', samples: 1, metric: 'abs err', worst: Math.abs(acos(1 - 0.05 / 371) - Math.acos(1 - 0.05 / 371)), at: 1 - 0.05 / 371, tol: 1e-15 });
assert.equal(Math.ceil(Math.PI / acos(1 - 0.05 / 371)), Math.ceil(Math.PI / Math.acos(1 - 0.05 / 371)), 'ellipse vertex count n unchanged');
assert(Math.abs(acos(1 - 0.05 / 371) - Math.acos(1 - 0.05 / 371)) < 1e-15);
let worstHypot = 0;
for (let i = 0; i < 200000; i++) {
  const x = Math.sin(i * 1.3) * 10 ** (i % 7 - 3), y = Math.cos(i * 0.7) * 10 ** ((i >> 3) % 7 - 3), r = Math.abs(hypot(x, y) - Math.hypot(x, y)) / Math.hypot(x, y);
  if (r > worstHypot) worstHypot = r;
}
rows.push({ fn: 'hypot', range: '1e-3..1e3 mixed', samples: 200000, metric: 'max rel err', worst: worstHypot, at: '', tol: 5e-16 });
assert(worstHypot <= 5e-16, `hypot ${worstHypot}`);
// identities and exact special values
for (const [f, x, want] of [[sin, 0, 0], [cos, 0, 1], [asin, 0, 0], [asin, 1, Math.PI / 2], [asin, -1, -Math.PI / 2], [acos, 1, 0], [acos, -1, Math.PI], [hypot, 3, 5]]) {
  assert(Math.abs(f(x, 4) - want) < 2.3e-16 * Math.max(1, Math.abs(want)), `${f.name}(${x})`);
}
assert(Object.is(sin(0), 0) && Object.is(sin(-0), -0) || sin(-0) === 0);
for (const f of [sin, cos, asin, acos]) assert(Number.isNaN(f(NaN)) && Number.isNaN(f(Infinity)));
assert(Number.isNaN(asin(1.0000001)) && Number.isNaN(acos(-1.0000001)));
// the source uses only exact operations
const source = readFileSync(new URL('../det-math.mjs', import.meta.url), 'utf8');
const used = new Set([...source.replace(/\/\/.*$/gm, '').matchAll(/Math\.(\w+)/g)].map(m => m[1]));
for (const name of used) assert(['sqrt', 'floor', 'abs'].includes(name), `det-math uses Math.${name}`);
// no approximated Math.* on the physics or geometry path
for (const file of ['../maze.mjs', '../maze-geometry.mjs', '../replay.mjs']) {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['sin', 'cos', 'asin', 'acos', 'hypot', 'exp', 'atan', 'atan2', 'pow', 'log', 'tan', 'cbrt', 'sinh', 'cosh', 'tanh', 'expm1', 'log1p', 'log2', 'log10', 'fround'])
    assert(!new RegExp(`Math\\.${bad}\\b`).test(text), `${file} still calls Math.${bad}`);
  assert(!/\*\*/.test(text), `${file} uses **`);
}
if (process.env.DET_TABLE) console.log(JSON.stringify(rows, null, 1));
console.log(`PASS det-math: ${rows.length} accuracy checks, worst abs err ${Math.max(...rows.filter(r => r.metric === 'max abs err').map(r => r.worst)).toExponential(2)}, exact-ops-only source`);
