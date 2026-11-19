# DELOS Maze

Tilt-maze speedrun under glass. https://maze.tz.mt. MIT.

## Play
START, then tilt: cursor, touch drag or arrow keys. `R` restarts. Reach the highlighted pocket. Time is physics ticks / 240 s; a hidden tab pauses. After the goal, submit a name for the top 10 and watch any run (▶; Escape or ✕ to leave).

## Test
Node 22.13+ (the API test uses `node:sqlite`):

    for f in test/*.mjs; do node "$f" || exit 1; done

`test/determinism.mjs` also runs the replay under macOS JavaScriptCore and skips if it is absent. `node test/tools/cpu.mjs` measures verification CPU. After any physics change: `node test/record-replay.mjs test/maze-replay.json`, bump `PHYSICS_VERSION`, add the golden digest in `test/determinism.mjs`.

## Local dev with D1
    sh deploy/build.sh dist                      # fresh dir
    printf 'SCORE_SALT=dev-salt\n' > .dev.vars   # git-ignored
    npx wrangler d1 execute delos-maze --local --file=schema.sql
    npx wrangler pages dev dist --d1 DB=00000000-0000-0000-0000-000000000000
`/?test` exposes `window.__maze` (`.feed(holds)`, `.timeScale`, `.replay`).

## Deploy
1. `npx wrangler d1 create delos-maze`; put the id in `wrangler.toml`.
2. `npx wrangler d1 execute delos-maze --remote --file=schema.sql`
3. `npx wrangler pages project create delos-maze`; `npx wrangler pages secret put SCORE_SALT --project-name delos-maze`
4. `sh deploy/build.sh dist && npx wrangler pages deploy dist --project-name delos-maze`
5. Attach maze.tz.mt.

## Replay format
Per tick the input is the board-space tilt `{x, y}`, |v| <= 1, from cursor, touch or keys via the camera projection. The live loop quantises it to `q / 4096` (<= 0.0073 deg) and records that same integer pair, so the run and its replay are one computation.

Stream: `u8 format`, `u16 physics (LE)`, `varint ticks`, then runs of `(zigzag dx, zigzag dy, varint runLength-1)` against the previous run; gzipped, base64 in the POST. A 40 s solve is ~0.9 KB. See `replay.mjs`.

## Verification
`POST /api/runs {name, physics, replay}`: validate, decode, re-simulate with the same `maze.mjs`, `det-math.mjs`, `maze-data.mjs` as the client. Accept only if the goal is reached exactly on the final tick, with no error and every |input| <= 1; otherwise 422 with the reason. The server computes the time; no client time is trusted. One attempt per minute per salted IP hash. Bounded by `MAX_TICKS` (10 min) and `MAX_WORK`. Measured CPU (`test/tools/cpu.mjs`, M-series Mac): honest 40 s run 79 ms; adversarial 10-min run 3.3-4.5 s. Needs Workers Paid (30 s CPU).

The goal is the ellipse `GOAL_ELLIPSE` in `maze.mjs`: ball centre inside it with wall clearance >= radius. The renderer draws the same constants. Moving it changes physics: bump `PHYSICS_VERSION`.

`Math.sin/cos/asin/acos/hypot` are replaced by `det-math.mjs`; tests show Node (V8) and JavaScriptCore give bit-identical states.

Limits: a run is proven physically valid, not human-played; tool-assisted input is indistinguishable. Anyone can submit under any name. Only V8 and JSC are tested.
