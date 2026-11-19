import { parseMaze, createState, step, DT } from './maze.mjs';
import { MAZE_SVG } from './maze-data.mjs';
import { quantize, Q, Recorder, tiltOf, ticksToMs, formatMs } from './replay.mjs';

async function loadMazeRenderer(options) {
  const { createMazeRenderer } = await import('./maze-renderer.mjs');
  return createMazeRenderer(options);
}

// Modes: ready (board level and still, START shown, no physics) -> playing -> won; watching plays a stored replay.
// ponytail: maze time is simulated play time (ticks * DT): excludes pause/hidden tab, restarts on Reset.
// Every playing tick feeds step() the quantised board-space tilt and records that same value: the live run IS its replay.
export function createMazeView({ onWin, onWatchEnd, makeRenderer = loadMazeRenderer, test = false }) {
  const $ = id => document.getElementById(`maze-${id}`);
  const canvas = $('canvas'), status = $('status'), retry = $('retry'), pause = $('pause'), start = $('start'), stop = $('stop');
  const timeEl = $('time'), pad = $('pad'), dot = $('pad-dot');
  const listeners = [], directions = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], level: [0, 0] };
  const recorder = new Recorder();
  let geometry, state, renderer, frame = 0, last = 0, elapsed = 0, ticks = 0, paused = false, failed = false, disposed = false, request = 0, tilt = { x: 0, y: 0 };
  let mode = 'ready', replay = null, fed = null, timeScale = 1, padText = '', timeText = '';
  let pointer = null, touchId = null, directionText = '', pressed = '';
  let zoomed = matchMedia('(max-width: 600px)').matches;
  function listen(node, type, fn, options) { node.addEventListener(type, fn, options); listeners.push(() => node.removeEventListener(type, fn, options)); }
  function select(input, name) {
    const { x, y } = input, length = Math.hypot(x, y), divisor = Math.max(1, length);
    tilt = Number.isFinite(length) ? { x: x / divisor, y: y / divisor } : { x: 0, y: 0 };
    if (!length) name = 'level';
    const text = `Tilt: ${name || [y < -1e-8 ? 'up' : y > 1e-8 ? 'down' : '', x < -1e-8 ? 'left' : x > 1e-8 ? 'right' : ''].filter(Boolean).join(' ') || 'level'}${length && length < .1 ? ' (gentle)' : ''}`;
    if (pressed !== name) { pressed = name; for (const key of Object.keys(directions)) $(key).setAttribute('aria-pressed', String(key === name)); }
    if (directionText !== text) { directionText = text; $('direction').textContent = text; }
  }
  function showInput(x, y) { // on-board tilt indicator: the dot sits where the ball is being pushed
    const text = `${(50 + x * 44).toFixed(1)}%,${(50 + y * 44).toFixed(1)}%`;
    if (text === padText) return; padText = text;
    dot.style.left = `${(50 + x * 44).toFixed(1)}%`; dot.style.top = `${(50 + y * 44).toFixed(1)}%`;
  }
  function showTime() { const text = formatMs(ticksToMs(ticks)); if (text !== timeText) { timeText = text; timeEl.textContent = text; } }
  function forgetPointer() { const id = touchId; pointer = null; touchId = null; if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); }
  function clearPointer() { forgetPointer(); select({ x: 0, y: 0 }); }
  function stopLoop() { cancelAnimationFrame(frame); frame = 0; last = 0; elapsed = 0; clearPointer(); }
  function draw() { renderer.render(state, { zoomed }); }
  function fail(error) { failed = true; stopLoop(); start.hidden = true; stop.hidden = true; status.textContent = `Maze unavailable: ${error.message || error}. Retry.`; retry.hidden = false; }
  function nextFed() {
    while (fed && fed.left === 0) { if (fed.i >= fed.holds.length) { fed = null; return null; } fed.left = fed.holds[fed.i][0]; fed.q = [fed.holds[fed.i][1], fed.holds[fed.i][2]]; fed.i++; }
    if (!fed) return null; fed.left--; return fed.q;
  }
  function finish(text) { stopLoop(); mode = 'ended'; stop.hidden = true; status.textContent = text; draw(); } // frozen on the last frame; Reset returns to START
  function tick(time) {
    frame = 0; if (disposed || paused || failed || document.hidden || !state || (mode !== 'playing' && mode !== 'watching')) return;
    try {
      if (mode === 'playing' && !fed && pointer) select(renderer.project(pointer.x, pointer.y));
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
        step(geometry, state, { x: q[0] / Q, y: q[1] / Q }); elapsed -= DT; ticks++; showInput(q[0] / Q, q[1] / Q);
        if (state.error) throw new Error(String(state.error));
        if (mode === 'watching') {
          if (state.won || ticks >= replay.ticks) { showTime(); finish(state.won ? `Replay finished: ${formatMs(ticksToMs(ticks))}.` : 'Replay ended without a win.'); onWatchEnd?.({ won: state.won }); return; }
        } else if (state.won) {
          showTime(); mode = 'won'; stopLoop(); enableControls(false); status.textContent = `Goal reached in ${formatMs(ticksToMs(ticks))}.`; draw();
          onWin({ ms: ticksToMs(ticks), ticks, replay: recorder.snapshot() }); return;
        }
      }
      showTime(); draw(); frame = requestAnimationFrame(tick);
    } catch (error) { fail(error); }
  }
  function resume() { if (!disposed && !paused && !failed && !document.hidden && state && (mode === 'playing' || mode === 'watching') && !frame) { last = 0; elapsed = 0; frame = requestAnimationFrame(tick); } }
  function enableControls(on) { for (const key of [...Object.keys(directions), 'pause']) $(key).disabled = !on; }
  function toReady() { // pre-start: level, still, START shown; no tick, no timer
    stopLoop(); mode = 'ready'; replay = null; fed = null; state = createState(geometry); ticks = 0; recorder.reset(); renderer.reset();
    paused = false; pause.textContent = 'Pause'; retry.hidden = true; start.hidden = false; stop.hidden = true; timeEl.hidden = true; pad.hidden = true;
    padText = ''; timeText = ''; enableControls(false); select({ x: 0, y: 0 }); status.textContent = 'Ready. Press START to begin; the physics does not run until you do.';
    draw();
  }
  async function load() {
    const current = ++request; stopLoop(); failed = true; mode = 'ready'; retry.hidden = true; start.hidden = true; enableControls(false); status.textContent = 'Loading wooden maze…';
    renderer?.dispose(); renderer = null;
    try {
      const parsed = parseMaze(MAZE_SVG); if (disposed || current !== request) return;
      const created = await makeRenderer({ canvas, geometry: parsed, goalLabel: $('goal-label'),
        onContextLost() { if (!disposed && current === request) fail(new Error('Graphics context lost')); },
        onContextRestored() { if (!disposed && current === request) { status.textContent = 'Graphics restored. Retry to restart the maze.'; retry.hidden = false; } }
      });
      if (disposed || current !== request) { created.dispose(); return; }
      renderer = created; geometry = parsed; failed = false; toReady();
    } catch (error) { if (!disposed && current === request) { renderer?.dispose(); renderer = null; fail(error); } }
  }
  function begin() {
    if (mode !== 'ready' || failed || !renderer || !state) return;
    mode = 'playing'; ticks = 0; recorder.reset(); start.hidden = true; timeEl.hidden = false; pad.hidden = false; showTime(); showInput(0, 0); enableControls(true);
    status.textContent = 'Go. Tilt with the cursor, touch, arrow keys or buttons.'; canvas.focus(); resume();
  }
  function watch(run) {
    if (failed || !renderer || !run || !(run.ticks > 0)) return false;
    toReady(); mode = 'watching'; replay = run; start.hidden = true; stop.hidden = false; timeEl.hidden = false; pad.hidden = false; showTime(); showInput(0, 0);
    enableControls(false); pause.disabled = false; status.textContent = 'Watching replay at 1×. Press Stop to leave.'; resume(); return true;
  }
  function zoomLabel() { $('zoom').textContent = zoomed ? 'Show whole maze' : 'Close-up view'; $('zoom').setAttribute('aria-pressed', String(zoomed)); }
  zoomLabel();
  listen($('zoom'), 'click', () => { zoomed = !zoomed; zoomLabel(); redraw(); });
  listen(retry, 'click', load);
  listen(start, 'click', begin);
  listen(stop, 'click', () => { if (mode === 'watching') { toReady(); onWatchEnd?.({ won: false, stopped: true }); } });
  listen($('reset'), 'click', () => { if (!geometry || failed) return; try { toReady(); } catch (error) { fail(error); } });
  listen(pause, 'click', () => { if (!state || failed || (mode !== 'playing' && mode !== 'watching')) return; paused = !paused; pause.textContent = paused ? 'Resume' : 'Pause'; if (paused) stopLoop(); else resume(); });
  function cardinal(name) { if (!failed && !paused && mode === 'playing' && renderer) { forgetPointer(); select(renderer.direction(...directions[name]), name); } }
  for (const name of Object.keys(directions)) listen($(name), 'click', () => cardinal(name));
  listen(canvas, 'pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary || touchId !== null || failed || paused || mode !== 'playing' || !renderer) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    touchId = event.pointerId; pointer = { id: event.pointerId, type: 'touch', x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  listen(canvas, 'pointermove', event => {
    if (!event.isPrimary || failed || paused || mode !== 'playing' || !renderer || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (event.pointerType === 'touch' && touchId !== event.pointerId) return;
    if (touchId !== null && touchId !== event.pointerId) return;
    pointer = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY };
  });
  listen(canvas, 'pointerleave', event => { if (pointer && pointer.id === event.pointerId && pointer.type !== 'touch') clearPointer(); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, type, event => {
    if (touchId === event.pointerId) touchId = null;
    if (pointer && pointer.id === event.pointerId && (pointer.type === 'touch' || type !== 'pointerup')) clearPointer();
  });
  for (const node of [canvas, ...Object.keys(directions).map($), pause, $('reset'), retry, $('zoom')]) {
    listen(node, 'keydown', event => { const name = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key]; if (name && !failed && !paused && mode === 'playing') { event.preventDefault(); if (!event.repeat) cardinal(name); } });
    listen(node, 'blur', event => { if (!event.relatedTarget?.closest?.('#maze')) clearPointer(); });
  }
  listen(window, 'blur', clearPointer);
  listen(document, 'visibilitychange', () => { if (document.hidden) stopLoop(); else resume(); });
  listen(window, 'pagehide', stopLoop); listen(window, 'pageshow', resume);
  function redraw() { if (state && renderer && !failed) try { draw(); } catch (error) { fail(error); } }
  listen(window, 'resize', redraw);
  listen(matchMedia('(forced-colors: active)'), 'change', redraw);
  load();
  const api = { redraw, reset() { if (geometry && !failed) toReady(); }, watch,
    dispose() { if (disposed) return; disposed = true; request++; stopLoop(); renderer?.dispose(); renderer = null; for (const remove of listeners) remove(); } };
  Object.defineProperties(api, { mode: { get() { return mode; }, enumerable: true }, ticks: { get() { return ticks; }, enumerable: true } });
  // ?test hooks (never on by default): feed [ticks, qx, qy] holds through the real quantise -> record -> step path; speed up the clock.
  if (test) Object.defineProperties(api, { // not Object.assign: it would evaluate the getters once
    feed: { value(holds) { fed = { holds, i: 0, left: 0, q: [0, 0] }; } },
    timeScale: { set(value) { timeScale = value; }, get() { return timeScale; } },
    state: { get() { return state; } }, replay: { get() { return recorder.snapshot(); } } });
  return api;
}
