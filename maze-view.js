import { parseMaze, createState, step, DT } from './maze.mjs';
import { MAZE_SVG } from './maze-data.mjs';
import { quantize, Q, Recorder, ticksToMs, formatMs } from './replay.mjs';

async function loadMazeRenderer(options) {
  const { createMazeRenderer } = await import('./maze-renderer.mjs');
  return createMazeRenderer(options);
}

const GOAL_FADE_TICKS = 600; // the GOAL callout fades 2.5 s of play (or replay) after the first non-zero tilt

// Modes: ready (board level and still, START shown, no physics) -> playing -> won; watching plays a stored replay, then ended.
// ponytail: maze time is simulated play time (ticks * DT): excludes a hidden tab, restarts on R / reset().
// Every playing tick feeds step() the quantised board-space tilt and records that same value: the live run IS its replay.
export function createMazeView({ onWin, onWatchEnd, makeRenderer = loadMazeRenderer, test = false }) {
  const $ = id => document.getElementById(`maze-${id}`);
  const canvas = $('canvas'), status = $('status'), retry = $('retry'), start = $('start'), stop = $('stop'), goal = $('goal-label');
  const timeEl = $('time'), who = $('who'), pad = $('pad'), dot = $('pad-dot');
  const listeners = [], held = new Set();
  const recorder = new Recorder();
  let geometry, state, renderer, frame = 0, last = 0, elapsed = 0, ticks = 0, failed = false, disposed = false, request = 0, tilt = { x: 0, y: 0 };
  let mode = 'ready', replay = null, fed = null, timeScale = 1, padText = '', timeText = '', firstInput = -1;
  let pointer = null, touchId = null;
  function listen(node, type, fn, options) { node.addEventListener(type, fn, options); listeners.push(() => node.removeEventListener(type, fn, options)); }
  function select({ x, y }) {
    const length = Math.hypot(x, y), divisor = Math.max(1, length);
    tilt = Number.isFinite(length) ? { x: x / divisor, y: y / divisor } : { x: 0, y: 0 };
  }
  function showInput(x, y) { // replay tilt pad: the dot sits where the ball is being pushed
    const text = `${(50 + x * 44).toFixed(1)}%,${(50 + y * 44).toFixed(1)}%`;
    if (text === padText) return; padText = text;
    dot.style.left = `${(50 + x * 44).toFixed(1)}%`; dot.style.top = `${(50 + y * 44).toFixed(1)}%`;
  }
  function showTime() { const text = formatMs(ticksToMs(ticks)); if (text !== timeText) { timeText = text; timeEl.textContent = text; } }
  const fade = on => goal.setAttribute('data-fade', String(on));
  function forgetPointer() { const id = touchId; pointer = null; touchId = null; if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); }
  function clearInput() { forgetPointer(); held.clear(); select({ x: 0, y: 0 }); }
  function stopLoop() { cancelAnimationFrame(frame); frame = 0; last = 0; elapsed = 0; clearInput(); }
  function draw() { renderer.render(state); }
  function fail(error) { failed = true; stopLoop(); start.hidden = true; stop.hidden = true; status.textContent = `Failed: ${error.message || error}`; retry.hidden = false; }
  function nextFed() {
    while (fed && fed.left === 0) { if (fed.i >= fed.holds.length) { fed = null; return null; } fed.left = fed.holds[fed.i][0]; fed.q = [fed.holds[fed.i][1], fed.holds[fed.i][2]]; fed.i++; }
    if (!fed) return null; fed.left--; return fed.q;
  }
  function finish(text) { stopLoop(); mode = 'ended'; stop.hidden = true; status.textContent = text; draw(); } // frozen on the last frame
  function tick(time) {
    frame = 0; if (disposed || failed || document.hidden || !state || (mode !== 'playing' && mode !== 'watching')) return;
    try {
      if (mode === 'playing' && !fed && !held.size && pointer) select(renderer.project(pointer.x, pointer.y));
      if (last) elapsed += Math.min((time - last) / 1000, DT * 16) * timeScale;
      last = time;
      const budget = 16 * timeScale; let count = 0;
      while (elapsed >= DT && count++ < budget) {
        let q;
        if (mode === 'watching') q = [replay.qx[ticks], replay.qy[ticks]];
        else {
          const hold = nextFed(); if (hold) tilt = { x: hold[0] / Q, y: hold[1] / Q }; // ?test: same path as a real input
          q = quantize(tilt.x, tilt.y); recorder.push(q[0], q[1]);
        }
        if (firstInput < 0 && (q[0] || q[1])) firstInput = ticks;
        step(geometry, state, { x: q[0] / Q, y: q[1] / Q }); elapsed -= DT; ticks++; if (mode === 'watching') showInput(q[0] / Q, q[1] / Q);
        if (firstInput >= 0 && ticks - firstInput === GOAL_FADE_TICKS) fade(true);
        if (state.error) throw new Error(String(state.error));
        if (mode === 'watching') {
          if (state.won || ticks >= replay.ticks) { showTime(); finish(state.won ? `Goal ${formatMs(ticksToMs(ticks))}` : 'Replay ended'); onWatchEnd?.({ won: state.won }); return; }
        } else if (state.won) {
          showTime(); mode = 'won'; stopLoop(); status.textContent = `Goal ${formatMs(ticksToMs(ticks))}`; draw();
          onWin({ ms: ticksToMs(ticks), ticks, replay: recorder.snapshot() }); return;
        }
      }
      showTime(); draw(); frame = requestAnimationFrame(tick);
    } catch (error) { fail(error); }
  }
  function resume() { if (!disposed && !failed && !document.hidden && state && (mode === 'playing' || mode === 'watching') && !frame) { last = 0; elapsed = 0; frame = requestAnimationFrame(tick); } }
  function toReady() { // pre-start: level, still, START and the GOAL callout shown; no tick, no timer
    stopLoop(); mode = 'ready'; replay = null; fed = null; state = createState(geometry); ticks = 0; recorder.reset(); renderer.reset(); firstInput = -1;
    retry.hidden = true; start.hidden = false; start.disabled = false; start.textContent = 'START'; stop.hidden = true; timeEl.hidden = true; who.hidden = true; pad.hidden = true;
    padText = ''; timeText = ''; fade(false); status.textContent = 'Ready';
    draw();
  }
  async function load() {
    const current = ++request; stopLoop(); failed = true; mode = 'ready'; retry.hidden = true; start.hidden = false; start.disabled = true; start.textContent = 'Loading…'; status.textContent = 'Loading';
    renderer?.dispose(); renderer = null;
    try {
      const parsed = parseMaze(MAZE_SVG); if (disposed || current !== request) return;
      const created = await makeRenderer({ canvas, geometry: parsed, goalLabel: goal,
        onContextLost() { if (!disposed && current === request) fail(new Error('Graphics context lost')); },
        onContextRestored() { if (!disposed && current === request) { retry.hidden = false; } }
      });
      if (disposed || current !== request) { created.dispose(); return; }
      renderer = created; geometry = parsed; failed = false; toReady();
    } catch (error) { if (!disposed && current === request) { renderer?.dispose(); renderer = null; fail(error); } }
  }
  function begin() {
    if (mode !== 'ready' || failed || !renderer || !state) return;
    mode = 'playing'; ticks = 0; recorder.reset(); start.hidden = true; timeEl.hidden = false; showTime();
    status.textContent = 'Started'; canvas.focus(); resume();
  }
  function watch(run, name = '') {
    if (failed || !renderer || !run || !(run.ticks > 0)) return false;
    toReady(); mode = 'watching'; replay = run; start.hidden = true; stop.hidden = false; timeEl.hidden = false; pad.hidden = false; who.textContent = name; who.hidden = !name; showTime(); showInput(0, 0);
    status.textContent = name ? `Replay: ${name}` : 'Replay'; resume(); return true;
  }
  function leaveReplay() { if (mode === 'watching') { finish('Replay closed'); onWatchEnd?.({ won: false, stopped: true }); } }
  function reset() { if (geometry && !failed) try { toReady(); start.focus(); } catch (error) { fail(error); } }
  listen(retry, 'click', load);
  listen(start, 'click', begin);
  listen(stop, 'click', leaveReplay);
  const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  function keys() { // arrow keys tilt while held
    if (failed || mode !== 'playing' || !renderer) return;
    let x = 0, y = 0; for (const key of held) { x += arrows[key][0]; y += arrows[key][1]; }
    if (x || y) { forgetPointer(); select(renderer.direction(x, y)); } else select({ x: 0, y: 0 });
  }
  listen(document, 'keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target?.matches?.('input,select,textarea')) return;
    if (arrows[event.key]) { if (mode === 'playing') { event.preventDefault(); if (!held.has(event.key)) { held.add(event.key); keys(); } } }
    else if (event.key === 'Escape' && mode === 'watching') { event.preventDefault(); leaveReplay(); } // preventDefault: the reopened dialog must not take this same Escape as its own cancel
    else if ((event.key === 'r' || event.key === 'R') && (mode === 'playing' || mode === 'watching')) { const was = mode; reset(); if (was === 'watching') onWatchEnd?.({ won: false, reset: true }); }
  });
  listen(document, 'keyup', event => { if (held.delete(event.key)) keys(); });
  listen(canvas, 'pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary || touchId !== null || failed || mode !== 'playing' || !renderer) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    touchId = event.pointerId; pointer = { id: event.pointerId, type: 'touch', x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  listen(canvas, 'pointermove', event => {
    if (!event.isPrimary || failed || mode !== 'playing' || !renderer || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (event.pointerType === 'touch' && touchId !== event.pointerId) return;
    if (touchId !== null && touchId !== event.pointerId) return;
    pointer = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY };
  });
  listen(canvas, 'pointerleave', event => { if (pointer && pointer.id === event.pointerId && pointer.type !== 'touch') { forgetPointer(); if (!held.size) select({ x: 0, y: 0 }); } });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, type, event => {
    if (touchId === event.pointerId) touchId = null;
    if (pointer && pointer.id === event.pointerId && (pointer.type === 'touch' || type !== 'pointerup')) { forgetPointer(); if (!held.size) select({ x: 0, y: 0 }); }
  });
  listen(window, 'blur', clearInput);
  listen(document, 'visibilitychange', () => { if (document.hidden) stopLoop(); else resume(); }); // a hidden tab pauses
  listen(window, 'pagehide', stopLoop); listen(window, 'pageshow', resume);
  function redraw() { if (state && renderer && !failed) try { draw(); } catch (error) { fail(error); } }
  listen(window, 'resize', redraw);
  listen(matchMedia('(forced-colors: active)'), 'change', redraw);
  load();
  const api = { redraw, reset, watch,
    dispose() { if (disposed) return; disposed = true; request++; stopLoop(); renderer?.dispose(); renderer = null; for (const remove of listeners) remove(); } };
  Object.defineProperties(api, { mode: { get() { return mode; }, enumerable: true }, ticks: { get() { return ticks; }, enumerable: true } });
  // ?test hooks (never on by default): feed [ticks, qx, qy] holds through the real quantise -> record -> step path; speed up the clock.
  if (test) Object.defineProperties(api, { // not Object.assign: it would evaluate the getters once
    feed: { value(holds) { fed = { holds, i: 0, left: 0, q: [0, 0] }; } },
    timeScale: { set(value) { timeScale = value; }, get() { return timeScale; } },
    state: { get() { return state; } }, replay: { get() { return recorder.snapshot(); } } });
  return api;
}
