import { createMazeView } from './maze-view.js';
import { PHYSICS_VERSION, encodeReplay, decodeReplay, toBase64, formatMs } from './replay.mjs';

const $ = id => document.getElementById(`maze-${id}`);
const test = new URLSearchParams(location.search).has('test');
const keys = { best: 'delos-maze-best-v1', name: 'delos-maze-name', theme: 'delos-maze-theme' };
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* in-session play still works */ } };
const dialog = $('end'), input = $('name'), form = $('form'), submit = $('submit'), note = $('note'), list = $('board');
// The leaderboard exists only after a win: nothing here touches /api/runs until onWin.
// The server re-simulates every submitted replay from its recorded tilt inputs (see README, functions/api/runs.js).
let mine = null, board = null, shownName = '', busy = false, epoch = 0, returnTo = null; // mine: this session's last winning run, kept in memory; board: null (loading) | 'offline' | top[]

function row({ rank, name, ms, me, watch }) {
  const item = document.createElement('li'), play = document.createElement('button');
  item.className = me ? 'me' : ''; if (me) item.setAttribute('aria-current', 'true');
  for (const text of [rank, name, formatMs(ms)]) { const cell = document.createElement('span'); cell.textContent = text; item.append(cell); }
  play.type = 'button'; play.textContent = '▶'; play.setAttribute('aria-label', `Watch ${name}`); play.addEventListener('click', () => watch(play));
  item.append(play); return item;
}
function renderBoard() {
  list.replaceChildren();
  if (board === null) return;
  const key = shownName.toLowerCase(), watchMine = button => startWatch(mine.replay, shownName || 'YOU', button);
  if (board === 'offline') { list.append(row({ rank: '', name: shownName || 'YOU', ms: mine.ms, me: true, watch: watchMine })); return; }
  board.map((top, i) => ({ top, rank: i + 1, me: top.name.toLowerCase() === key })).filter(({ rank, me }) => rank <= 10 || me)
    .forEach(({ top, rank, me }) => list.append(row({ rank, name: top.name, ms: top.ms, me, watch: button => watchStored(top.name, button) })));
  list.querySelector('.me')?.scrollIntoView({ block: 'nearest' });
}
async function loadBoard() {
  const mark = epoch; board = null; note.textContent = 'Loading…';
  try {
    const response = await fetch('/api/runs', { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { top } = await response.json(); if (mark !== epoch) return; board = top; note.textContent = '';
  } catch { if (mark !== epoch) return; board = 'offline'; note.textContent = 'Offline'; }
  renderBoard();
}
function open() {
  if (!dialog.open) dialog.showModal();
  if (returnTo?.isConnected) returnTo.focus(); else if (!form.hidden && matchMedia('(pointer: fine)').matches) { input.focus(); input.select(); } else dialog.focus();
  returnTo = null;
}
function startWatch(run, name, button) {
  returnTo = button; dialog.close();
  if (!view.watch(run, name)) { open(); note.textContent = 'Replay unavailable'; }
}
async function watchStored(name, button) {
  note.textContent = 'Loading…';
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(name)}/replay`, { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const replay = await decodeReplay(new Uint8Array(await response.arrayBuffer()));
    if (String(replay.physics) !== String(PHYSICS_VERSION)) throw new Error('physics version');
    note.textContent = ''; startWatch(replay, name, button);
  } catch { note.textContent = 'Replay unavailable'; }
}
const view = createMazeView({ test, makeRenderer: test ? window.__makeRenderer : undefined, // ?test only: lets tests inject a renderer
  onWin(run) {
    mine = run; epoch++; shownName = '';
    const old = Number(read(keys.best)), best = old > 0 && old < run.ms; if (!best) write(keys.best, String(run.ms));
    $('end-time').textContent = formatMs(run.ms); $('end-best').textContent = best ? `BEST ${formatMs(old)}` : 'NEW BEST';
    form.hidden = false; submit.disabled = false; input.value = read(keys.name) || ''; note.textContent = ''; board = null; renderBoard();
    open(); loadBoard();
  },
  onWatchEnd({ reset }) { if (!reset && mine) open(); }
});
function again() { epoch++; dialog.close(); view.reset(); }
$('again').addEventListener('click', again);
dialog.addEventListener('cancel', event => { event.preventDefault(); if (form.hidden) again(); }); // Escape never discards an unsubmitted win
dialog.addEventListener('keydown', event => { // focus trap: Tab wraps inside the dialog
  if (event.key !== 'Tab') return;
  const items = [...dialog.querySelectorAll('input,button')].filter(el => !el.disabled && el.getClientRects().length), first = items[0], last = items.at(-1);
  if (!items.length) return;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !mine) return;
  const name = input.value.trim(); if (!name) { input.focus(); return; }
  busy = true; submit.disabled = true; note.textContent = 'Submitting…'; write(keys.name, name);
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, physics: PHYSICS_VERSION, replay: toBase64(await encodeReplay(mine.replay)) }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) { note.textContent = body.error || `HTTP ${response.status}`; submit.disabled = false; }
    else { epoch++; shownName = name; board = body.top; note.textContent = body.stored ? '' : 'Not your best'; if (!body.stored) $('end-best').textContent = ''; form.hidden = true; renderBoard(); $('again').focus(); } // clear local "NEW BEST" when the server kept a faster run
  } catch { note.textContent = 'Offline'; submit.disabled = false; }
  busy = false;
});
const menu = $('menu'), theme = $('theme');
theme.value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
theme.addEventListener('change', () => { document.documentElement.dataset.theme = theme.value === 'light' ? 'light' : 'dark'; write(keys.theme, document.documentElement.dataset.theme); view.redraw(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
if (test) window.__maze = view;
