import { PHYSICS_VERSION, MAX_TICKS, MAX_RAW_BYTES, decodeReplay, fromBase64, mazeGeometry, verifyReplay, ticksToMs } from '../../replay.mjs';

// ponytail: verification proves a run is physically valid under the shared deterministic physics, not that a
// human played it in real time. A slow-motion or tool-assisted input stream is indistinguishable from play.
// Add input-timing telemetry or signed session tokens only if that ever matters.
const NAME = /^[A-Za-z0-9 _-]{1,16}$/, MAX_BODY = 600_000, WINDOW_MS = 60_000;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (error, status = 400) => json({ ok: false, error }, status);
const top = async db => (await db.prepare('SELECT name, ticks, created_at AS createdAt FROM runs WHERE physics = ? ORDER BY ticks ASC, id ASC LIMIT 20').bind(String(PHYSICS_VERSION)).all()).results
  .map(({ name, ticks, createdAt }) => ({ name, ms: ticksToMs(ticks), createdAt }));
// D1 returns BLOBs as ArrayBuffer (or a number[] on older runtimes); never let Response stringify an array.
const bytesOf = blob => (blob instanceof ArrayBuffer || ArrayBuffer.isView(blob) ? blob : Uint8Array.from(blob));
const hashIp = async (ip, salt) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + salt)))].map(b => b.toString(16).padStart(2, '0')).join('');

export async function onRequestGet({ request, env, params }) {
  const parts = [].concat(params?.path ?? []);
  if (!parts.length) return json({ physics: String(PHYSICS_VERSION), top: await top(env.DB) });
  if (parts.length === 2 && parts[1] === 'replay') {
    const key = decodeURIComponent(parts[0]);
    const row = /^\d+$/.test(key)
      ? await env.DB.prepare('SELECT replay, physics FROM runs WHERE id = ?').bind(Number(key)).first()
      : await env.DB.prepare('SELECT replay, physics FROM runs WHERE name_key = ? AND physics = ?').bind(key.toLowerCase(), String(PHYSICS_VERSION)).first();
    if (!row) return fail('no such run', 404);
    return new Response(bytesOf(row.replay), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-physics': row.physics } });
  }
  return fail('not found', 404);
}

export async function onRequestPost({ request, env, params }) {
  if (params?.path?.length) return fail('not found', 404);
  if (!env.SCORE_SALT) return fail('server not configured', 500);
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY) return fail('body too large', 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return fail('body too large', 413);
  let body; try { body = JSON.parse(text); } catch { return fail('invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!NAME.test(name)) return fail('name must be 1-16 letters, digits, space, _ or -');
  if (String(body.physics) !== String(PHYSICS_VERSION)) return fail(`physics version mismatch: server is ${PHYSICS_VERSION}; reload the page`, 409);
  let bytes; try { bytes = fromBase64(body.replay); } catch (error) { return fail(error.message); }
  if (!bytes.length) return fail('empty replay');

  // One attempt per minute per salted IP hash, claimed atomically BEFORE the CPU-heavy re-simulation, so rejected
  // replays are rate-limited too (a stored-rows-only limit would leave verification unthrottled).
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown', hash = await hashIp(ip, env.SCORE_SALT), now = Date.now();
  const claim = await env.DB.prepare('INSERT INTO attempts (ip_hash, at) VALUES (?1, ?2) ON CONFLICT(ip_hash) DO UPDATE SET at = ?2 WHERE at <= ?3').bind(hash, now, now - WINDOW_MS).run();
  if (!claim.meta?.changes) return fail('slow down: one submission per minute', 429);

  let replay; try { replay = await decodeReplay(bytes); } catch (error) { return fail(`invalid replay: ${error.message}`, 422); }
  if (String(replay.physics) !== String(PHYSICS_VERSION)) return fail('replay was recorded under a different physics version', 409);
  const result = verifyReplay(mazeGeometry(), replay);
  if (!result.ok) return fail(`replay rejected: ${result.reason}`, 422);

  const key = name.toLowerCase(), ticks = replay.ticks;
  const existing = await env.DB.prepare('SELECT id, ticks, physics FROM runs WHERE name_key = ?').bind(key).first();
  let stored = false;
  if (!existing) {
    await env.DB.prepare('INSERT INTO runs (name, name_key, ticks, physics, replay, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(name, key, ticks, String(PHYSICS_VERSION), bytes.buffer, hash, now).run(); stored = true;
  } else if (ticks < existing.ticks || existing.physics !== String(PHYSICS_VERSION)) {
    await env.DB.prepare('UPDATE runs SET name = ?, ticks = ?, physics = ?, replay = ?, ip_hash = ?, created_at = ? WHERE id = ?')
      .bind(name, ticks, String(PHYSICS_VERSION), bytes.buffer, hash, now, existing.id).run(); stored = true;
  }
  return json({ ok: true, ms: result.ms, ticks, stored, top: await top(env.DB) });
}
