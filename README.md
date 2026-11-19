# DELOS Maze

A tilt maze under glass with a replay-verified speedrun leaderboard. Live at https://maze.tz.mt. MIT licensed.

## Play
Press **START** (nothing runs before that), then move the cursor to tilt, drag on touch, or use arrow keys / buttons. Reach the marked torso pocket. Time is physics ticks x 1/240 s: pause and a hidden tab do not count. Submit a name to put your run on the board; the board keeps the best verified time per name (case-insensitive). **WATCH** replays any row at 1x with an on-board input dot. Offline, your local best is kept and you can still watch your last run.

## Test
Node 22.13+ (`node:sqlite` is used by the API test):

    for f in test/*.mjs; do node "$f" || exit 1; done

`test/determinism.mjs` shells out to macOS JavaScriptCore (`/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc`) and skips with a message if it is absent. `node test/tools/cpu.mjs` measures verification CPU. `node test/record-replay.mjs test/maze-replay.json` regenerates the recorded solve (required after any physics change; then bump `PHYSICS_VERSION` and the golden in `test/determinism.mjs`).

## Local dev with D1
    sh deploy/build.sh dist                      # fresh dir; never overwrite
    printf 'SCORE_SALT=dev-salt\n' > .dev.vars   # git-ignored
    npx wrangler d1 execute delos-maze --local --file=schema.sql
    npx wrangler pages dev dist --d1 DB=00000000-0000-0000-0000-000000000000
Open `/?test` for the test hooks (`window.__maze.feed(holds)`, `.timeScale`, `.replay`). They are off by default.

## Deploy
1. `npx wrangler d1 create delos-maze`; put the printed id in `wrangler.toml`.
2. `npx wrangler d1 execute delos-maze --remote --file=schema.sql`
3. `npx wrangler pages project create delos-maze` and `npx wrangler pages secret put SCORE_SALT --project-name delos-maze`
4. `sh deploy/build.sh dist && npx wrangler pages deploy dist --project-name delos-maze` (functions come from `functions/`).
5. Attach the custom domain maze.tz.mt to the Pages project.

## Replay format and the "TAS" stream
Physics input per tick is the **board-space tilt vector** `{x, y}`, |v| <= 1, produced from cursor, touch, keys or buttons through the camera projection. Raw screen coordinates are not reproducible across viewports, so the board-space input **is** the replay. Before every `step()` the live loop quantises it to the grid `q / 4096` (at most 30 deg / 4096 = 0.0073 deg per step, with |q| inside the unit disc) and records that same integer pair, so the live run and its replay are one computation.

Stream: `u8 format(1)`, `u16 physics version (LE)`, `varint ticks`, then runs of `(zigzag dx, zigzag dy, varint runLength-1)` as deltas from the previous run's value; the whole thing gzipped (`CompressionStream` in browsers, `DecompressionStream` in Workers) and base64'd in the POST. Typical sizes: recorded 40 s solve ~0.9 KB; 10 min of noisy cursor ~100-210 KB. Details in `replay.mjs`.

## Anti-cheat model and limits
`POST /api/runs {name, physics, replay}`: validate name and size, require the physics version, decode, re-simulate from `createState` with the same `maze.mjs`, `det-math.mjs` and `maze-data.mjs` the client runs, and accept only if `state.won` becomes true **exactly on the final tick** with no error and every |input| <= 1. Early wins (trailing inputs), no win, or errors are rejected (422 with the reason). The server computes the time (ticks x DT); no client time is trusted. One attempt per minute per salted IP hash (accepted or not, since verification is the costly part). Verification is bounded by `MAX_TICKS` (10 min) and a contact-sub-step budget `MAX_WORK`.

Determinism: ECMAScript leaves `Math.sin/cos/asin/acos/hypot/exp` implementation-approximated. All of them are replaced by `det-math.mjs` (only `+ - * /` and `Math.sqrt/floor/abs`), and the test proves Node (V8) and JavaScriptCore produce bit-identical states.

Limits: verification proves a run is *physically valid*, not that a human played it in real time. A tool-assisted or slow-motion input stream is indistinguishable from play, since the server only sees inputs. Anyone can also forge a valid optimal route offline. SpiderMonkey was not run in CI (only V8 and JSC). Per-name rows can be claimed by anyone who types the name.
