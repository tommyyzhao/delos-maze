// Encode/decode round trip, malformed input rejection, quantisation, and payload sizes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Q, quantize, Recorder, packRaw, unpackRaw, encodeReplay, decodeReplay, toBase64, fromBase64, gzip, MAX_TICKS, PHYSICS_VERSION } from '../replay.mjs';
import { noisyHolds, expand } from './probe.mjs';

const same = (a, b) => a.ticks === b.ticks && Buffer.from(a.qx.buffer, a.qx.byteOffset, a.ticks * 2).equals(Buffer.from(b.qx.buffer, b.qx.byteOffset, b.ticks * 2)) && Buffer.from(a.qy.buffer, a.qy.byteOffset, a.ticks * 2).equals(Buffer.from(b.qy.buffer, b.qy.byteOffset, b.ticks * 2));

// quantisation: integer grid, inside the unit disc, no -0, non-finite -> level
assert.deepEqual(quantize(0, 0), [0, 0]); assert(Object.is(quantize(-0, -0)[0], 0));
assert.deepEqual(quantize(NaN, 1), [0, 0]); assert.deepEqual(quantize(1, 0), [Q, 0]); assert.deepEqual(quantize(5, 0), [Q, 0]);
for (let i = 0; i < 20000; i++) { const [x, y] = quantize(Math.sin(i) * 1.3, Math.cos(i * 1.7) * 1.3); assert(Number.isInteger(x) && Number.isInteger(y) && x * x + y * y <= Q * Q); }
assert.equal(30 / Q < 0.0075, true, 'grid step <= 0.0075 degrees of tilt');

// round trips: recorded solve, noisy, extremes, single tick
const solve = expand(JSON.parse(readFileSync(new URL('./maze-replay.json', import.meta.url), 'utf8')));
const noisy10 = expand(noisyHolds(1, 10 * 60 * 240, 8));
const cases = { solve, noisy10, one: { ticks: 1, qx: Int16Array.of(-Q), qy: Int16Array.of(0) }, corners: { ticks: 4, qx: Int16Array.of(Q, -Q, 0, 0), qy: Int16Array.of(0, 0, Q, -Q) }, max: { ticks: MAX_TICKS, qx: new Int16Array(MAX_TICKS), qy: new Int16Array(MAX_TICKS) } };
for (const [name, replay] of Object.entries(cases)) {
  const raw = packRaw(replay), back = unpackRaw(raw);
  assert(same(back, replay), `${name}: raw round trip`); assert.equal(back.physics, PHYSICS_VERSION);
  const zipped = await encodeReplay(replay), decoded = await decodeReplay(zipped);
  assert(same(decoded, replay), `${name}: gzip round trip`);
  assert(same(unpackRaw(new Uint8Array(gunzipSync(zipped))), replay), `${name}: Node zlib reads CompressionStream output`);
  assert(same(await decodeReplay(fromBase64(toBase64(zipped))), replay), `${name}: base64 round trip`);
}
// Recorder
const rec = new Recorder(); for (let i = 0; i < 10000; i++) rec.push(i % 7 - 3, 100 - i % 11); const snap = rec.snapshot();
assert.equal(snap.ticks, 10000); assert.equal(snap.qx[9999], 9999 % 7 - 3); assert(same(unpackRaw(packRaw(snap)), snap));
// malformed streams
const good = packRaw(cases.corners);
await assert.rejects(decodeReplay(Uint8Array.from([1, 2, 3])), /bad gzip/);
assert.throws(() => unpackRaw(good.slice(0, good.length - 1)), /truncated|run past/);
assert.throws(() => unpackRaw(Uint8Array.from([...good, 0])), /trailing/);
assert.throws(() => unpackRaw(Uint8Array.from([9, ...good.slice(1)])), /format/);
assert.throws(() => unpackRaw(packRaw({ ticks: 1, qx: Int16Array.of(Q), qy: Int16Array.of(Q) })), /outside the tilt range/);
assert.throws(() => unpackRaw(Uint8Array.from([1, 1, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 1])), /bad varint|length/);
assert.throws(() => unpackRaw(Uint8Array.from([1, 1, 0, 0])), /length out of range/);
const bomb = await gzip(new Uint8Array(3 * 1024 * 1024));
await assert.rejects(decodeReplay(bomb), /too large/);
assert.throws(() => fromBase64('not base64!'), /base64/);

// payload sizes (gzipped raw stream; base64 adds 1/3)
const sizes = {};
for (const [name, replay] of Object.entries({ 'recorded test replay (40 s, 320 holds)': solve, 'synthetic 10 min noisy cursor (hold <= 8 ticks, full range)': noisy10 })) {
  const raw = packRaw(replay), zipped = await encodeReplay(replay); sizes[name] = { ticks: replay.ticks, rawBytes: raw.length, gzipBytes: zipped.length, base64Chars: toBase64(zipped).length };
}
// A realistic cursor: smooth Lissajous sweep + 1% jitter. The live loop picks the tilt once per display frame, so the
// input changes at the frame rate (60 Hz = every 4 ticks, 144 Hz = every 1.67 ticks), never every tick.
const n = 10 * 60 * 240;
function cursor(hz) {
  const qx = new Int16Array(n), qy = new Int16Array(n); let seed = 99;
  for (let i = 0; i < n; i++) {
    const frame = Math.floor(i * hz / 240); if (i === 0 || frame !== Math.floor((i - 1) * hz / 240)) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; cursor.q = quantize(Math.sin(frame / hz * 1.3) * .7 + Math.sin(frame / hz * 7.1) * .15 + (seed / 2 ** 32 - 0.5) * 0.02, Math.cos(frame / hz * 0.9) * .7 + Math.cos(frame / hz * 5.3) * .15 + (seed / 2 ** 32 - 0.5) * 0.02); }
    [qx[i], qy[i]] = cursor.q;
  }
  return { ticks: n, qx, qy };
}
for (const hz of [60, 144]) { const replay = cursor(hz), z = await encodeReplay(replay); sizes[`synthetic 10 min smooth cursor + jitter, ${hz} Hz frames`] = { ticks: n, rawBytes: packRaw(replay).length, gzipBytes: z.length, base64Chars: toBase64(z).length }; }
const worst = expand(noisyHolds(5, n, 1)); // a fresh random full-range vector EVERY tick: incompressible-ish worst case
const zw = await encodeReplay(worst);
sizes['pathological 10 min uniform-random vector every tick'] = { ticks: n, rawBytes: packRaw(worst).length, gzipBytes: zw.length, base64Chars: toBase64(zw).length };
if (process.env.SIZES) console.log(JSON.stringify(sizes, null, 1));
assert(sizes['synthetic 10 min noisy cursor (hold <= 8 ticks, full range)'].gzipBytes <= 256 * 1024);
for (const hz of [60, 144]) assert(sizes[`synthetic 10 min smooth cursor + jitter, ${hz} Hz frames`].gzipBytes <= 256 * 1024);
console.log(`PASS replay: round trip (raw/gzip/base64/zlib), malformed input, gzip bomb, quantisation; solve ${sizes['recorded test replay (40 s, 320 holds)'].gzipBytes} B gz, 10 min noisy ${sizes['synthetic 10 min noisy cursor (hold <= 8 ticks, full range)'].gzipBytes} B gz`);
