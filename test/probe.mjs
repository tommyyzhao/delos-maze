// Engine-independent fingerprint of the physics. Runs under Node (V8), JavaScriptCore and Workers alike:
// no Node APIs, no Math.* approximations. Used by test/determinism.mjs and test/jsc-run.mjs.
import { parseMaze, createState, step } from '../maze.mjs';
import { MAZE_SVG } from '../maze-data.mjs';
import { sin, cos, asin, acos, hypot } from '../det-math.mjs';
import { Q } from '../replay.mjs';

const buffer = new DataView(new ArrayBuffer(8));
export const hex = value => { buffer.setFloat64(0, value, false); let s = ''; for (let i = 0; i < 8; i++) s += buffer.getUint8(i).toString(16).padStart(2, '0'); return s; };
export const FIELDS = ['x', 'y', 'vx', 'vy', 'tilt.x', 'tilt.y', 'tiltRate.x', 'tiltRate.y', 'orientation.0', 'orientation.1', 'orientation.2', 'orientation.3'];
export const fields = s => [s.x, s.y, s.vx, s.vy, s.tilt.x, s.tilt.y, s.tiltRate.x, s.tiltRate.y, ...s.orientation];
export const stateHex = s => Object.fromEntries(FIELDS.map((k, i) => [k, hex(fields(s)[i])]).concat([['won', String(s.won)], ['error', String(s.error)]]));
// FNV-1a over the bytes of every float: one 32-bit pair per call, accumulated across ticks.
class Fnv {
  constructor() { this.h = 0x811c9dc5; this.g = 0x01000193 ^ 0x5bd1e995; }
  add(value) { buffer.setFloat64(0, value, false); for (let i = 0; i < 8; i++) { const b = buffer.getUint8(i); this.h = Math.imul(this.h ^ b, 0x01000193) >>> 0; this.g = Math.imul(this.g + b + 1, 0x85ebca6b) >>> 0; this.g = (this.g ^ (this.g >>> 13)) >>> 0; } }
  digest() { return this.h.toString(16).padStart(8, '0') + this.g.toString(16).padStart(8, '0'); }
}
function run(g, inputs) { // inputs: iterable of [ticks, qx, qy]
  const s = createState(g), trace = new Fnv(); let ticks = 0;
  outer: for (const [count, qx, qy] of inputs) for (let i = 0; i < count; i++) {
    step(g, s, { x: qx / Q, y: qy / Q }); ticks++;
    for (const v of fields(s)) trace.add(v);
    if (s.error || s.won) break outer;
  }
  return { ticks, trace: trace.digest(), final: stateHex(s) };
}
// Integer-only LCG: wall-hitting, bouncing, full-range noisy input.
export function noisyHolds(seed, total, maxHold = 60) {
  const out = []; let x = seed >>> 0, left = total;
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  while (left > 0) {
    const hold = Math.min(left, 1 + next() % maxHold); let qx, qy;
    do { qx = (next() >>> 8) % (2 * Q + 1) - Q; qy = (next() >>> 8) % (2 * Q + 1) - Q; } while (qx * qx + qy * qy > Q * Q);
    out.push([hold, qx, qy]); left -= hold;
  }
  return out;
}
export function mathDigest() {
  const t = new Fnv(); let n = 0;
  for (let i = 0; i < 20000; i++) { const x = (i - 10000) * 0.000731; t.add(sin(x)); t.add(cos(x)); n += 2; }
  for (let i = 0; i <= 20000; i++) { const x = i / 10000 - 1; t.add(asin(x)); t.add(acos(x)); n += 2; }
  for (let i = 0; i < 20000; i++) t.add(hypot(Math.sqrt(i + 1) * 0.37, i * 0.0113 - 100));
  return t.digest();
}
export function geometryDigest(g) {
  const t = new Fnv(); for (const c of g.contours) { t.add(c.length); for (const p of c) { t.add(p.x); t.add(p.y); } } return t.digest();
}
export function probe(winningHolds) {
  const g = parseMaze(MAZE_SVG);
  return { math: mathDigest(), geometry: geometryDigest(g), contours: g.contours.map(c => c.length).join(','), win: run(g, winningHolds),
    noisy1: run(g, noisyHolds(12345, 24000)), noisy2: run(g, noisyHolds(987654321, 24000, 400)) };
}

export const expand = holds => { const total = holds.reduce((s, r) => s + r[0], 0), qx = new Int16Array(total), qy = new Int16Array(total); let i = 0; for (const [n, x, y] of holds) { qx.fill(x, i, i + n); qy.fill(y, i, i + n); i += n; } return { ticks: total, qx, qy }; };
