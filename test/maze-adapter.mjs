import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as replayLib from '../replay.mjs';
const adapterSource = readFileSync(new URL('../maze-view.js', import.meta.url), 'utf8').replace(/^import .*\n/gm, '').replace('export function createMazeView', 'function createMazeView');
const mazePhysics = await import('../maze.mjs');
const { MAZE_SVG: mazeAsset } = await import('../maze-data.mjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function adapter(frameMs) {
  class Node { constructor() { this.handlers = {}; this.clientWidth = 300; } focus() { this.focused = true; } addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); } removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter(x => x !== fn); } fire(type, extra = {}) { const event = { type, preventDefault() { this.prevented = true; }, ...extra }; for (const fn of this.handlers[type] || []) fn(event); return event; } getBoundingClientRect() { return { width: 300, height: 300, left: 0, top: 0 }; } setPointerCapture(id) { this.captured = id; } hasPointerCapture(id) { return this.captured === id; } releasePointerCapture(id) { if (this.captured === id) this.captured = null; } setAttribute(name, value) { this[name] = value; } }
  const nodes = Object.fromEntries(['canvas', 'goal-label', 'status', 'retry', 'start', 'stop', 'time', 'who', 'pad', 'pad-dot'].map(id => [id, Object.assign(new Node(), { style: {} })]));
  const document = new Node(); document.getElementById = id => nodes[id.replace('maze-', '')];
  nodes.stop.hidden = true; nodes.retry.hidden = true;
  const window = new Node(), media = new Node();
  let raf, time = 1, distance = 0, steps = 0, lastInput, lastState, options, disposed = 0, projections = 0, cardinalCalls = 0, broken = false, fetchFailure = false, pending;
  const geometry = mazePhysics.parseMaze(mazeAsset);
  const context = { document, window, matchMedia: () => media, MAZE_SVG: mazeAsset, ...replayLib, parseMaze: text => { if (fetchFailure) throw new Error('asset 503'); return mazePhysics.parseMaze(text); }, createState: mazePhysics.createState, step: (g, state, input) => { distance += input.x / 240; lastInput = input; steps++; mazePhysics.step(g, state, input); }, DT: mazePhysics.DT, requestAnimationFrame: fn => (raf = fn, 1), cancelAnimationFrame: () => { raf = null; }, URL };
  const create = runInNewContext(`${adapterSource}\ncreateMazeView`, context);
  const makeRenderer = async config => {
    options = config; if (pending) await pending;
    if (broken) throw Error('WebGL unavailable');
    return { render(state) { lastState = state; }, direction(x, y) { cardinalCalls++; return { x, y }; }, project(x, y) { projections++; return { x: (x - 150) / 150, y: (y - 150) / 150 }; }, reset() {}, dispose() { disposed++; } };
  };
  const view = create({ makeRenderer, onWin() { throw Error('unexpected win'); } });
  const key = (name, extra) => document.fire('keydown', { key: name, ...extra }), release = name => document.fire('keyup', { key: name });
  await flush();
  // START gating: loaded, level, still; no frame loop, no step, no timer before Start
  assert.equal(nodes.start.hidden, false); assert.equal(raf, null); assert.equal(steps, 0); assert.equal(nodes.time.hidden, true); assert.equal(nodes.pad.hidden, true); assert.equal(nodes.stop.hidden, true);
  nodes.canvas.fire('pointermove', { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 225, clientY: 150 }); key('ArrowDown');
  assert.equal(raf, null); assert.equal(steps, 0); assert.equal(view.mode, 'ready'); assert.equal(cardinalCalls, 0, 'inputs ignored before Start');
  window.fire('pageshow'); document.fire('visibilitychange'); assert.equal(raf, null); assert.equal(steps, 0);
  const begin = () => { nodes.start.fire('click'); assert(raf, 'Start begins the loop'); assert.equal(nodes.start.hidden, true); assert.equal(view.mode, 'playing'); assert.equal(nodes.pad.hidden, true, 'tilt pad is replay-only'); };
  const frame = () => { raf(time); time += frameMs; };
  begin(); key('ArrowRight');
  for (let i = 0; i < Math.ceil(1200 / frameMs); i++) { const next = raf; assert(next); next(time); time += frameMs; }
  assert(steps > 0); const result = distance; assert.equal(lastInput.x, 1); release('ArrowRight'); frame(); frame(); assert.equal(lastInput.x, 0, 'releasing the key levels the board');
  key('ArrowUp'); frame(); assert.equal(lastInput.y, -1); key('ArrowLeft'); frame(); assert(Math.abs(lastInput.x + Math.SQRT1_2) < 1e-3 && Math.abs(lastInput.y + Math.SQRT1_2) < 1e-3, 'two held arrows combine'); release('ArrowUp'); release('ArrowLeft'); frame();
  const calls = cardinalCalls; key('ArrowDown'); key('ArrowDown', { repeat: true }); frame(); assert.equal(lastInput.y, 1); assert.equal(cardinalCalls, calls + 1, 'key repeat ignored'); release('ArrowDown'); frame();
  const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 225, clientY: 150 };
  nodes.canvas.fire('pointermove', mouse); frame(); assert.equal(lastInput.x, .5); assert.equal(projections, 1);
  frame(); assert.equal(projections, 2);
  nodes.canvas.fire('pointerleave', mouse); frame(); assert.equal(lastInput.x, 0);
  for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const touch = { pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 225, clientY: 150 };
    nodes.canvas.fire('pointerdown', touch); assert.equal(nodes.canvas.captured, 2);
    nodes.canvas.fire('pointermove', { ...touch, clientX: 240 });
    nodes.canvas.fire('pointermove', { ...touch, pointerId: 3, isPrimary: false, clientX: 0 });
    frame(); assert.equal(lastInput.x, 2458 / 4096);
    nodes.canvas.fire(end, touch); frame(); assert.equal(lastInput.x, 0);
  }
  nodes.canvas.fire('pointermove', mouse); window.fire('blur'); frame(); assert.equal(lastInput.x, 0); frame(); assert.equal(lastInput.x, 0);
  const touch = { pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 225, clientY: 150 };
  for (const action of ['keyboard', 'reset', 'blur']) {
    nodes.canvas.fire('pointerdown', touch); assert.equal(nodes.canvas.captured, 2);
    if (action === 'keyboard') key('ArrowDown'); else if (action === 'blur') window.fire('blur'); else key('R');
    assert.equal(nodes.canvas.captured, null);
    nodes.canvas.fire('lostpointercapture', touch); nodes.canvas.fire('pointermove', touch);
    if (action === 'reset') { assert.equal(raf, null); assert.equal(view.mode, 'ready'); assert.equal(nodes.start.hidden, false, 'R returns to START'); assert.equal(nodes.time.hidden, true); const before = steps; nodes.canvas.fire('pointermove', touch); assert.equal(steps, before); begin(); }
    frame(); frame();
    assert.equal(lastInput.x, 0); assert.equal(lastInput.y, action === 'keyboard' ? 1 : 0);
    release('ArrowDown');
  }
  key('r', { ctrlKey: true }); assert.equal(view.mode, 'playing', 'Ctrl+R is the browser reload, not a restart');
  document.hidden = true; document.fire('visibilitychange'); assert.equal(raf, null, 'a hidden tab pauses'); document.hidden = false; document.fire('visibilitychange'); assert(raf);
  window.fire('pagehide'); assert.equal(raf, null); window.fire('pageshow'); assert(raf);
  options.onContextLost(); assert.equal(raf, null); assert.match(nodes.status.textContent, /Graphics context lost/); assert.equal(nodes.retry.hidden, false);
  options.onContextRestored(); assert.equal(raf, null); nodes.retry.fire('click'); await flush(); assert.equal(raf, null, 'Retry reloads to the pre-start state'); assert.equal(view.mode, 'ready'); assert.equal(nodes.start.hidden, false); assert.equal(nodes.retry.hidden, true); assert.equal(disposed, 1); begin();
  assert.notEqual(lastState, undefined); key('r'); assert.equal(raf, null); assert.equal(lastState.x, geometry.spawn.x);
  broken = true; nodes.retry.fire('click'); await flush(); assert.equal(raf, null); assert.match(nodes.status.textContent, /WebGL unavailable/); assert.equal(nodes.retry.hidden, false);
  broken = false; fetchFailure = true; nodes.retry.fire('click'); await flush(); assert.equal(raf, null); assert.match(nodes.status.textContent, /asset 503/);
  fetchFailure = false; let resolve; pending = new Promise(done => { resolve = done; }); nodes.retry.fire('click'); await flush();
  const count = disposed; view.dispose(); resolve(); await flush(); assert.equal(disposed, count + 1); assert.equal(raf, null);
  view.dispose(); assert.equal(disposed, count + 1);
  for (const node of [window, document, media, ...Object.values(nodes)]) for (const handlers of Object.values(node.handlers)) assert.equal(handlers.length, 0);
  return result;
}
const fast = await adapter(1000 / 60), slow = await adapter(1000 / 30);
assert(Math.abs(fast - slow) < .04); assert(fast > .8);
console.log('PASS maze adapter: frame rates, live pointer controls, lifecycle, context/asset failure, stale creation, cleanup (renderer mock only)');

// Real camera/raycast math, no WebGL mock. Both orientations and camera zooms.
const THREE = await import('../vendor/three/three.module.js');
const { projectBoardInput } = await import('../maze-renderer.mjs');
const rect = { left: 20, top: 30, width: 360, height: 360 };
const center = { x: 200, y: 210 };
for (const inclination of [-1, -.5, 0, .5, 1]) for (const bearing of [0, Math.PI / 4, Math.PI / 2]) for (const zoom of [1, 2.1]) {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(bearing), Math.sin(bearing), 0), inclination * mazePhysics.MAX_TILT);
  const camera = new THREE.PerspectiveCamera(36, 1, 1, 2500); camera.up.set(0, 1, 0);
  const target = new THREE.Vector3(zoom > 1 ? 130 : 0, zoom > 1 ? 50 : 0, 0).applyQuaternion(quaternion), distance = 660 / zoom;
  camera.position.copy(target).add(new THREE.Vector3(0, 0, distance)); camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const neutral = projectBoardInput(camera, quaternion, rect, center.x, center.y); assert.equal(neutral.x, 0); assert.equal(neutral.y, 0);
  for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1], [.6, .8]]) {
    const output = projectBoardInput(camera, quaternion, rect, center.x + x * 180, center.y + y * 180, true);
    assert(Math.abs(Math.hypot(output.x, output.y) - 1) < 1e-12);
    const localCenter = new THREE.Vector3();
    // Invert with actual center-plane ray; directions must reproject into screen activation.
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion), 0);
    raycaster.ray.intersectPlane(plane, localCenter);
    const origin = localCenter.clone().project(camera), end = localCenter.add(new THREE.Vector3(output.x, -output.y, 0).applyQuaternion(quaternion)).project(camera);
    const sx = end.x - origin.x, sy = -(end.y - origin.y), norm = Math.hypot(sx, sy);
    assert(Math.abs(sx / norm - x) < 1e-10); assert(Math.abs(sy / norm - y) < 1e-10);
  }
  for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1], [.6, .8]]) {
    let previous = 0;
    for (const magnitude of [.040001, .08, .2, .5, .98, 1, 1.2]) {
      const hover = projectBoardInput(camera, quaternion, rect, center.x + x * 180 * magnitude, center.y + y * 180 * magnitude);
      const strength = Math.hypot(hover.x, hover.y);
      const expected = Math.min(1, (magnitude - .04) / .96) ** 2;
      assert(Math.abs(strength - expected) < 1e-12, 'Quadratic fine control uses screen radius, independent of zoom');
      assert(strength >= previous - 1e-12 && (magnitude > 1 || strength > previous), 'Continuous ramp increases, then saturates');
      if (magnitude === .08) assert(Math.asin(strength * .5) * 180 / Math.PI < .05, 'Near-center control retains subdegree tilt');
      previous = strength;
    }
  }
  for (const radius of [0, .02, .039999]) {
    const dead = projectBoardInput(camera, quaternion, rect, center.x + radius * 180, center.y);
    assert.equal(dead.x, 0); assert.equal(dead.y, 0);
  }
  const invalid = projectBoardInput(camera, quaternion, rect, NaN, 0); assert.equal(invalid.x, 0);
}
console.log('PASS real perspective math: tilted-plane raycast, screen-direction inversion, zoom/follow, gentle magnitude, neutral, finite boundary');
