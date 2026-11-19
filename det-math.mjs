// Deterministic elementary functions for the physics and geometry path.
// ECMAScript leaves Math.sin/cos/asin/acos/hypot/exp implementation-approximated, so V8, JavaScriptCore
// and SpiderMonkey may differ in the last bit. Everything here uses only + - * /, comparisons and
// Math.sqrt/floor/abs (IEEE-exact or correctly rounded in every engine), so results are bit-identical
// everywhere. Accuracy ~1e-16 absolute (see test/det-math.mjs). Valid ranges: |x| < 1e6 for sin/cos.
const PIO2_HI = 1.5707963267948966, PIO2_LO = 6.123233995736766e-17;
const PI_HI = 3.141592653589793, PI_LO = 1.2246467991473532e-16;
// fdlibm three-part pi/2 (33-bit pieces: k * piece is exact for |k| < 2^20).
const P1 = 1.57079632673412561417e+00, P2 = 6.07710050630396597660e-11;
const P3 = 2.02226624871116645580e-21, P3T = 8.47842766036889956997e-32;
const INV_PIO2 = 6.36619772367581382433e-01;
const SIN_C = [], COS_C = [], ASIN_C = [];
{
  let f = 1; // k!
  const fact = [1];
  for (let k = 1; k <= 25; k++) { f *= k; fact.push(f); }
  for (let k = 0; k <= 10; k++) {
    const sign = k % 2 ? -1 : 1;
    SIN_C.push(sign / fact[2 * k + 1]); COS_C.push(sign / fact[2 * k]);
  }
  let a = 1; // (2n)! / (4^n n!^2)
  for (let n = 0; n <= 32; n++) { ASIN_C.push(a / (2 * n + 1)); a *= (2 * n + 1) / (2 * n + 2); }
}
function sinKernel(r) {
  const r2 = r * r; let s = SIN_C[10];
  for (let k = 9; k >= 0; k--) s = SIN_C[k] + r2 * s;
  return r * s;
}
function cosKernel(r) {
  const r2 = r * r; let s = COS_C[10];
  for (let k = 9; k >= 0; k--) s = COS_C[k] + r2 * s;
  return s;
}
function reduce(x) { // x = k*pi/2 + r, |r| <= ~pi/4
  const k = Math.floor(x * INV_PIO2 + 0.5);
  return { k, r: (((x - k * P1) - k * P2) - k * P3) - k * P3T };
}
export function sin(x) {
  if (!(Math.abs(x) < 1e6)) return NaN;
  const { k, r } = reduce(x), q = k - 4 * Math.floor(k / 4);
  return q === 0 ? sinKernel(r) : q === 1 ? cosKernel(r) : q === 2 ? -sinKernel(r) : -cosKernel(r);
}
export function cos(x) {
  if (!(Math.abs(x) < 1e6)) return NaN;
  const { k, r } = reduce(x), q = k - 4 * Math.floor(k / 4);
  return q === 0 ? cosKernel(r) : q === 1 ? -sinKernel(r) : q === 2 ? -cosKernel(r) : sinKernel(r);
}
function asinSeries(x) { // |x| <= 0.5
  const x2 = x * x; let s = ASIN_C[32];
  for (let n = 31; n >= 0; n--) s = ASIN_C[n] + x2 * s;
  return x * s;
}
export function asin(x) {
  if (!(Math.abs(x) <= 1)) return NaN;
  const a = Math.abs(x);
  if (a <= 0.5) return asinSeries(x);
  const r = (PIO2_HI - 2 * asinSeries(Math.sqrt((1 - a) / 2))) + PIO2_LO;
  return x < 0 ? -r : r;
}
export function acos(x) {
  if (!(Math.abs(x) <= 1)) return NaN;
  if (x > 0.5) return 2 * asinSeries(Math.sqrt((1 - x) / 2));
  if (x < -0.5) return (PI_HI - 2 * asinSeries(Math.sqrt((1 + x) / 2))) + PI_LO;
  return (PIO2_HI - asinSeries(x)) + PIO2_LO;
}
export const hypot = (x, y) => Math.sqrt(x * x + y * y);
