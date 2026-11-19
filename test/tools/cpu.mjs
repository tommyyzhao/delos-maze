// Measures server verification CPU. Prints JSON. Evidence only: not part of the pass/fail suite (see test/runs.mjs).
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { mazeGeometry, verifyReplay, Q, quantize, MAX_TICKS, MAX_WORK, packRaw, encodeReplay } from '../../replay.mjs';
import { noisyHolds } from '../probe.mjs';
const holds = JSON.parse(readFileSync(new URL('../maze-replay.json', import.meta.url), 'utf8'));
const expand = h => { const total = h.reduce((s, r) => s + r[0], 0), qx = new Int16Array(total), qy = new Int16Array(total); let i = 0; for (const [n, x, y] of h) { qx.fill(x, i, i + n); qy.fill(y, i, i + n); i += n; } return { ticks: total, qx, qy }; };
const g = mazeGeometry();
const time = (name, replay) => { const t = performance.now(), r = verifyReplay(g, replay), ms = performance.now() - t; return { name, ticks: replay.ticks, ok: r.ok, reason: r.reason, ms: Math.round(ms), work: r.state?.work, ticksPerSecond: Math.round(replay.ticks / ms * 1000) }; };
const out = [];
const win = expand(holds);
out.push(time('recorded winning replay (trimmed to the winning tick)', { ticks: 9586, qx: win.qx.slice(0, 9586), qy: win.qy.slice(0, 9586) }));
const full = expand(noisyHolds(4242, MAX_TICKS, 400)); // never wins within the cap: the worst case the server must bound
out.push(time(`noisy run at the MAX_TICKS cap`, full));
const wall = expand(noisyHolds(7, MAX_TICKS, 3000));
out.push(time('long-hold run at the cap (wall contacts)', wall));
const flat = n => ({ ticks: n, qx: new Int16Array(n).fill(Q), qy: new Int16Array(n) });
out.push(time('full tilt into the wall for the whole cap', flat(MAX_TICKS)));
const osc = flat(MAX_TICKS); for (let i = 0; i < MAX_TICKS; i++) { osc.qx[i] = (i >> 5) % 2 ? Q : -Q; }
out.push(time('full-range flip every 32 ticks', osc));
const spin = flat(MAX_TICKS); for (let i = 0; i < MAX_TICKS; i++) { const a = i / 240 * 3; [spin.qx[i], spin.qy[i]] = quantize(Math.cos(a), Math.sin(a)); }
out.push(time('circling tilt (1 rev per 2 s)', spin));
console.log(JSON.stringify({ node: process.version, maxTicks: MAX_TICKS, results: out }, null, 1));
