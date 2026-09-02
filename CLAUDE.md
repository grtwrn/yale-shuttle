# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Live web app at **https://yale-shuttle.fly.dev** showing Yale Downtowner shuttle positions, stop-level ETAs, and trip planning. Deployed as a single Fly.io machine in `ewr` with a 1 GB persistent volume mounted at `/data`.

**As of 2026-06-04 the production app is `services/shuttle-v2/`** (Node/Hono backend + React SPA). The original v1 stack (`services/shuttle-collector/` + `services/shuttle-map/`) is **archived, not deployed** — its code stays in the repo for reference, its root `fly.toml` was renamed to `fly.v1-archived.toml` so a stray root `flyctl deploy` can't resurrect it, and its historical data remains untouched on the volume as `/data/shuttle.db`.

**There is only one site/URL.** `https://yale-shuttle.fly.dev` is a single Fly app named `yale-shuttle` — the very app v1 used to occupy. v2 took over that same app/URL; the separate `yale-shuttle-v2` app was destroyed. So "the v1 site" and "the v2 site" are the same address: it serves **v2 code today**, and it *looks* like v1 only because v2's frontend is a drifted fork of v1's (see below). Both `services/shuttle-v2/fly.toml` and `fly.v1-archived.toml` declare `app = 'yale-shuttle'`, but only the v2 one is live.

⚠️ **To change the live site, edit `services/shuttle-v2/web/src/TransitMap.tsx` — NOT `services/shuttle-map/app/src/TransitMap.tsx`.** The latter is archived v1; edits there compile and lint fine but change nothing in production. (This has bitten before — a feature was prototyped in the v1 file while the real one already shipped in v2.)

## Architecture (v2 — `services/shuttle-v2/`)

One Node process (`src/index.ts`, run via tsx) does everything:

- **`src/collector/`** — polls `https://yale.downtownerapp.com` every 5 s, writes to SQLite at `$SHUTTLE_V2_DB` (`/data/shuttle-v2.db` in prod, `store/shuttle-v2.db` locally) through Drizzle ORM (`src/db/`, migrations in `drizzle/`).
- **`src/calibrator/`** — periodically rebuilds segment/dwell stats from collected samples (logs `collector.calibrated` every 5 min; hourly retention sweep on `raw_positions`).
- **`src/server/app.ts`** — Hono HTTP server (port 8080 prod, 8092 dev). Native v2 endpoints (`/api/live`, `/api/stream`, `/api/plan`) plus a **v1-compatibility layer** (`src/server/v1compat.ts`): `/api/buses` (the fat payload the frontend polls), `/api/geocode`, `/api/report`, `/api/reports`, `/api/accuracy`, `/healthz`.
- **`web/`** — Vite/React SPA served as static files from `web/dist`. `web/src/TransitMap.tsx` (~6.8k lines) is the user-facing shell; **the pure logic was extracted on 2026-08-31** into sibling modules that are unit-tested and where most changes now belong:

  | module | owns |
  |---|---|
  | `planner.ts` | `planTrip`, trip options, walk/ride/dominance rules |
  | `arrivals.ts` | `computeUpcomingArrivals` — per-stop ETA math |
  | `anchor.ts` | `findRouteAnchor` — which stop a bus is at / has passed |
  | `schedule.ts` | `ROUTE_HOURS`, `isBusInService`, ET day/hour resolution |
  | `routes.ts` | `ROUTE_LISTS` — **the single source of truth for route colour** |
  | `walk.ts` | the walk model (mirrors the server's `WALK_M_PER_S`) |
  | `geo.ts`, `format.ts` | distance/projection, and `min`-suffixed formatting |
  | `anonId.ts` | the anonymous per-browser id (see Usage metrics) |

  It began as a copy of v1's frontend but has **drifted substantially — don't assume it matches `services/shuttle-map/app/`**.

The frontend computes ETAs client-side from the `/api/buses` payload (positions + calibrated segments/dwells); it does not use the native v2 endpoints. `/api/plan` is used only by `scripts/map-bot.mjs` as ground truth — so a bug there is invisible to riders but corrupts the automated checks.

## Common commands

```bash
cd services/shuttle-v2

npm run dev          # backend on :8092 (collector + server, tsx watch)
npm run typecheck    # backend AND frontend types (a web/ scope error once shipped a live crash)
npm test             # vitest — 427 tests, covers src/ AND web/src/
npm run riders       # how many unique browsers are using the app

# frontend
cd web && npx vite build   # build = the frontend type/syntax gate
```

### Deploy

```bash
cd services/shuttle-v2
git push origin master    # THE way to deploy: .github/workflows/deploy.yml runs
                          # scripts/deploy.mjs (gates -> throwaway-DB staging ->
                          # API + browser smoke -> flyctl -> prod verify) on every
                          # push touching services/shuttle-v2/. Deploys come from
                          # committed history — commit + push, then watch
                          # `gh run list`.
npm run deploy            # same pipeline run locally; hotfix path when CI is down.
                          # -- --stage-only stops before prod.
~/.fly/bin/flyctl deploy --remote-only   # raw escape hatch; skips every check
                          # that has caught real bugs (wrong API-shape smoke
                          # assumptions, the ReferenceError that crashed prod).

# Health
curl -s https://yale-shuttle.fly.dev/healthz
# → {"ok":true,"pollStalenessMs":...,"collectorLagMs":...,"knownBuses":N}
~/.fly/bin/flyctl logs -a yale-shuttle --no-tail | tail -50
```

**Build `web/` (`npx vite build`) before deploying if you touched the frontend** — the Docker build compiles it, but building locally first catches errors without burning a deploy cycle.

## Conventions to preserve

These came from past bugs/feedback — don't re-litigate them:

- **Minutes** are spelled `min` in UI strings, never `m` (avoids mile confusion).
- **Origin / destination emoji**: 📍 / 🏁 (checkered flag), never 🎯.
- **Inputs must be ≥ 16 px font-size** to avoid iOS zoom-on-focus. Touch targets ≥ 44×44.
- **Hooks ordering in `TransitMap.tsx`**: a `useEffect`/`useMemo` dependency array is evaluated at render time — referencing a `const` declared later in the component is a TDZ `ReferenceError` that blank-screens the app (this happened; `main.tsx` now has an ErrorBoundary that surfaces such crashes instead of a white page).
- **TZ=America/New_York** in the Dockerfile — collector writes day/hour columns in ET. Don't change without auditing the calibration queries. The *client* must not read schedule times with `getDay()`/`getHours()` either: `schedule.ts` resolves ET explicitly, because a phone left on another timezone used to see "No shuttles running" while buses ran.
- **Route colour has one source**: `ROUTE_LISTS` in `web/src/routes.ts`. Three other tables used to hold their own copies and two had silently drifted. Everything else derives from it; a test fails if they disagree.
- **The walk model lives on the server** (`WALK_M_PER_S` in `src/network/TransitNetwork.ts`) and the client mirrors it. `walk.test.ts` parses the server's constant out of its source, so the two cannot drift. Change the server first, never one side alone.

## Bug reports

Users submit reports via the in-app "🚩 Report issue" / "💬 Send feedback". Workflow:

The two triage endpoints are **operator-only** — they require a shared secret,
because `GET /api/reports` returns each reporter's IP address alongside their
free-text complaint, and the update route was otherwise a public write into the
triage log. The token lives in the `SHUTTLE_ADMIN_TOKEN` Fly secret; a local
copy is at `~/.yale-shuttle-admin-token` (mode 600, deliberately outside the
repo). Without a configured token both endpoints fail closed with 503.

```bash
TOKEN=$(cat ~/.yale-shuttle-admin-token)

# triage queue
curl -s -H "x-admin-token: $TOKEN" \
  'https://yale-shuttle.fly.dev/api/reports?status=open'

# annotate when fixed
curl -s -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"status":"addressed","note":"..."}' \
  https://yale-shuttle.fly.dev/api/reports/{id}/update
```

`POST /api/report` (rider submissions) stays public and rate-limited. Reports
may carry a screenshot (client downscales to ≤1280 px JPEG; server verifies
magic bytes, caps at 2 MB, stores beside the DB in `report-images/`, never in a
row). View one with:

```bash
curl -s -H "x-admin-token: $TOKEN" \
  https://yale-shuttle.fly.dev/api/reports/{id}/image -o report.png
```

The site is an installable PWA (`web/public/manifest.webmanifest`, `sw.js`).
The service worker is deliberately network-first for everything and never
caches `/api/*` — do not make it cache-first, a stale bundle after a deploy is
the classic self-bricking failure.
`scripts/map-bot-cron.sh` reads the same token file for its dedupe check.

**Notes have two readers.** A rider sees the note as the "Reply" under their
report, so every note is `<one or two plain sentences for the rider>`, a line
`---`, then the technical log for the operator. The server (`riderFacingNote`
in `src/server/reports.ts`) shows riders only the text above the rule with the
machine tag stripped; `/api/reports` returns the whole thing. No jargon above
the rule — no file names, PR links, "triage". (The user's ask, 2026-09-01:
"the bot responses to issues is way too technical … even if it's just 'good
idea! looking into it'".)

**Always annotate after a fix.** The resolution field is the triage log; append, don't replace. Next agent should not re-investigate cold. Note prefixes are load-bearing (they go FIRST, before the rider text): `[triage]` = bot analysis awaiting the operator, `[approved]` = operator authorizes the bot to implement, `[pr]` = a feedback-bot PR awaits review, `[fixed]` = shipped, `automated:` = benign auto-close, `automated-abuse:` = spam close that earns a reputation strike.

### The feedback bot (autonomous triage)

Rider reports are triaged by a headless-`claude` bot on this Pi, event-driven:
the server pushes each submission/follow-up over `GET /api/reports/stream`
(admin SSE), `scripts/feedback-bot-listener.mjs` holds the connection (kept
alive by a 1-min cron; 6 h sweep as backstop) and runs
`scripts/feedback-bot-cron.sh`. Arbitration (`feedback-bot-arbitrate.mjs`):
operator-`[approved]` reports first, then priority tiers
(urgent > normal > nice_to_have), round-robin one report per reporter within a
tier, ≤3 per run; browsers with 3 `automated-abuse:` closes are auto-ignored
(strikes in `scripts/.feedback-bot/reputation.json` — delete an entry to
pardon). The bot triages/replies directly via the admin API, but CODE changes
happen in a disposable git worktree and become a `feedback-bot/*` branch + PR
— **merging the PR is the approval and deploys via master CI; closing
declines**. `npm run approve -- <id> [guidance]` pre-authorizes bigger work
(still a PR). The bot is told to PR simple requests — bugs and small feature
wishes alike — rather than `[triage]` them; `[triage]` is for policy/design
questions and anything near privacy, auth, schema or config. The wrapper enforces a file allowlist on the worktree diff and
re-runs the gates before any push; report bodies are treated as untrusted data
throughout (`feedback-bot-prompt.md`). **Every bot PR carries a screenshot**:
the wrapper stages the PR's own build on :8096, runs `scripts/pr-preview.mjs`
(phone-sized headless chromium; the bot's `pr-preview.json` recipe mocks the
API responses that make the feature visible, e.g. a rainy forecast), commits
the PNGs under `pr-preview/<id>/` on the PR branch and embeds them in the PR
body — the user's ask (2026-09-02): "for any pr, can we get a screenshot of the
feature to see it before approving?". To preview any branch by hand: build
`web/`, run the server on a spare port with a throwaway `SHUTTLE_V2_DB`, then
`BASE=http://127.0.0.1:<port> RECIPE=recipe.json OUT=/tmp/shots node
scripts/pr-preview.mjs`. Riders see everything in the in-app
Issues tab (`/api/my-reports`): statuses, notes (which are replies to them),
follow-ups (these reopen + wake the bot), archive, and self-rated priority.

## Usage metrics

`npm run riders` (or `GET /api/stats` with the same admin token) reports usage
and return visits: today (split new vs returning), 7 d / 30 d / all time, the
share that ever came back, week-1 retention, median days active, median minutes
per day, and destination searches.

The browser mints a random id (`web/src/anonId.ts`), keeps it in localStorage
beside the favourites it already stores, and sends it as `x-anon-id` on the
`/api/buses` poll it already makes — no extra request. The server writes **one
row per (ET day, id)** into `daily_actives` and nothing else: no IP, no user
agent, no coordinates, no time of day. 90-day retention, swept at the day
rollover.

**Retention needed no extra data.** A row per (day, id) already says whether a
browser came back, when it first appeared, and how many days it has been active.
The extra columns (`first_seen_ms`, `last_seen_ms`, `polls`, `searches`) buy
*depth* — time in app and query volume — not identity. A "search" is a
`/api/geocode` call, i.e. a deliberate destination lookup, as opposed to the
automatic 5-second poll.

**Week-1 retention only counts browsers that have HAD a week to return**, so it
is not diluted by yesterday's arrivals; it reports `null`, not 0, when nobody is
old enough to judge.

Three things to preserve if you touch it:

- **It must never cost a write per request.** `/api/buses` is ~40 req/s at
  launch load; the first sighting of an id writes one row and the id then lives
  in an in-memory Set for the day (~200 writes/day, not 3.5M). See
  `src/server/actives.ts`.
- **Counting must never break the endpoint.** Every path there is non-throwing;
  a rider with storage disabled is simply uncounted.
- **Counters accumulate in memory and flush on a timer** (60 s), so tests that
  inspect rows must `flush()` first — `stats()` flushes for you.

It counts browsers, not people — phone + laptop is two.

### The operator dashboard at /stats

`https://yale-shuttle.fly.dev/stats` is the same numbers on a phone, plus a
30-day stacked bar of new vs returning browsers. It is `web/public/stats.html`
— a standalone page with no React, no build step and no external request, so it
still works when the bundle does not; `/stats` (extensionless) is a small route
in `src/server/app.ts` and answers `/stats.html` identically (both `no-store`
— serveStatic alone would have left the `.html` spelling heuristically
cached). **Not linked from the rider app**, and `sw.js` skips both paths, so
the dashboard is never served from the rider shell's cache.

It reads `GET /api/stats` and `GET /api/stats/history?days=N` (1..90, default
30; days with no rows are absent, not zero). Both accept EITHER the
`x-admin-token` header or a `stats_session` cookie; **every other admin route
still requires the header** — the cookie must never unlock `/api/reports`,
which carries reporter IPs. The cookie is minted by `POST /api/stats/session`
(rate-limited, 10/min per IP) and is stateless: `"<expiryMs>.<hmac_sha256(admin
token, expiryMs)>"`, HttpOnly + Secure + SameSite=Strict + `Path=/api/stats`,
30 days. So there is no session table, a restart does not log the operator out,
and **the admin token itself is never stored in the browser**.

Chart colours are tokens on `:root`, redefined for dark mode, and the pair was
run through the dataviz palette validator in both modes — don't re-pick them by
eye.

**Test traffic is excluded, not deleted.** Browser harnesses drive the live
site, so they mint real ids and would otherwise appear as riders who never
return — dragging week-1 retention toward zero for a month. `excluded_anon_ids`
lists ids the statistics ignore; the rows stay for audit. Every harness in
`scripts/` seeds `TEST_ANON_ID` (`scripts/testId.mjs`) before its first `goto`,
and the server seeds that id into the table at startup, so a NEW harness is
excluded automatically — call `seedTestId(ctx)` and there is no cleanup step to
forget. To flag traffic manually:

```bash
TOKEN=$(cat ~/.yale-shuttle-admin-token)
# one browser
curl -s -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"anonId":"<uuid>","note":"why"}' \
  https://yale-shuttle.fly.dev/api/stats/exclude
# every browser seen so far (how a pre-launch database gets zeroed)
curl -s -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"all":true,"note":"pre-launch testing"}' \
  https://yale-shuttle.fly.dev/api/stats/exclude
```

## Route lines: the published geometry is right, drawing it was wrong

Riders reported straight diagonals cutting across the map on Orange, then Green.
Three explanations were tried and **two were wrong**; the record matters because
each looked convincing:

1. ~~"Upstream's polyline is too coarse."~~ **False.** Yale's own map draws these
   exact same published lines perfectly (Purple, Orange Night — checked against
   screenshots of `yale.downtownerapp.com`). A polyline needs a vertex only
   where the road turns, so 37 points describe a 9.5 km loop just fine.
2. ~~"Derive better geometry from stored bus positions."~~ Built, measured, and
   now barely used — see below. It was solving the wrong problem.
3. **The consumer was snapping stops to the nearest VERTEX.** A stop mid-block
   is far from any corner: on Orange Night the median stop is **97 m from the
   nearest vertex but 6 m from the line itself**. That mis-measured every leg,
   mis-ordered stops sharing a vertex, and wrapped — and the length guard then
   replaced the wrap with a straight line through the buildings.

`traceStopLegs` in `web/src/geo.ts` now **projects each stop onto the segments**
and walks forward from the previous stop's projected position. Result: **98.9%
of every drawn metre lies exactly on the published route** (13 of 15 routes at
100.0%), measured by sampling each drawn leg every 15 m and taking its distance
to the published polyline. That measurement is the right one — counting
"diagonals" is a proxy and it misled twice.

Two guards remain, and both are set from measurement, not intuition:

- **A leg may not exceed 70% of the loop.** Across all 15 routes the longest
  legitimate leg is 51.7% (Grocery TJ, five stops far apart); a wrap produces
  88%+ (Green's one bad leg is 98.2%). At 0.5 it cut Grocery TJ's real legs and
  drew 1,567 m across open water; at 0.9 it stopped catching a line published in
  the wrong direction.
- **No whole-ride backstop.** The old one discarded any ride longer than 2.5x the
  straight line through its stops — which an out-and-back exceeds by
  construction, throwing away 38 of 822 correct rides.

Do **not** reintroduce a ratio-of-straight-line rule per leg. Purple's West
Campus out-and-back legitimately doubles back; that rule scored it 72.8%
on-street and drew a chord across the water.

### Derived route paths (`src/network/derivePath.ts`)

Rebuilds a route's loop from `raw_positions`. **Not served to riders**: the
payload sends the operator's published `path` byte-for-byte (verified identical
to `routes_routes.php` for every route, and to every stop's coordinates and
sequence), so the map matches yale.downtownerapp.com exactly. Serving derived
geometry is opt-in via `SHUTTLE_SERVE_DERIVED_PATHS=1`, kept as a safety net
for a route whose published line becomes untraceable — under the current
acceptance rules that is 2 of 15 routes (Pink, Green), each with one leg the
published line cannot supply. Acceptance requires halving the undrawable-leg
count plus a deadhead gate (Blue Night's buses drive a 2.1 km relief run
hourly, 996 m off route, past no stops; both buses agree to 1 m, so cross-bus
agreement cannot catch it).

`node scripts/derived-path-check.mjs` grades the swap against production for
all 15 routes and exits non-zero on a genuine defect; run it after touching any
of this.

## Data-quality invariants

These are load-bearing; several rider-visible bugs traced to them:

- **`bus_id` is NOT a stable vehicle id.** TransLoc reissues it per service
  block (~1,000 ids for 50 buses in 30 days, median lifetime 5.9 h). `bus_name`
  (`#40`) is the identity. The detector keys on the name, qualified by id only
  while two ids report the same name in one poll — which genuinely happens.
  Naive name-keying is *worse* than the bug: every multi-minute feed gap
  coincides with a reissue, so it bills a layover as travel time.
- **Stops that are metres apart can be many stops apart in sequence.**
  College/Wall (S)/(N) are 28 m apart at sequence positions 18 and 28;
  Orange/Pearl (N)/(S) are 35 m but 9 apart. `at_stop_id` therefore *refines*
  the GPS anchor and must never override it.
- **Segment samples are filtered for physical plausibility before any
  statistic** (including the median — on long hops the bad samples were the
  majority). Without it the planner priced an 8.4 km ride at 97 seconds.
- **Routes 9 and 10 repeat stops** for the West Campus out-and-back. Keep the
  sequence verbatim and index by position; de-duplicating loses real legs.

## Verification harnesses

Beyond `npm test`, in `services/shuttle-v2/scripts/` (all
`BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/<name>.mjs`):

| script | asserts |
|---|---|
| `gps-tier-check.mjs` | one live high-accuracy geolocation watch, no downgrade |
| `timezone-check.mjs` | identical service state across 5 device timezones |
| `walk-fallback-check.mjs` | a long trip shows a walk, never "No trip options found" |
| `eta-accuracy.mjs` | scores the ETA riders see against real observed arrivals |
| `map-bot.mjs` / `map-bot-visual.mjs` | random trip vs `/api/plan`; browser capture |

`eta-accuracy.mjs` is the honest one: it reads what the app tells a rider while
independently watching raw positions for the actual arrival. Last measured
median error **1.26 min**, 71% within 2 min, with a known optimistic bias on the
*wait* leg of 20–25% of the remaining time (unfixed — the ride-time estimator
itself is unbiased).

## Don'ts

- **Don't deploy from the repo root.** The only live config is `services/shuttle-v2/fly.toml` (app `yale-shuttle`). `fly.v1-archived.toml` at the root is the retired v1 config — leave it dead.
- **Don't touch `/data/shuttle.db`** on the volume — that's v1's archived history.
- **`npx vite build` compiles but does NOT type-check** — esbuild strips types. A `ReferenceError` (state used in a child component without threading the prop) shipped to production this way on 2026-09-01 and crashed the app for riders. `npm run typecheck` now runs `tsc` over `web/` too; run it before any frontend deploy. (Note: TS's flow analysis gives up inside the 6.8k-line `TransitMap.tsx` component — guards there sometimes need explicit assertions.)
- **Don't hand-edit route stop lists or path polylines.** They come from TransLoc upstream.
- **Don't commit unless the user asks.** The host handles source control. (`services/shuttle-v2/` has been git-tracked since June 2026 — history exists now.)
- `services/shuttle-collector/` and `services/shuttle-map/` are the archived v1 stack — don't modify or deploy them.

## Useful probes

```bash
# NOTE: jq is NOT installed on this Pi — parse with node instead.
curl -s https://yale-shuttle.fly.dev/api/buses | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).buses[0]))"
~/.fly/bin/flyctl ssh console -a yale-shuttle -C "ls -la /data"

# Read the production DB read-only (flyctl mangles quotes; pipe a file to stdin):
printf '<js>' | ~/.fly/bin/flyctl ssh console -a yale-shuttle -C "node -"
#   require("/app/node_modules/better-sqlite3") on "/data/shuttle-v2.db", {readonly:true}
```

Visual checks of the live site DO work on this Pi via Playwright driving system chromium over CDP (only the legacy `chromium --screenshot` one-shot CLI hangs). Recipe: `npm i playwright-core`, launch with `executablePath: "/usr/bin/chromium"` + `--no-sandbox --disable-gpu --disable-dev-shm-usage`, `goto(url, {waitUntil: "domcontentloaded"})`. Working end-to-end example: `services/shuttle-v2/scripts/map-bot-visual.mjs` (run with `BOT_CHROMIUM_PATH=/usr/bin/chromium`) — picks a random trip, sets geolocation as the origin, screenshots the plan + the Leaflet map with bus markers, and watches a bus approach. The companion `scripts/map-bot.mjs` is a headless data-level check (random trip → `/api/plan` ground truth). For a pure JS-crash repro without any browser, the jsdom harness still works — see the memory note on environment quirks.
