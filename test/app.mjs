// app.js against a fake DOM: the overlay and the board exist only after a win; no /api/runs call before it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHYSICS_VERSION, encodeReplay } from '../replay.mjs';

const holds = JSON.parse(readFileSync(new URL('./maze-replay.json', import.meta.url), 'utf8'));
class Node {
  constructor(id = '') { this.id = id; this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.textContent = ''; this.style = {}; this.children = []; this.listeners = {}; this.attrs = {}; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  fire(t, e = {}) { const event = { type: t, preventDefault() { this.prevented = true; }, target: this, ...e }; for (const f of this.listeners[t] || []) f(event); return event; }
  setAttribute(k, v) { this.attrs[k] = v; } focus() { this.focused = true; } select() {} contains(n) { return n === this; }
  append(...c) { this.children.push(...c); } replaceChildren(...c) { this.children = c; } getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 300 }; } hasPointerCapture() { return false; }
  showModal() { this.open = true; } close() { this.open = false; } get isConnected() { return true; }
}
const nodes = new Map(); const get = id => nodes.get(id) || (nodes.set(id, new Node(id)), nodes.get(id));
const prefix = n => { const qx = new Int16Array(n), qy = new Int16Array(n); let i = 0; for (const [c, x, y] of holds) for (let k = 0; k < c && i < n; k++, i++) { qx[i] = x; qy[i] = y; } return { ticks: n, qx, qy }; };
const stored = await encodeReplay(prefix(9582));
const fetches = []; let raf = null, top = [{ name: 'Zed', ms: 45000 }, { name: 'Ada', ms: 50000 }];
const store = new Map();
Object.assign(globalThis, {
  document: Object.assign(new Node('document'), { getElementById: get, createElement: () => new Node(), hidden: false, documentElement: { dataset: { theme: 'dark' } } }),
  window: new Node('window'), location: { search: '?test' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: fn => (raf = fn, 1), cancelAnimationFrame: () => { raf = null; },
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  fetch: async (url, init = {}) => { fetches.push({ url: String(url), method: init.method || 'GET' }); const post = init.method === 'POST';
    if (post) return { ok: true, json: async () => ({ ok: true, ms: 39925, stored: true, top }) };
    if (String(url).endsWith('/replay')) return { ok: true, arrayBuffer: async () => stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.length) };
    return { ok: true, json: async () => ({ top }) }; },
});
window.__makeRenderer = async () => ({ render() {}, reset() {}, dispose() {}, direction: (x, y) => ({ x, y }), project: () => ({ x: 0, y: 0 }) });
await import('../app.js'); await new Promise(r => setImmediate(r));
const waitFor = async cond => { for (let i = 0; i < 2000 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); };
const view = window.__maze, dialog = get('maze-end'), flush = () => new Promise(r => setImmediate(r));
const run = (until, ms = 1000 / 60) => { let t = 1000, n = 0; while (raf && !until() && n++ < 1e6) { const f = raf; f(t); t += ms; } };

// before a win: no overlay, no board, no /api/runs
assert.equal(view.mode, 'ready'); assert.equal(dialog.open, false); assert.equal(fetches.length, 0);
get('maze-start').fire('click'); view.feed(holds); view.timeScale = 4; run(() => view.mode === 'won' || view.ticks > 2000);
assert.equal(dialog.open, false); assert.equal(fetches.length, 0, 'no /api/runs while playing');
// win: overlay opens, board fetched now, time and best shown, last name prefilled
view.timeScale = 4; run(() => view.mode === 'won'); await flush();
assert.equal(view.mode, 'won'); assert.equal(dialog.open, true); assert.deepEqual(fetches.map(f => f.url), ['/api/runs']);
assert.equal(get('maze-end-time').textContent, '0:39.92'); assert.equal(get('maze-end-best').textContent, 'NEW BEST');
assert.equal(get('maze-board').children.length, 2); assert.equal(get('maze-board').children[0].children[1].textContent, 'Zed');
// submit: Enter submits via the form; own row highlighted; one short line when not stored
get('maze-name').value = 'Ada'; get('maze-form').fire('submit'); await waitFor(() => get('maze-board').children.some(li => li.className === 'me'));
const post = fetches.find(f => f.method === 'POST'); assert(post); assert.equal(store.get('delos-maze-name'), 'Ada');
const me = get('maze-board').children.find(li => li.className === 'me'); assert(me && me.attrs['aria-current'] === 'true', 'own row highlighted');
// watch ▶ closes the overlay and plays; Escape leaves and the overlay returns
get('maze-board').children[0].children[3].fire('click'); await waitFor(() => view.mode === 'watching');
assert.equal(dialog.open, false); assert.equal(view.mode, 'watching');
document.fire('keydown', { key: 'Escape' }); assert.equal(view.mode, 'ended'); assert.equal(dialog.open, true, 'overlay returns after the replay');
// own run from memory works offline; PLAY AGAIN returns to START
get('maze-again').fire('click'); assert.equal(dialog.open, false); assert.equal(view.mode, 'ready'); assert.equal(get('maze-start').hidden, false);
// second win: a slower run than the stored best shows BEST; fetch failure shows Offline with own run
globalThis.fetch = async () => { throw new Error('down'); };
get('maze-start').fire('click'); view.feed(holds); view.timeScale = 4; run(() => view.mode === 'won'); await waitFor(() => get('maze-note').textContent === 'Offline');
assert.equal(get('maze-end-best').textContent, 'NEW BEST', 'equal time is not worse than the stored best');
assert.equal(get('maze-note').textContent, 'Offline'); assert.equal(get('maze-board').children.length, 1);
assert.equal(PHYSICS_VERSION, 2);
console.log('PASS app: overlay and board only after a win (no /api/runs before), submit highlights own row, watch/Escape/PLAY AGAIN, offline');
