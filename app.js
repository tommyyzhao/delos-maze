import { createMazeView } from './maze-view.js';
import { PHYSICS_VERSION, encodeReplay, decodeReplay, toBase64, formatMs } from './replay.mjs';

const $ = id => document.getElementById(id);
const test = new URLSearchParams(location.search).has('test');
const keys = { best: 'delos-maze-best-v1', name: 'delos-maze-name', theme: 'delos-maze-theme' };
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* in-session play still works */ } };
let last = null, busy = false, offline = false; // last: this session's most recent winning run, kept in memory

function renderBoard(top) {
  const list = $('maze-board'); list.replaceChildren();
  for (const row of top) {
    const item = document.createElement('li'), name = document.createElement('span'), time = document.createElement('span'), watch = document.createElement('button');
    name.textContent = row.name; time.textContent = formatMs(row.ms);
    watch.type = 'button'; watch.textContent = 'WATCH'; watch.setAttribute('aria-label', `Watch ${row.name}'s run`);
    watch.addEventListener('click', () => watchStored(row.name));
    item.append(name, time, watch); list.append(item);
  }
  $('maze-board-status').textContent = top.length ? '' : 'No verified runs yet. Be the first.';
}
async function loadBoard() {
  try {
    const response = await fetch('/api/runs', { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { top } = await response.json(); offline = false; renderBoard(top);
  } catch { offline = true; $('maze-board').replaceChildren(); $('maze-board-status').textContent = 'Leaderboard offline.'; }
}
const view = createMazeView({ test,
  onWin(run) {
    last = run.replay; // { ticks, qx, qy }
    const old = Number(read(keys.best)), best = old > 0 && old <= run.ms ? old : run.ms; if (best === run.ms) write(keys.best, String(run.ms));
    $('maze-result').hidden = false; $('maze-result-time').textContent = formatMs(run.ms);
    $('maze-result-best').textContent = best === run.ms ? `New local best: ${formatMs(best)}` : `Your local best: ${formatMs(best)}`;
    $('maze-submit-status').textContent = ''; $('maze-submit').disabled = false;
    $('maze-name').value = read(keys.name) || ''; $('maze-result-title').focus();
  },
  onWatchEnd() { $('maze-board-status').textContent = offline ? 'Leaderboard offline.' : ''; }
});
async function watchStored(name) {
  $('maze-board-status').textContent = `Loading ${name}'s replay…`;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(name)}/replay`, { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const replay = await decodeReplay(new Uint8Array(await response.arrayBuffer()));
    if (String(replay.physics) !== String(PHYSICS_VERSION)) throw new Error('recorded under a different physics version');
    $('maze-board-status').textContent = `Watching ${name}.`; $('maze-result').hidden = true;
    if (!view.watch(replay)) throw new Error('the maze is not ready');
    $('maze-canvas').scrollIntoView({ block: 'center' });
  } catch (error) { $('maze-board-status').textContent = `Could not load that replay: ${error.message}.`; }
}
$('maze-watch-mine').addEventListener('click', () => { if (last && view.watch(last)) $('maze-canvas').scrollIntoView({ block: 'center' }); });
$('maze-reset').addEventListener('click', () => { $('maze-result').hidden = true; });
$('maze-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !last) return;
  const name = $('maze-name').value.trim(), out = $('maze-submit-status'); busy = true; $('maze-submit').disabled = true; out.textContent = 'Submitting…';
  write(keys.name, name);
  try {
    const replay = toBase64(await encodeReplay(last));
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, physics: PHYSICS_VERSION, replay }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) { out.textContent = `Not accepted: ${body.error || `HTTP ${response.status}`}`; $('maze-submit').disabled = false; }
    else { out.textContent = body.stored ? `Verified: ${formatMs(body.ms)}. On the board.` : `Verified: ${formatMs(body.ms)}. Not faster than your best on the board, so it was not stored.`; offline = false; renderBoard(body.top); }
  } catch { out.textContent = `Leaderboard offline. Your local best (${formatMs(Number(read(keys.best)))}) is saved on this device.`; $('maze-submit').disabled = false; offline = true; }
  busy = false;
});
$('maze-theme').value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
$('maze-theme').addEventListener('change', event => { document.documentElement.dataset.theme = event.target.value === 'light' ? 'light' : 'dark'; write(keys.theme, document.documentElement.dataset.theme); view.redraw(); });
if (test) window.__maze = view;
loadBoard();
