// functions/api/runs.js against a real SQLite (node:sqlite) wrapped as D1, running the real schema.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestGet, onRequestPost } from '../functions/api/runs.js';
import { PHYSICS_VERSION, MAX_TICKS, encodeReplay, toBase64, packRaw, gzip, quantize } from '../replay.mjs';
import { expand } from './probe.mjs';

let DatabaseSync; try { ({ DatabaseSync } = await import('node:sqlite')); } catch { console.log('SKIP runs: node:sqlite needs Node 22.13+'); process.exit(0); }
function fakeD1() {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const norm = a => a.map(v => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
  return { raw: db, prepare: sql => ({ bind: (...args) => ({
    first: async () => db.prepare(sql).get(...norm(args)) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...norm(args)) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...norm(args)).changes) } }) }) }) };
}
const holds = JSON.parse(readFileSync(new URL('./maze-replay.json', import.meta.url), 'utf8')), full = expand(holds), WIN = 9582;
const cut = (r, n) => ({ ticks: n, qx: r.qx.slice(0, n), qy: r.qy.slice(0, n) });
const winning = cut(full, WIN);
const b64 = async r => toBase64(await encodeReplay(r));
const goodB64 = await b64(winning);
const env = () => ({ DB: fakeD1(), SCORE_SALT: 'test-salt' });
let ipCounter = 0;
const post = (e, body, { ip = `10.0.0.${++ipCounter}`, raw } = {}) => onRequestPost({ request: new Request('https://maze.test/api/runs', { method: 'POST', headers: { 'CF-Connecting-IP': ip, 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }), env: e, params: {} });
const submit = (e, over = {}, opts) => post(e, { name: 'Ada', physics: PHYSICS_VERSION, replay: goodB64, ...over }, opts);
const reply = async res => ({ status: res.status, ...(await res.json()) });

// accepted: server-computed ms, stored, listed
{
  const e = env(), r = await reply(await submit(e, { client_ms: 1 }));
  assert.equal(r.status, 200); assert.equal(r.ok, true); assert.equal(r.ms, Math.round(WIN * 1000 / 240)); assert.equal(r.ticks, WIN); assert.equal(r.stored, true);
  assert.deepEqual(r.top.map(t => [t.name, t.ms]), [['Ada', 39925]]);
  const list = await (await onRequestGet({ request: new Request('https://maze.test/api/runs'), env: e, params: {} })).json();
  assert.equal(list.top.length, 1); assert.equal(list.top[0].ms, 39925); assert(Number.isInteger(list.top[0].createdAt)); assert.deepEqual(Object.keys(list.top[0]).sort(), ['createdAt', 'ms', 'name']);
  const row = e.DB.raw.prepare('SELECT * FROM runs').get(); assert.equal(row.ticks, WIN); assert.equal(row.name_key, 'ada'); assert.match(row.ip_hash, /^[0-9a-f]{64}$/); assert(!row.ip_hash.includes('10.0.0'));
  // replay served back byte-for-byte, by id and by name (case-insensitive)
  for (const key of [String(row.id), 'ADA', 'ada']) {
    const res = await onRequestGet({ request: new Request(`https://maze.test/api/runs/${key}/replay`), env: e, params: { path: [key, 'replay'] } });
    assert.equal(res.status, 200); assert.deepEqual(new Uint8Array(await res.arrayBuffer()), Uint8Array.from(Buffer.from(goodB64, 'base64')));
  }
  assert.equal((await onRequestGet({ request: new Request('https://maze.test/'), env: e, params: { path: ['nobody', 'replay'] } })).status, 404);
  assert.equal((await onRequestGet({ request: new Request('https://maze.test/'), env: e, params: { path: ['x'] } })).status, 404);
}
// 1-tick-truncated, extra trailing ticks, never-wins, tampered input, empty
{
  const e = env();
  for (const [label, replay, match] of [
    ['truncated by one tick', cut(full, WIN - 1), /never reached/],
    ['trailing ticks after the win', cut(full, WIN + 1), /won at tick 9582, before the final tick 9583/],
    ['full 9600-tick stream with trailing ticks', full, /before the final tick 9600/],
    ['first half only', cut(full, 4000), /never reached/]]) {
    const r = await reply(await submit(e, { replay: await b64(replay) })); assert.equal(r.status, 422, label); assert.equal(r.ok, false); assert.match(r.error, match, label);
  }
  const tampered = { ticks: WIN, qx: winning.qx.slice(), qy: winning.qy.slice() }; tampered.qx.fill(0, 3000, 3200); tampered.qy.fill(0, 3000, 3200); // a level pause where the real run was steering
  { const r = await reply(await submit(e, { replay: await b64(tampered) })); assert.equal(r.status, 422, 'tampered input'); assert.match(r.error, /rejected|never/); }
  const tooBig = { ticks: 1, qx: Int16Array.of(4096), qy: Int16Array.of(4096) };
  const outOfRange = await gzip(packRaw(tooBig)); // |v| > 1 cannot even be decoded
  { const r = await reply(await submit(e, { replay: toBase64(outOfRange) })); assert.equal(r.status, 422); assert.match(r.error, /tilt range/); }
  { const r = await reply(await submit(e, { replay: toBase64(Uint8Array.from([1, 2, 3, 4])) })); assert.equal(r.status, 422); assert.match(r.error, /gzip/); }
  { const r = await reply(await submit(e, { replay: '' })); assert.equal(r.status, 400); }
  assert.equal(e.DB.raw.prepare('SELECT COUNT(*) AS c FROM runs').get().c, 0, 'nothing stored for rejected replays');
}
// physics version, names, body shape, oversize, config
{
  const e = env();
  let r = await reply(await submit(e, { physics: PHYSICS_VERSION + 1 })); assert.equal(r.status, 409); assert.match(r.error, /physics version/);
  r = await reply(await submit(e, { physics: undefined })); assert.equal(r.status, 409);
  // a replay stream stamped with another physics version is rejected even when the request says current
  const stale = packRaw(winning); stale[1] = (PHYSICS_VERSION + 1) & 255;
  r = await reply(await submit(e, { replay: toBase64(await gzip(stale)) })); assert.equal(r.status, 409);
  for (const name of ['', ' ', 'a'.repeat(17), 'bad<name>', 'émile', 'x;y', 5, null, undefined]) { r = await reply(await submit(e, { name })); assert.equal(r.status, 400, `name ${name}`); assert.match(r.error, /name/); }
  r = await reply(await submit(e, { name: '  Pad Me  ' })); assert.equal(r.status, 200); assert.equal(r.top[0].name, 'Pad Me');
  r = await reply(await post(e, null, { raw: '{not json' })); assert.equal(r.status, 400);
  r = await reply(await post(e, null, { raw: '[]' })); assert.equal(r.status, 400);
  r = await reply(await post(e, null, { raw: JSON.stringify({ name: 'Big', physics: PHYSICS_VERSION, replay: 'A'.repeat(700_000) }) })); assert.equal(r.status, 413);
  r = await reply(await onRequestPost({ request: new Request('https://maze.test/api/runs', { method: 'POST', headers: { 'content-length': '9999999' }, body: '{}' }), env: e, params: {} })); assert.equal(r.status, 413);
  const bomb = toBase64(await gzip(new Uint8Array(3 * 1024 * 1024)));
  assert(bomb.length < 10_000); r = await reply(await submit(e, { replay: bomb })); assert.equal(r.status, 422); assert.match(r.error, /too large/);
  r = await reply(await submit({ DB: e.DB }, {})); assert.equal(r.status, 500);
  const long = packRaw({ ticks: MAX_TICKS + 1, qx: new Int16Array(MAX_TICKS + 1), qy: new Int16Array(MAX_TICKS + 1) });
  r = await reply(await submit(e, { replay: toBase64(await gzip(long)) })); assert.equal(r.status, 422); assert.match(r.error, /length/);
}
// rate limit: 1 attempt / minute / salted IP hash, shared by accepted and rejected attempts; other IPs and salts are independent
{
  const e = env(), ip = '203.0.113.9';
  assert.equal((await submit(e, { name: 'One' }, { ip })).status, 200);
  const blocked = await reply(await submit(e, { name: 'Two' }, { ip })); assert.equal(blocked.status, 429); assert.match(blocked.error, /one submission per minute/);
  assert.equal((await submit(e, { name: 'Two' }, { ip: '203.0.113.10' })).status, 200);
  assert.equal(e.DB.raw.prepare('SELECT COUNT(*) AS c FROM runs').get().c, 2);
  // a rejected replay also consumes the attempt (verification CPU is what is being rationed)
  const e2 = env(); assert.equal((await submit(e2, { replay: await b64(cut(full, 100)) }, { ip })).status, 422); assert.equal((await submit(e2, {}, { ip })).status, 429);
  // window expiry
  e.DB.raw.prepare('UPDATE attempts SET at = at - 61000').run(); assert.equal((await submit(e, { name: 'Three' }, { ip })).status, 200);
  const rows = e.DB.raw.prepare('SELECT ip_hash FROM attempts').all(); assert(rows.every(r => /^[0-9a-f]{64}$/.test(r.ip_hash) && !r.ip_hash.includes('203')));
  // a different salt hashes the same IP differently
  const salted = { DB: e.DB, SCORE_SALT: 'other-salt' }; assert.equal((await submit(salted, { name: 'Four' }, { ip })).status, 200);
}
// per-name best: one row per case-insensitive name; faster verified run replaces, equal/slower does not
{
  const e = env(), slow = await b64(winning);
  // a genuinely faster win: the same controller with TAU=0.1 (`TAU=0.1 node test/record-replay.mjs test/maze-replay-fast.json`)
  const fastFull = expand(JSON.parse(readFileSync(new URL('./maze-replay-fast.json', import.meta.url), 'utf8')));
  const { createState, step } = await import('../maze.mjs'); const { tiltOf, mazeGeometry } = await import('../replay.mjs'); const g = mazeGeometry(), s = createState(g); let won = 0;
  for (let i = 0; i < fastFull.ticks && !s.won; i++) { step(g, s, tiltOf(fastFull, i)); won = i + 1; }
  assert(s.won && won < WIN); const faster = cut(fastFull, won), fasterB64 = await b64(faster);
  let r = await reply(await submit(e, { name: 'Grace' })); assert.equal(r.stored, true);
  r = await reply(await submit(e, { name: 'GRACE', replay: slow })); assert.equal(r.status, 200); assert.equal(r.stored, false, 'equal time does not replace'); assert.equal(r.top.length, 1);
  r = await reply(await submit(e, { name: 'grace', replay: fasterB64 })); assert.equal(r.status, 200); assert.equal(r.stored, true, 'faster replaces'); assert.equal(r.ms, Math.round(faster.ticks * 1000 / 240));
  assert.deepEqual(r.top.map(t => [t.name, t.ms]), [['grace', Math.round(faster.ticks * 1000 / 240)]], 'one row, newest spelling of the name');
  r = await reply(await submit(e, { name: 'Grace', replay: slow })); assert.equal(r.stored, false, 'slower does not replace'); assert.equal(e.DB.raw.prepare('SELECT COUNT(*) AS c FROM runs').get().c, 1);
  assert.equal(e.DB.raw.prepare('SELECT ticks FROM runs').get().ticks, faster.ticks);
  // the stored replay is the faster one
  const res = await onRequestGet({ request: new Request('https://maze.test/'), env: e, params: { path: ['GRACE', 'replay'] } }); assert.deepEqual(new Uint8Array(await res.arrayBuffer()), Uint8Array.from(Buffer.from(fasterB64, 'base64')));
  // ordering and the 20 cap: fastest first
  await submit(e, { name: 'Linus' }); r = await reply(await onRequestGet({ request: new Request('https://maze.test/'), env: e, params: {} })); assert.deepEqual(r.top.map(t => t.name), ['grace', 'Linus']);
  for (let i = 0; i < 25; i++) e.DB.raw.prepare("INSERT INTO runs (name, name_key, ticks, physics, replay, ip_hash, created_at) VALUES (?, ?, ?, ?, x'00', 'h', 1)").run(`bot${i}`, `bot${i}`, 20000 + i, String(PHYSICS_VERSION));
  r = await reply(await onRequestGet({ request: new Request('https://maze.test/'), env: e, params: {} })); assert.equal(r.top.length, 20); assert.equal(r.top[0].name, 'grace');
  // rows of another physics version are not listed, and are replaced by a current-version run of the same name
  e.DB.raw.prepare("INSERT INTO runs (name, name_key, ticks, physics, replay, ip_hash, created_at) VALUES ('Old', 'old', 100, 'old-physics', x'00', 'h', 1)").run();
  r = await reply(await onRequestGet({ request: new Request('https://maze.test/'), env: e, params: {} })); assert(!r.top.some(t => t.name === 'Old'));
  r = await reply(await submit(e, { name: 'old', replay: slow })); assert.equal(r.stored, true, 'a current-physics run supersedes a stale-physics row even if slower'); assert.equal(e.DB.raw.prepare("SELECT physics FROM runs WHERE name_key = 'old'").get().physics, String(PHYSICS_VERSION));
}
console.log('PASS runs API: accept (server ms), truncated/trailing/tampered/oversize/physics/name rejection, rate limit, per-name best, listing, replay download');
