// Cross-engine determinism: the same replay run under Node (V8) and JavaScriptCore must give bit-identical
// states (every field compared as IEEE-754 hex, plus an FNV digest of the whole trajectory).
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe } from './probe.mjs';
import { PHYSICS_VERSION } from '../replay.mjs';

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';
const replayPath = fileURLToPath(new URL('./maze-replay.json', import.meta.url));
const holds = JSON.parse(readFileSync(replayPath, 'utf8'));
const node = probe(holds);
assert.equal(node.win.final.won, 'true'); assert.equal(node.win.final.error, 'null');
// Golden: a physics change must bump PHYSICS_VERSION and add a new entry here (old runs stay valid only for their version).
const GOLDEN = { 1: { winTrace: 'c6003b518276697b', winTicks: 9586 } };
const gold = GOLDEN[PHYSICS_VERSION];
if (process.env.PRINT_GOLDEN) console.log(JSON.stringify({ version: PHYSICS_VERSION, winTrace: node.win.trace, winTicks: node.win.ticks, math: node.math, geometry: node.geometry }));
assert(gold, `no golden digest for PHYSICS_VERSION ${PHYSICS_VERSION}: run PRINT_GOLDEN=1 node test/determinism.mjs`);
assert.deepEqual({ winTrace: node.win.trace, winTicks: node.win.ticks }, gold, 'physics changed without bumping PHYSICS_VERSION in replay.mjs (then add a GOLDEN entry)');
console.log(`node (V8): win ticks ${node.win.ticks}, trace ${node.win.trace}, math ${node.math}, geometry ${node.geometry}`);
console.log('node final x/y/vx/vy:', ['x', 'y', 'vx', 'vy'].map(k => node.win.final[k]).join(' '));

if (!existsSync(JSC)) { console.log(`SKIP jsc cross-engine check: ${JSC} not found (needs macOS JavaScriptCore)`); process.exit(0); }
const run = spawnSync(JSC, ['-m', fileURLToPath(new URL('./tools/jsc-run.mjs', import.meta.url)), '--', replayPath], { encoding: 'utf8', maxBuffer: 1 << 26 });
assert.equal(run.status, 0, `jsc failed: ${run.stderr || run.stdout}`);
const line = run.stdout.trim().split('\n').pop(), jsc = JSON.parse(line);
for (const key of ['math', 'geometry', 'contours']) assert.equal(jsc[key], node[key], `${key} differs between engines`);
for (const key of ['win', 'noisy1', 'noisy2']) {
  assert.equal(jsc[key].ticks, node[key].ticks, `${key} tick count`);
  assert.equal(jsc[key].trace, node[key].trace, `${key} trajectory digest`);
  assert.deepEqual(jsc[key].final, node[key].final, `${key} final state (hex)`);
}
console.log(`jsc (JavaScriptCore): win ticks ${jsc.win.ticks}, trace ${jsc.win.trace}, math ${jsc.math}, geometry ${jsc.geometry}`);
console.log(`noisy runs: node ${node.noisy1.ticks}/${node.noisy2.ticks} ticks, ends ${node.noisy1.final.error}/${node.noisy2.final.error} won=${node.noisy1.final.won}/${node.noisy2.final.won}`);
console.log('final state fields, node vs jsc (IEEE-754 hex):');
for (const key of Object.keys(node.win.final)) console.log(`  ${key.padEnd(14)} ${node.win.final[key]}  ${jsc.win.final[key]}  ${node.win.final[key] === jsc.win.final[key] ? 'identical' : 'DIFFERENT'}`);
console.log('PASS determinism: Node (V8) and JavaScriptCore are bit-identical (every state field, per-tick trajectory digest, det-math, geometry, 2 noisy wall-contact runs)');
