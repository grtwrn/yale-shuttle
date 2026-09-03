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
npm test             # vitest — ~1070 tests, covers src/ AND web/src/
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

**There is no All tab.** The route cards live under the map on the Map tab
(operator, 2026-09-02): the map answers "where is everything" and the cards
answer "when does my line reach my stop", which is one page, not two. A
rider whose stored tab was `all` is migrated to `map` on load. `StopList`
still takes `listView="all"` internally — that is the card-list mode, not a
tab. With every line switched off the map keeps a basemap centred on New
Haven rather than rendering a grey void.

The Map tab filters by line (`web/src/mapFilter.ts`): a scrolling chip row
above the map toggles each route, and the choice is remembered in
localStorage as the HIDDEN toggle labels — so a route added upstream appears
by default rather than staying invisible. It is deliberately separate state
from `hiddenRoutes`, which every view change resets (that reset exists so the
favourites filter cannot leak into the All page, and it would wipe the map's
filter on every tab switch). Every storage touch is guarded; blocked storage
means the filter simply does not persist.

The forecast has TWO sources (`src/server/weather.ts`): Open-Meteo first,
then the National Weather Service (`api.weather.gov`, no key). Open-Meteo's
free tier sheds load — on 2026-09-02 it returned 503 "The service is
overloaded" to the production machine for minutes, and a restart in that
window left riders with no weather at all — then recovered on its own. It is
not blocking our address; the fallback simply makes the next such spell
invisible. NWS carries no condition code, so the line degrades to temperature
plus rain chance with a neutral icon. Both providers share ONE timeout budget
per refresh, or a cold request would wait 5 s twice.

The weather line answers ONE question — when will it next rain — in as few
words as fit one phone line: "66°F · rain likely 11pm (70%)". It drops the
condition word ("Clear") whenever it has an hour to name, because the hour is
the useful half.

**Where the temperature is HEADING rides in the SAME sentence**, spelled out
("warming to 80° by 2pm" / "cooling to 57° by 2pm") rather than an arrow —
"↑80°" read live as "up 80 degrees" (a delta) rather than a destination, and a
separate row under the sentence read as two facts when it is one. The extreme
further from the current temperature wins, drawn from the hours the strip
lists — not the calendar day, most of which a rider has already lived
through. Showing both ends was the first cut and the operator cut it down
(2026-09-03): at 9am on a warming day the low is the temperature you are
already standing in.

**The line carries BOTH facts at once** — the chance of rain and the
temperature trend ("69°F · 35% rain · warming to 80°"). An earlier cut showed
the trend only when there was no rain to report, which meant the two things
the operator asked for were never on screen together. To fit at 390px,
`rainFragment` has a TERSE form used only when the trend is beside it ("35%
rain" rather than "35% chance of rain within the hour"), and the trend drops
its hour ("by 2pm") whenever rain needs more than a bare percentage —
`trendHourFits` is the one place that decides. Rain arriving later in the
window still outranks a sub-20% near-term number, so "rain 9pm (70%)" is what
a quiet-now-wet-later evening says. Inside the sentence they wrapped it: that
shipped on 2026-09-03 and was caught on production, so measure the LONGEST
branch (dry-with-condition, and the ≥70% umbrella one) at 390px before
touching this line, not the shortest. The ≥70% branch still takes two rows by
choice — it is the amber warning and the second row carries the advice. Tapping it opens the next six hours as a sideways-scrolling
strip of temperature and rain chance, each percentage carrying a 💧 so it is
not read as anything else; that strip is collapsed by default, since the
sentence usually suffices. Hours are spelled `11pm`, not the app's usual
`11p` — a bare letter beside a temperature and a percentage was one
abbreviation too many. The server asks upstream for ten hours, so an
afternoon system is visible before lunchtime.

**Every branch names an hour, including the near one** (report #83: "it
should tell what time rain is expected"). The near-term half used to print a
bare percentage, so the line answered "how likely" and never "when" — the one
question it exists for. `rainLikely` now records WHICH bucket the peak came
from, and the wording follows honestly: a bucket the rider is already inside
is named by its END ("rain by 7pm"), because naming its start would say the
rain is happening now, and a bucket still ahead is named by its start ("rain
6pm").

**Three facts do not fit one line, and the measurement decides which gives.**
Measured in the real line box at 390 px (238 px of room quiet, 236 px
warning), by probing the rendered span — not by counting characters, which is
how a wrapping line shipped on 2026-09-03. With the hour named, the
temperature trend prints its DIRECTION only ("· cooling"): the full clause
made the widest line 267 px. Past the umbrella threshold the trend goes
entirely (298 px with it) and the percentage goes with it, leaving "100°F ·
rain by 12am — umbrella" at 200 px; "take an umbrella" beside an hour is
249 px and does not fit at all. The quiet, no-rain branch keeps the whole
"warming to 80° by 8pm" — it was written for that branch and still fits there
at 237 px. `weather.test.ts` pins the widest string each branch can produce,
with those measurements in the comments; re-measure if you reword.

**Temperature shows ONE unit, the rider's** — a `°F | °C` toggle sits at the
right of the line and persists in `localStorage` (`shuttle.tempUnit`, read
through `loadTempUnit()` which never throws). Printing "68°F (20°C)" spent a
third of the line saying the same thing twice. The toggle is a SIBLING of the
line's expand button, not nested inside it: a button within a button is
invalid HTML and iOS ignores the inner one.

The weather line above the trip options is ALWAYS shown when a forecast
exists (`web/src/weather.ts`), quiet by default and amber past 70%. It was
rain-only and hidden below 50%, which meant nobody learned to look for it. It
never reorders or hides an option — a shuttle is not faster in the rain, only
drier at the ends. Temperature and the WMO code are optional all the way
through, so an upstream that stops sending them degrades to the rain-only
wording rather than to no line.

**The line says "within the hour", never "now".** `probability` is the PEAK
across every bucket overlapping the next hour, so "raining now" would fire up
to 55 minutes early on a dry evening. For the same reason the number is quoted
without an adjective — 45% is neither likely nor unlikely — and only the
umbrella clause changes at 70%, so no wording flips at the boundary.
A near-term chance always outranks the later hour: a rider with 45% in the
next hour must not be told about nine o'clock instead. A wet WMO code with a
low hourly chance prints the condition alone ("55°F · Rain"), never "Rain ·
no rain expected".

**The option row's top line is total · live bus · arrival** — "12 min · 🚌 in
<1, 14 min · arrive 10:16a". The bus times moved up from a third line
(operator, 2026-09-03) because that is the number deciding whether you leave
now, and the card is two lines instead of three for it. The two ETAs share
one unit via `fmtBusPair` ("in 12, 21 min", the operator's own wording): "in
12 min · next in 21 min" clipped mid-number at 390px, and both times now fit
at every ETA. The bus ETA is computed ONCE at row scope (`busEtaLive`) and
consumed by both the top line and the departed warning, so they cannot
disagree.

**Reload lives beside the tabs** (right of Issues) and is always rendered,
including on the ride page where the tabs themselves are hidden. It used to be
installed-app-only AND post-search-only, which is exactly the state a stuck app
never reaches. The pull-to-refresh gesture (`web/src/pullToRefresh.ts`) still
works; the button is the one riders find.

**The expanded map has Back at top-left as well as ✕ at top-right**, and
Escape closes it. Leaflet's zoom control shares that corner, so the wrapper
takes a `map-fs` class in fullscreen and the stylesheet drops the control
below the button.

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
throughout (`feedback-bot-prompt.md`). **A bot PR is filed against the report the bot names in `pr-report-id`**, not
the first id arbitration handed it — the wrapper used to assume those were the
same, and two PRs went out branded the wrong report (a geolocation fix labelled
as an ETA complaint, a Celsius change labelled as the geolocation one). Since
the `[fixed]` follow-up keys on the branch name, that would have closed an
urgent report with someone else's work. The claimed id is honoured only if it
is in the arbitrated set.

**Every bot PR carries a screenshot**:
the wrapper stages the PR's own build on :8096, runs `scripts/pr-preview.mjs`
(phone-sized headless chromium; the bot's `pr-preview.json` recipe mocks the
API responses that make the feature visible, e.g. a rainy forecast), commits
the PNGs under `pr-preview/<id>/` on the PR branch and embeds them in the PR
body. **A view that never opened is a failed preview**: the harness records it
in `preview.json`, exits non-zero, and its `*-failed.png` is never embedded —
a PR with no usable screenshot opens as a DRAFT saying so, because one shipped
with a screenshot of its own failure and the operator had to catch it — the user's ask (2026-09-02): "for any pr, can we get a screenshot of the
feature to see it before approving?". To preview any branch by hand: build
`web/`, run the server on a spare port with a throwaway `SHUTTLE_V2_DB`, then
`BASE=http://127.0.0.1:<port> RECIPE=recipe.json OUT=/tmp/shots node
scripts/pr-preview.mjs`. Riders see everything in the in-app
Issues tab (`/api/my-reports`): statuses, notes (which are replies to them),
follow-ups (these reopen + wake the bot), archive, and self-rated priority.

## Destination lookup (`/api/geocode`)

Three layers, local first, and the response shape is v1's
(`{results:[{display_name,lat,lon,type,class}]}`; the frontend auto-picks on
class `yale`, type `bus_stop`/`house`, or a single result — keep those values):

1. **Curated landmarks** — `src/server/landmarks.ts`, 148 entries, every one
   VERIFIED against OpenStreetMap on 2026-09-02 and pinned to the live stop
   that serves it (`anchorStop`). `geocode.test.ts` recomputes the nearest
   stop from the checked-in 172-stop fixture (`src/server/__fixtures__/stops.json`)
   for every entry, so a moved or mistyped coordinate fails the suite. **To add
   a place: look it up in OSM, copy the coordinate, set its anchor** — the
   2026-08-31 audit found seven of fourteen hand-typed entries wrong, one by
   1.2 km, and the 2026-09-02 audit moved five more. One entry per physical
   place; other names go in `aliases` ("kbt", "commons", "med school", the
   former name, the street address) — no misspellings, the fuzzy tier handles
   those. Adjacent-but-distinct places (a cafe inside a museum) stay separate.
2. **The matcher** (`src/server/geocode.ts`) normalises both sides (apostrophes
   deleted, `&` → "and", diacritics stripped), drops query stopwords (yale,
   university, the, at, of, on, in, and, new, haven, st, street) and scores in
   tiers: exact > prefix > word-prefix > every-token-prefixes > fuzzy
   (Damerau-Levenshtein ≤ 1 from 5 letters, ≤ 2 from 8, never shorter — "som"
   must not become "some") > substring. Aliases score exactly like labels.
   Stop names come from upstream and may NOT be hand-edited even when misspelt
   ("Orange / Audobon"); the fuzzy tier is how "audubon" reaches them. Dedup:
   a landmark on its serving stop replaces the stop row; two stops on one
   corner collapse to one; two landmarks never merge. Each entry also carries
   a `poi` category in OSM's own vocabulary ("pizza", "ice_cream", "library"),
   served in the v1 `type` field, which is what `suggIcon` (web/src/format.ts)
   turns into the row's emoji — one table for curated places and OSM results
   alike. A new landmark without a `poi` fails the suite.
3. **External** — ALWAYS asked (over 2 characters), and filtered twice.
   Photon (komoot) first — it tolerates a missing apostrophe and typos, which
   Nominatim does not ("elenas" returned nothing until 2026-09-02) — then
   Nominatim only when Photon errors or is empty. One shared 1.1 s throttle,
   one 2.5 s budget per lookup, cache keyed by provider+query, in-flight
   collapse. External hits keep the provider's order (a distance sort put a
   street centreline ahead of the house the rider typed). The fetcher is
   injected (`buildApp({ geocoder })`), so tests stub it; nothing in the suite
   touches the network. The two filters:

   - **Reach** — `EXTERNAL_REACH_M` is 1500 m, and a test pins it equal to the
     planner's `MAX_WALK_M` (`web/src/walk.ts`): past the walking limit no
     shuttle trip can be planned to the place at all. A hit beyond it is
     dropped only when a nearer one exists, so a genuinely distant query still
     answers. This is what removes Pepe's Lawn Care (1,971 m) and Pepes Farm
     Road (2,224 m) from "pepes".
   - **Name relevance** — a hit whose name scores 0 against the query under
     `relevanceOf` (the same matcher the curated list uses, weakest tier) is
     dropped. Photon returned EbLens, a shoe shop 290 m from Elm / Lynwood,
     for "elenas"; it is perfectly reachable, so only the name can rule it out.

   **Do not replace these with "skip the external lookup when a local hit is
   strong".** That shipped for a day and an adversarial review killed it: a
   curated place then hides every real alternative — "police" and even "new
   haven police" answered only the Yale Police office and buried the New Haven
   Police Department, and "cvs"/"walgreens"/"hospital" went the same way.

   **"trader joes" legitimately returns two stores.** The Hamden one is 286 m
   from the Aldi/Walmart stop that route 18 serves — a shorter walk than many
   curated places — so it is a real destination, not noise. A draft that
   claimed the reach rule dropped it was measuring an invented coordinate
   (1,590 m); Photon's node is at 41.37523, -72.91366. Every geocode fixture
   in `v1compat.geocode.test.ts` is now Photon's real answer, coordinates
   included, precisely so a green test cannot disagree with the live server
   again.

The frontend's 8 km radius filter exempts class `yale`/`shuttle` rows — a
curated destination is by definition reachable, and Trader Joe's (Milford) at
9.8 km used to vanish whenever an unrelated in-range OSM hit came back too.

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

**The statistics count from a fixed epoch**, `DEFAULT_STATS_SINCE_DAY` in
`src/server/actives.ts` (2026-08-31, the Monday of launch week; override with
`SHUTTLE_STATS_SINCE_DAY`, or `statsSinceDay` on `buildApp` — the app tests
freeze the clock in 2023 and set their own). Rows before it are stored but not
counted, and — this is the point — a browser seen only before the epoch does
not make its owner's first real visit read as "returning". The floor lives in
the shared `notExcluded` fragment beside the flagged-id filter, so a new
statistic cannot forget it. `/api/stats` returns the epoch as `since`, which
the dashboard prints under the hero ("counting from Mon Aug 31").

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

**The dashboard answers two more questions** (2026-09-03):

- **"Has anyone but me written in?"** — `GET /api/stats/reports` lists reports
  that are NOT from the operator's own browsers and not the map-bot's own
  filings, newest first, with an unread badge the page keeps in localStorage.
  It matters because 60 of the first 69 reports were the operator's own
  testing and the ONE report from a real outside rider had to be found by
  hand. Operator browsers live in `operator_anon_ids` — deliberately NOT
  `excluded_anon_ids`, because the operator's phone is a real rider and must
  keep counting in the usage numbers. Seed it with the `SHUTTLE_OPERATOR_ANON_IDS`
  secret (comma-separated) or `POST /api/stats/operator {anonId}`. A report
  with no anon id counts as OUTSIDE: storage may simply have been blocked, and
  a false "someone wrote in" is cheaper than missing the one person who did.
  **The payload carries no IP, no anon id and no context** — this route is
  reachable with the stats cookie, so its shape is the security boundary.
- **"When is it used?"** — `GET /api/stats/hourly` gives 24 counts per day,
  one line per day on the page. It is DERIVED from the first/last sighting
  already stored per (day, browser): nothing new is collected, and it reads
  back to launch. A browser counts in every hour of its span, so this is an
  upper bound on "present at that moment". Today's line stops at the current
  hour — future hours are not zeroes.

**Search terms are recorded, riders are not** (`src/server/searchTerms.ts`,
2026-09-03). `GET /api/stats/searches` answers the two questions that used to
cost a rider report each: which searches find NOTHING (a place to add —
"one6three" and "ice rink" were both found that way, one report at a time),
and which are common enough that their matching is worth tuning. The /stats
page shows both lists; the not-found one is the one that turns into work.

**The privacy shape is why this table is allowed to exist.** A destination is
the most revealing thing this app handles, so a row is keyed by (ET day,
normalised query) and holds counts: no anon id, no IP, no user agent, no time
of day, no session. Two searches by one rider and one search by two riders are
the same row, and nothing in it can reconstruct a person's movements — a
stricter promise than `daily_actives` keeps, and it should stay stricter.
A test asserts the column set so a future column has to argue with it.
Swept at 30 days rather than 90: a month is long enough to spot a gap.

Two details that make the data usable rather than noise: the lookup fires on a
debounce as a rider types, so `collapsePrefixes` drops any term that is a
strict prefix of a longer one ("one6", "one6t" → "one6three"); and a term
counts as missing only when it NEVER found anything, since one miss on a term
that usually works is a flaky upstream, not a gap. Counts are ADDED on flush,
never replaced — the mistake `daily_actives` made, which lost a day's tally on
every deploy.

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
- **The feed repeats a position rather than interpolating**: 53.6% of
  consecutive samples are identical coordinates (runs of 15 s typically, up to
  28 min). Anything derived from consecutive positions must account for it —
  naive speed reads 0 mph on 54% of samples and calls a *moving* bus stopped
  on 21% of them. Measured 2026-09-02; see `docs/bus-speed.md`, which also
  records why a Kalman filter is not the answer.

## ETA accuracy: measure with the replay, not by eye

`docs/eta-accuracy.md` records the 2026-09-02 replay of the exact client
arithmetic against three months of arrivals and 69k raw positions
(`scripts/eta-replay/`, README there — take a snapshot of the production DB
and run both scripts; a few minutes each). Findings that constrain changes:

- **Calibration is at its floor.** 28 variants (window shape, shrinkage k,
  medians, recency, recent traffic, live pace, route drift) moved the median by
  at most −1.9 s. Don't retune `calibrator.ts` without a replay showing more.
- **A dwell statistic is NOT the standing-still part of a hop.** `detector.ts`
  computes one `elapsedSec` per transition and emits it as *both*
  `DwellEvent.dwellSec` and `SegmentEvent.travelSec` — over 30 days, 119,329 of
  119,329 joined rows are identical. So `seg.avg - dwells[from].med` is not
  "the drive", it is two estimators of the same quantity disagreeing, and the
  dwell median exceeds the whole segment average on 41.2% of hops. **This
  sentence has caused two shipped changes**; read WHAT A DWELL STATISTIC
  ACTUALLY MEASURES in `web/src/arrivals.ts` before touching either.
- **Pricing an unstarted rest at p35 was shipped and reverted on 2026-09-03.**
  It surcharged 77% of hops instead of discounting them (the floor), costing
  9.2 s of median error and 2 points more pessimism over 262,762 replayed
  pairs. `DwellStats.low` is still served and is deliberately dormant.
- **Stall credit is bounded by the calibrated dwell**, with
  `STALL_CREDIT_MAX_FRACTION` as the fallback where there is none. Subtracting
  every elapsed second promised a bus that had sat 5 min at the next stop
  3.4 min early; half the hop then broke the Red layover. The bound is
  empirical, not a decomposition — do not re-derive it from the old story, and
  `npm run test:accuracy` gates it.
- **A bus's holding so far does not predict its holding ahead** (58,005
  windows): correlation −0.03, and −0.09 once you control for which stops are
  ahead. A perfect oracle would be worth 4.2 s. Not built.
- **The anchor is the next lever**: where `findRouteAnchor` disagrees with the
  detector (13.4% of positions, concentrated on Green/Purple/Orange East/Pink)
  the median error is 367 s vs 99 s. A perfect anchor would take the median to
  103 s and the mean bias to +2 s.
- **Own-bus "live pace" (report #64) is measurably worse** (+18.5 s median).
  Not built; the numbers are in the doc.
- `predictions_log` is empty — nothing records what riders were told. The
  replay is the substitute; the live browser harness
  (`scripts/eta-accuracy.mjs`, now parametrised by `BOARD_ID`/`DEST_ID`/
  `ROUTES`/`ROUTE_LABEL`) scores ~10 pairs a run and only the option it can
  see, so it is a sanity check, not a measurement.

### The accuracy gate: a recorded pass, before/during/after a dwell

Any change to an arrival time is replayed against a REAL bus pass before it
merges: `web/src/accuracy-layover.test.ts` walks
`web/src/__fixtures__/red-layover-pass.json` — Red #309 approaching the
344 Winchester layover, sitting through 9 min 45 s of it, and driving on —
and asks what the board would have shown a rider at Division/Prospect and
Prospect/Hillside at each of 115 recorded moments, against when the bus
actually arrived. `npm run test:accuracy`, and `.github/workflows/accuracy.yml`
runs it on every PR touching the estimator (it is in `npm test` too, so the
deploy gate catches it either way).

It exists because unit tests did not catch the 2026-09-03 defect: each of them
pinned one contrived moment, and the failure only appears in a bus MOVING
THROUGH a dwell. The invariants are loose about accuracy and strict about the
two things that hurt riders — a bus promised LATER than it comes (they walk
down and it has gone: the gate fails past 120 s) and a countdown that LURCHES
between polls (they cannot tell whether to run: past 180 s). Reverting the
estimator to the shipped-yesterday rule fails three of them by name, quoting
the moment and both numbers.

**Do not loosen a bound or re-record the fixture to make a change pass.**
Regenerate it (`node scripts/record-layover-pass.mjs`) only when the route
changes shape, and say in the PR what moved.

## Investigations that did not become code

- `docs/bus-speed.md` — showing a bus's speed (rider report #63). A 30 s
  trailing window beats a constant-velocity Kalman filter on this feed, and
  the number is only informative about two minutes ahead, so it must never
  feed the ETA. Not built; read it before building it.

## Verification harnesses

Beyond `npm test`, in `services/shuttle-v2/scripts/` (all
`BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/<name>.mjs`):

| script | asserts |
|---|---|
| `gps-tier-check.mjs` | one live high-accuracy geolocation watch, no downgrade |
| `timezone-check.mjs` | identical service state across 5 device timezones |
| `walk-fallback-check.mjs` | a long trip shows a walk, never "No trip options found" |
| `eta-accuracy.mjs` | scores the ETA riders see against real observed arrivals (live, ~10 pairs a run) |
| `eta-replay/` | offline replay of the ETA arithmetic against a DB snapshot: 100k–450k pairs, time-travelled calibration, anchor/stall/proration variants |
| `map-bot.mjs` / `map-bot-visual.mjs` | random trip vs `/api/plan`; browser capture |

`eta-accuracy.mjs` reads what the app tells a rider while independently
watching raw positions for the actual arrival. Last daytime measurement
(Blue Day): median error **1.26 min**, 71% within 2 min, wait leg 20–25%
optimistic — the replay traced that optimism to the uncapped stall credit,
now fixed. It scores only what the page shows, so it needs the route under
test visible (it now expands "Show N more routes") and a bus that actually
visits the board stop: on 2026-09-02 a 50-min Blue Night run scored zero pairs
because #38 passed Peabody 297 m away on Whitney and never stopped, while the
app counted down "3 min" to it and the detector still logged an arrival there
(no distance gate on arrivals). The offline replay is the measurement; this is
the sanity check.

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
