// The live loop quantises, records and steps with the same value: the recorded stream re-simulates to the identical state/win.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMazeView } from '../maze-view.js';
import { mazeGeometry, verifyReplay, tiltOf, Q } from '../replay.mjs';
import { createState, step } from '../maze.mjs';
import { fields, hex } from './probe.mjs';

const holds = JSON.parse(readFileSync(new URL('./maze-replay.json', import.meta.url), 'utf8'));
const g = mazeGeometry(), flush = () => new Promise(r => setImmediate(r));
const node = () => ({ hidden: false, disabled: false, style: {}, textContent: '', listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener() {}, setAttribute(k, v) { this[k] = v; }, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300 }), hasPointerCapture: () => false, fire(t, e = {}) { for (const f of this.listeners[t] || []) f({ preventDefault() {}, ...e }); } });
const ids = ['canvas', 'goal-label', 'status', 'retry', 'start', 'stop', 'time', 'who', 'pad', 'pad-dot'];
async function harness(project) {
  const nodes = new Map(ids.map(id => [`maze-${id}`, node()]));
  let frame = null, live = null, renders = 0;
  Object.assign(globalThis, { document: Object.assign(node(), { getElementById: id => nodes.get(id), hidden: false }), window: node(), matchMedia: () => ({ matches: false, ...node() }),
    requestAnimationFrame: fn => (frame = fn, 1), cancelAnimationFrame: () => { frame = null; } });
  let won = null;
  const view = createMazeView({ test: true, onWin: run => { won = run; }, makeRenderer: async () => ({ render(s) { live = s; renders++; }, reset() {}, dispose() {}, direction: (x, y) => ({ x, y }), project: project || (() => ({ x: 0, y: 0 })) }) });
  await flush();
  return { view, nodes, get frame() { return frame; }, get won() { return won; }, get live() { return live; }, fire: (id, t, e) => nodes.get(`maze-${id}`).fire(t, e), key: (key, e) => globalThis.document.fire('keydown', { key, ...e }) };
}
const run = async (h, frameMs, until) => { let t = 1000, n = 0; while (h.frame && !until() && n++ < 1e6) { const f = h.frame; f(t); t += frameMs; } };
const prefix = (holds, n) => { const qx = new Int16Array(n), qy = new Int16Array(n); let i = 0; for (const [c, x, y] of holds) for (let k = 0; k < c && i < n; k++, i++) { qx[i] = x; qy[i] = y; } return { ticks: n, qx, qy }; };

// 1. the recorded solve fed through quantise -> record -> step wins; the recorded stream re-simulates to the identical win, at any frame rate
for (const frameMs of [1000 / 60, 1000 / 144, 1000 / 30]) {
  const h = await harness(); assert.equal(h.view.mode, 'ready'); assert.equal(h.frame, null);
  h.view.feed(holds); h.view.timeScale = 1; h.fire('start', 'click'); assert.equal(h.view.mode, 'playing');
  await run(h, frameMs, () => h.won);
  assert(h.won, `won at ${frameMs} ms frames`); assert.equal(h.won.ticks, 9582); assert.equal(h.won.ms, 39925);
  const r = h.won.replay; assert.equal(r.ticks, 9582);
  const verdict = verifyReplay(g, r); assert(verdict.ok, verdict.reason); assert.equal(verdict.ms, h.won.ms);
  assert.deepEqual(fields(verdict.state).map(hex), fields(h.view.state).map(hex), 'live final state is bit-identical to the re-simulation');
  const expected = prefix(holds, 9582); assert(Buffer.from(r.qx.buffer, r.qx.byteOffset, r.ticks * 2).equals(Buffer.from(expected.qx.buffer, 0, r.ticks * 2)) && Buffer.from(r.qy.buffer, r.qy.byteOffset, r.ticks * 2).equals(Buffer.from(expected.qy.buffer, 0, r.ticks * 2)), 'recorded inputs equal the fed inputs');
  assert.equal(h.view.mode, 'won'); assert.equal(h.frame, null);
}
// 2. a raw, continuous pointer path (not on the quantisation grid): live state after N ticks == replay of the recording, bit for bit
{
  let phase = 0;
  const h = await harness(() => { phase += 0.013; return { x: Math.sin(phase) * 0.93, y: Math.cos(phase * 0.71) * 0.8 + 0.07 }; });
  h.fire('start', 'click'); h.fire('canvas', 'pointermove', { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 10, clientY: 10 });
  let frames = 0; await run(h, 1000 / 144, () => ++frames > 700);
  const r = h.view.replay; assert(r.ticks > 1000, `ticks ${r.ticks}`);
  for (let i = 0; i < r.ticks; i++) assert(Number.isInteger(r.qx[i]) && Number.isInteger(r.qy[i]) && r.qx[i] ** 2 + r.qy[i] ** 2 <= Q * Q);
  assert(new Set([...r.qx]).size > 50, 'the pointer actually varied');
  const s = createState(g); for (let i = 0; i < r.ticks; i++) step(g, s, tiltOf(r, i));
  assert.deepEqual(fields(s).map(hex), fields(h.view.state).map(hex), 'raw pointer play re-simulates bit-identically');
}
// 3. Start gating and R: nothing ticks before Start; R returns to the pre-start state and discards the recording
{
  const h = await harness(); const before = h.view.ticks;
  h.key('ArrowRight'); assert.equal(h.frame, null); assert.equal(h.view.ticks, before);
  assert.equal(h.nodes.get('maze-start').hidden, false); assert.equal(h.nodes.get('maze-time').hidden, true); h.key('r'); assert.equal(h.view.mode, 'ready');
  h.fire('start', 'click'); h.key('ArrowRight'); let f = 0; await run(h, 1000 / 60, () => ++f > 30); assert(h.view.ticks > 20);
  h.key('r'); assert.equal(h.view.mode, 'ready'); assert.equal(h.view.ticks, 0); assert.equal(h.frame, null); assert.equal(h.nodes.get('maze-start').hidden, false); assert.equal(h.view.replay.ticks, 0);
  assert.equal(h.live.x, g.spawn.x);
}
// 4. GOAL callout: shown pre-start, fades 2.5 s (600 ticks) after the first non-zero tilt, returns on R; replays follow the same rule
{
  const h = await harness(), goal = h.nodes.get('maze-goal-label'), fading = () => goal['data-fade'];
  assert.equal(fading(), 'false'); h.fire('start', 'click');
  let f = 0; await run(h, 1000 / 60, () => ++f > 600); assert.equal(fading(), 'false', 'no input yet: callout stays'); assert.equal(h.view.replay.ticks > 0, true);
  h.view.feed([[1, 0, 0], [5000, 800, 0]]); // one idle tick, then constant tilt
  let first = -1; await run(h, 1000 / 240, () => { const q = h.view.replay; if (first < 0 && q.qx[q.ticks - 1]) first = q.ticks - 1; return fading() === 'true'; });
  assert(first >= 0); const lag = h.view.ticks - first; assert.equal(lag, 600, `fades exactly 600 ticks after the first input (got ${lag})`);
  h.key('r'); assert.equal(fading(), 'false'); assert.equal(h.view.mode, 'ready');
  const stored = prefix(holds, 9582); h.view.watch(stored); assert.equal(fading(), 'false');
  const idle = stored.qx.findIndex((x, i) => x || stored.qy[i]); await run(h, 1000 / 240, () => fading() === 'true'); assert.equal(h.view.ticks - idle, 600, 'replay uses the same rule');
}
// 5. watch: plays the stored replay at 1x through the real step loop, stops at the win; Escape and R leave it; the pad follows the recorded input
{
  const h = await harness(); const stored = prefix(holds, 9582); const ends = [];
  assert.equal(h.view.watch(stored, 'Ada'), true); assert.equal(h.view.mode, 'watching'); assert.equal(h.nodes.get('maze-stop').hidden, false); assert.equal(h.nodes.get('maze-pad').hidden, false);
  assert.equal(h.nodes.get('maze-who').textContent, 'Ada'); assert.equal(h.nodes.get('maze-who').hidden, false);
  let dotSeen = new Set(); await run(h, 1000 / 60, () => { dotSeen.add(h.nodes.get('maze-pad-dot').style.left); return h.view.mode === 'ended'; });
  assert.equal(h.view.mode, 'ended'); assert.equal(h.view.ticks, 9582); assert.match(h.nodes.get('maze-status').textContent, /Goal 0:39\.92/); assert(dotSeen.size > 20, `indicator moved ${dotSeen.size}`);
  const s = createState(g); for (let i = 0; i < 9582; i++) step(g, s, tiltOf(stored, i)); assert.deepEqual(fields(s).map(hex), fields(h.view.state).map(hex));
  assert.equal(h.won, null, 'watching never reports a win');
  h.key('r'); assert.equal(h.view.mode, 'ended', 'R is for live play and replays; an ended replay waits for the overlay');
  h.view.watch(stored); let f = 0; await run(h, 1000 / 60, () => ++f > 10); h.key('Escape'); assert.equal(h.view.mode, 'ended'); assert.equal(h.frame, null); assert.equal(h.nodes.get('maze-stop').hidden, true);
  h.view.watch(stored); h.fire('stop', 'click'); assert.equal(h.view.mode, 'ended');
  h.view.watch(stored); h.key('r'); assert.equal(h.view.mode, 'ready');
}
console.log('PASS live loop: quantised recording re-simulates to the identical win (30/60/144 fps frames) and bit-identical state under raw pointer play; Start gating, R, GOAL fade, replay Escape/R');
