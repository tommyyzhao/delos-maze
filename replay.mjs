// Replay format, input quantisation and the verifier, shared by the browser and the server.
// The recorded stream IS the replay: one quantised board-space tilt vector per physics tick.
import { parseMaze, createState, step, DT } from './maze.mjs';
import { MAZE_SVG } from './maze-data.mjs';

// Bump whenever maze.mjs, det-math.mjs, the maze asset or the quantisation grid changes. test/determinism.mjs
// pins a golden final-state digest and fails when physics moves without a bump.
export const PHYSICS_VERSION = 3;
export const FORMAT = 1;
// Input grid: q / 4096 per axis, |input| <= 1. Full tilt is 30 degrees, so one grid step is at most
// 30 / 4096 = 0.0073 degrees of tilt (finer than any pointer can resolve). q / 4096 is exact in binary.
export const Q = 4096;
export const MAX_TICKS = 10 * 60 * 240; // 10 minutes at 240 ticks/s; measured with test/tools/cpu.mjs (M-series Mac, Node 26): honest 40 s run 79 ms, adversarial 10-min runs 3.3-4.5 s. Needs Workers Paid (30 s CPU); the free tier's 10 ms would fail even honest runs.
// Verification CPU bound. Cost is dominated by contact sub-steps (state.work), not ticks: a ball flung at speed needs
// up to 512 per tick. The adversarial worst case is the 3.3-4.5 s above. A real run uses ~1 per tick (10k for the 40 s recorded solve).
export const MAX_WORK = 1_000_000;
export const MAX_RAW_BYTES = 2 * 1024 * 1024;
export const ticksToMs = ticks => Math.round(ticks * 1000 / 240);
export const formatMs = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0').slice(0, 2)}`;

export function quantize(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
  let qx = Math.max(-Q, Math.min(Q, Math.round(x * Q))) + 0, qy = Math.max(-Q, Math.min(Q, Math.round(y * Q))) + 0; // + 0 turns -0 into 0
  while (qx * qx + qy * qy > Q * Q) { if (Math.abs(qx) >= Math.abs(qy)) qx -= Math.sign(qx); else qy -= Math.sign(qy); }
  return [qx, qy];
}

export class Recorder {
  constructor() { this.reset(); }
  reset() { this.qx = new Int16Array(4096); this.qy = new Int16Array(4096); this.ticks = 0; }
  push(qx, qy) {
    if (this.ticks === this.qx.length) {
      for (const k of ['qx', 'qy']) { const bigger = new Int16Array(this[k].length * 2); bigger.set(this[k]); this[k] = bigger; }
    }
    this.qx[this.ticks] = qx; this.qy[this.ticks++] = qy;
  }
  snapshot() { return { ticks: this.ticks, qx: this.qx.slice(0, this.ticks), qy: this.qy.slice(0, this.ticks) }; }
}

// ---- raw stream: u8 format, u16 physics, varint ticks, then runs of (zigzag dx, zigzag dy, run length - 1).
function put(out, n) { while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); }
const zig = n => (n < 0 ? -2 * n - 1 : 2 * n);
const unzig = n => (n % 2 ? -(n + 1) / 2 : n / 2);
export function packRaw({ ticks, qx, qy }) {
  const out = [FORMAT, PHYSICS_VERSION & 255, PHYSICS_VERSION >> 8]; put(out, ticks);
  let px = 0, py = 0;
  for (let i = 0; i < ticks;) {
    let j = i + 1; while (j < ticks && qx[j] === qx[i] && qy[j] === qy[i]) j++;
    put(out, zig(qx[i] - px)); put(out, zig(qy[i] - py)); put(out, j - i - 1);
    px = qx[i]; py = qy[i]; i = j;
  }
  return Uint8Array.from(out);
}
export function unpackRaw(bytes) {
  let at = 0;
  const byte = () => { if (at >= bytes.length) throw new Error('truncated replay'); return bytes[at++]; };
  const varint = () => { let n = 0, scale = 1; for (let k = 0; k < 5; k++) { const b = byte(); n += (b & 0x7f) * scale; if (b < 0x80) return n; scale *= 128; } throw new Error('bad varint'); };
  if (byte() !== FORMAT) throw new Error('unknown replay format');
  const physics = byte() | (byte() << 8), ticks = varint();
  if (ticks < 1 || ticks > MAX_TICKS) throw new Error('replay length out of range');
  const qx = new Int16Array(ticks), qy = new Int16Array(ticks);
  let i = 0, px = 0, py = 0;
  while (i < ticks) {
    px += unzig(varint()); py += unzig(varint()); const run = varint() + 1;
    if (Math.abs(px) > Q || Math.abs(py) > Q || px * px + py * py > Q * Q) throw new Error('input outside the tilt range');
    if (run > ticks - i) throw new Error('run past the end of the replay');
    qx.fill(px, i, i + run); qy.fill(py, i, i + run); i += run;
  }
  if (at !== bytes.length) throw new Error('trailing bytes in replay');
  return { physics, ticks, qx, qy };
}

// ---- gzip + base64 (CompressionStream exists in browsers, Node 18+ and Workers).
export async function gzip(bytes) { return new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
export async function gunzip(bytes, limit = MAX_RAW_BYTES) {
  const reader = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip')).getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > limit) { reader.cancel().catch(() => {}); throw new Error('replay too large'); }
      chunks.push(value);
    }
  } catch (error) { throw error.message === 'replay too large' ? error : new Error('bad gzip data'); }
  const out = new Uint8Array(total); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
export const encodeReplay = async replay => gzip(packRaw(replay));
export const decodeReplay = async bytes => unpackRaw(await gunzip(bytes));
export function toBase64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
export function fromBase64(text) {
  if (typeof text !== 'string' || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('replay is not valid base64');
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

// ---- verification: re-simulate from createState. Accept only a win exactly on the final tick.
let cached;
export const mazeGeometry = () => (cached ||= parseMaze(MAZE_SVG));
export const tiltOf = (replay, i) => ({ x: replay.qx[i] / Q, y: replay.qy[i] / Q });
export function verifyReplay(g, replay) {
  const state = createState(g);
  for (let i = 0; i < replay.ticks; i++) {
    step(g, state, tiltOf(replay, i));
    if (state.error) return { ok: false, reason: `physics error at tick ${i + 1}: ${state.error}` };
    if (state.work > MAX_WORK) return { ok: false, reason: `replay exceeds the verification work budget at tick ${i + 1}` };
    if (state.won) return i === replay.ticks - 1 ? { ok: true, ticks: replay.ticks, ms: ticksToMs(replay.ticks), state } : { ok: false, reason: `won at tick ${i + 1}, before the final tick ${replay.ticks}` };
  }
  return { ok: false, reason: 'the ball never reached the goal' };
}
export { DT };
