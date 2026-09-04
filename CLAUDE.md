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

**The temperature TREND was removed on 2026-09-04** (reports #90 and #97)
and must not come back in any wording. The line carried "· cooling to 69° by
8pm" beside the rain half; the operator asked for it on 2026-09-03, rode with
it for a day, and then filed twice — "I don't need to know when its cooling",
and then "Maybe shouldn't say cooling. It's staying hot for the afternoon".
The second one is the real defect: the clause names the extreme of the whole
TEN-HOUR window, so at 11:21am on a 77° day the line said "cooling to 69° by
8pm" directly above a strip reading 78° at noon, 1pm and 2pm. It was true of
the evening and read as the afternoon. **A magnitude floor does not fix that**
— a big evening swing is exactly the case it gets wrong — and neither does a
different verb; the hours themselves are one tap away in the strip, which is
where a rider asking about the afternoon should look. `tempTrend`,
`trendText`, `trendHourFits` and the strip's ↑/↓ markers went with it, and
`rainFragment` lost the TERSE form that existed only to make room for the
clause. A test named for #97 pins the reported line.

The line is back to two facts, so it fits with room to spare: the widest
quiet branch is the dry one with a condition word ("100°F · Cloudy · no rain
expected") and the widest warning is "100°F · rain by 12am — umbrella" at
200 px of 236. Measure at 390px by probing the rendered span if you reword —
counting characters is how a wrapping line shipped on 2026-09-03 — and
`weather.test.ts` pins the widest string each branch can produce.

Tapping the line opens the next six hours as a sideways-scrolling
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

**The option row is TWO COLUMNS, each read top-down** (operator, 2026-09-04)
— the line and what it is made of on the left, the two clock facts on the
right, and a chevron centred across both:

    [Blue Day]  in 3, 21 min                            23 min
    🚶 5 min › 🚌 12 min › 🚶 3 min · most direct   arrive 10:33a   ›

The total used to hold the top-left slot with the pill a row below it, so
picking "the Blue one" off five cards meant reading five durations first.
The arrival clock then led line 2, which put the two numbers a rider compares
ACROSS cards — "23 min" and "arrive 10:33a" — on opposite sides of the card,
never lining up; the operator asked for the swap ("i want the arrive at time
under the trip length and put the route info under the line name on the
left"). Both right-hand figures are `flexShrink: 0` and never wrap: **future
mode prints a RANGE there** ("1:22p – 1:48p"), and if anything has to give it
is the leg list on the left, which merely runs onto a second line. Measured at
390 px it does not have to — the widest real card, a Brown with both walks
and a ride, fits the range on one line.

**The chevron is the third column, not the end of line 2** — that slot is the
arrival clock now. It is decoration: the whole card carries the `onClick`, so
the tap target is the full row, and the glyph still gets 44 px of height.

Still two lines at 390px: the walk legs share the second line with the clock
rather than keeping a row, and the ride between them is timed in the same ink
as the walks instead of a second copy of the pill (colour off the option, i.e.
off `ROUTE_LISTS`). The bus times themselves had moved up from a third line
the day before, because that is the number deciding whether you leave now.
The two ETAs share one unit via `fmtBusPair` ("in 12, 21 min", the operator's
own wording): "in 12 min · next in 21 min" clipped mid-number at 390px, and
both times now fit at every ETA. The bus ETA is computed ONCE at row scope
(`busEtaLive`) and consumed by both the top line and the departed warning, so
they cannot disagree.

**No leg is guaranteed EXCEPT the ride.** A walk of 0 s is omitted, the ⏳
wait line only appears when no live bus is pinned (future mode), and a
Departed card has no arrival clock at all — the row is built from whatever
exists, never from a fixed slot per leg. But every collapsed shuttle row draws
`🚌 {rideSec}`: `legsShown` is `!isExpanded && o.mode === "shuttle"` and
nothing more. Gating the block on "a walk at one end or the other" left a
rider already at the stop, bound for a stop on the line, with a blank second
line — the one card on screen that did not say what the trip was made of.
That card also puts a bare `🚌 N min` directly under a duration, which is
where a countdown used to live: `parseBusEtaText` is the arbiter and the ride
bar has no "in", and the countdown is found in `pre` first regardless.

**The canary reads these cards as TEXT** (`parseOptions` in
`scripts/canary-metrics.mjs`), so a layout change is a parser change: it
anchors on the duration line and walks back one countdown and one pill, since
those now precede it, and prefers a pill found below (the old order) so the
harness can watch production while a redesign is unmerged. It reads a card as
a SET of lines around that anchor rather than an ordered one, which is why
moving the arrival clock below the legs cost it nothing — but #111 "needed no
change" too and blinded the canary for twelve minutes, so **every layout
change lands a captured-innerText fixture in `canary-metrics.test.mjs`**
(`LIVE_LINE_FIRST`, `LIVE_NO_GLYPH`, `LIVE_ARRIVAL_RIGHT`) rather than an
argument that the parser is fine. It also stops the
last card at the page footer — "Contribute" is exactly as label-shaped as a
route name.

**A live ride ends only on evidence** (`web/src/rideEnd.ts`). Three triggers
retire the "I'm on it" page — a 2 h age cap, the pinned bus gone from the feed
for 10 min, and the rider ≥300 m from that bus for 3 consecutive checks — and
the third one used to fire on a rider who had not moved at all. Report #96
(2026-09-04): "I was riding a bus, submitted feedback and then lost my live
ride." The two positions it compares are not measured at the same time:
`/api/buses` keeps polling while the page is hidden (30 s) but the geolocation
watch is deliberately torn down on `visibilitychange`, so the rider's fix
FREEZES while the bus's keeps arriving. Composing feedback is exactly that
minute — 📎 Attach screenshot hands the page to the OS picker outright — and a
shuttle clears 300 m in under a minute, so three polls retired the ride and
`saveBoardedRide(null)` deleted its localStorage copy too. **A strike now
needs both positions current**: no fresh fix (`FIX_MAX_AGE_MS`, 60 s, measured
from the browser's own `position.timestamp` so the rescue one-shot's
two-minute-old fix cannot pass as live), or a hidden page, resets the streak
rather than adding to it, and a poll the bus is missing from no longer carries
strikes forward. The asymmetry is deliberate: keeping a finished ride a few
minutes too long costs battery, ending a live one costs the rider the thing
they opened the app for. The decision is pure and unit-tested because
`TransitMap` itself cannot be rendered by this repo's harness.

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
   **What is missing is measured, not guessed**: `node scripts/lookup-sweep.mjs`
   runs every named Yale/campus place OSM knows about through all three layers
   and lists the ones NO layer answers — 5 as of 2026-09-03, not the 213 that
   scoring against this list alone appeared to show (see Verification
   harnesses).
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
- **`arrivals.dwell_sec` is NOT standing time — it is anchor residence time.**
  `detector.ts` computes one `elapsedSec` per anchor transition and emits it
  as BOTH the dwell event and the segment event, so `arrivals.dwell_sec` and
  `segments.travel_sec` are the same number (97.6% byte-identical over 29,179
  joined rows). Joining the two tables to split dwell from drive returns
  "drive = 0, dwell = 100%", which is arithmetically correct and meaningless.
  The split exists only in `raw_positions` (6 h retention). PR #40 rested on
  the opposite premise and was reverted. See `docs/eta-error-budget.md`.
- **The feed has a ~30 m position deadband.** Upstream sends a new coordinate
  only once the bus has moved ~30 m: 2 of 33,118 distinct fixes moved under
  28 m, and the floor is 30.0 m at Δt = 5 s, 6–10 s and 11–20 s — constant in
  metres, not in speed. So a repeated fix is a *censored observation*
  (|Δx| < 30 m, an upper bound on speed), not noise and not missing data. It
  also puts the velocity quantum at 6 m/s ≈ 13 mph, which is why acceleration
  and inertia are not estimable from this feed at all.
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
- **On an out-and-back, direction of travel picks the branch — and only for a
  bus that is moving.** Green and Purple run out to West Campus and back along
  the same road, so the same coordinates belong to two legs at once; neither
  distance nor `last_stop_id` can separate them (a Green bus on I-95 sat 135 m
  from the outbound chord and 139 m from the inbound one with `last_stop_id`
  frozen for a 5 km run). `findRouteAnchor` now takes the previous DISTINCT fix
  (`noteFix` in `anchorGate.ts` remembers it on the same store the gate uses)
  and drops any candidate leg more than 127° against the step. Strand share on
  the rider simulator: Green 32.3 → 27.4%, Purple 29.5 → 27.1%, Red unchanged
  at 18.0 → 18.2%. **Do not loosen the 127°** — at 90° it helps a branch-lock
  index count on every route and makes riders worse on Purple and Red, because
  most of their ambiguity sits within 100 m of a stop where a "step" is a bus
  shuffling at a kerb. And **do not let direction release the anchor gate**:
  measured, Green improves and Purple ends up worse than master. What is left
  is the stationary half of the ambiguity, which no geometry can settle —
  42.8% of Purple's ambiguous polls, 23.2% of Green's; it is the estimator
  rewrite's job. `scripts/eta-replay/branch-lock.ts` scores the mechanism.
- **Own-bus "live pace" (report #64) is measurably worse** (+18.5 s median).
  Not built; the numbers are in the doc.
- `predictions_log` now HAS a writer (see "What riders were told" below). Until
  it does in production, the replay is still the substitute; the live browser
  harness (`scripts/eta-accuracy.mjs`, parametrised by `BOARD_ID`/`DEST_ID`/
  `ROUTES`/`ROUTE_LABEL`) scores ~10 pairs a run and only the option it can
  see, so it is a sanity check, not a measurement.

### What riders were told (`predictions_log`, `docs/prediction-log.md`)

Every accuracy and stability figure here used to be a RECONSTRUCTION — replay
the arithmetic over stored positions and assert that is what the screen said.
That has been wrong expensively: a family of stability numbers turned out to
have been measured against a client that had not shipped since March, and a
hotfix's before/after was credited to the wrong PR. The ETA is computed in the
BROWSER, so only the browser can say what it displayed; a server-side recompute
would reproduce that failure by construction.

So a sampled share of page loads posts what they showed
(`web/src/shownLog.ts` → `POST /api/shown`), and **every row names the bundle
that produced it** (the content hash out of `/assets/index-<hash>.js`).

**The privacy shape is why this table is allowed to exist, and it is different
from `daily_actives`':** a row is a statement about a BUS — `(bus_name,
route_id, to_stop_id, stops_ahead, predicted_sec, predicted_at, client_build)`
— with **no identity accepted at all**, not even the `x-anon-id` the poll
already carries. Three things hold that:

- **The quantity does not depend on the rider.** `computeUpcomingArrivals`
  prices (bus → stop); the rider's position enters one layer up, in the walk
  legs and `pickLiveArrival`. A row cannot encode a location even indirectly.
- **The server deduplicates before writing.** `(bus_id, to_stop_id,
  predicted_at)` is UNIQUE with `predicted_at` floored to 15 s, so thirty
  riders at one stop in one bucket produce ONE row: a row means "at least one
  client had this on screen", never "a rider was here". Same move bounds the
  write volume by (buses x stops x buckets), not by traffic.
- **The client sends an AGE, not a timestamp.** The server subtracts it from
  its own clock and floors, so a wrong or hostile client clock cannot write a
  row at an instant that never happened — which is what makes the instants
  pairable with an arrival at all.

15 s is the canary's and rider-sim's own cadence, so a logged sequence and a
replayed one line up without resampling. Retention is **30 days**, deliberately
shorter than the 90 of its neighbours (`arrivals` outlives it, so a row is
pairable for as long as it exists), swept by the collector's hourly batched
delete. Cost follows `actives.ts`: nothing writes on a request, a 60 s flush,
`INSERT OR IGNORE`, every path non-throwing.

`POST /api/shown` is a public write and is validated as hostile: the bus must
be live now, the stop must be on that bus's route, ranges checked, per-IP rate
limit, first-writer-wins so a late poster cannot overwrite a bucket.
`SHUTTLE_PREDICTION_SAMPLE=0` is a kill switch that reaches the fleet — the
server's reply carries the live rate, so clients stop within a minute with no
deploy and no extra request.

**The pairing** is the thing nobody could do before: `GET /api/predictions`
(`npm run predictions`) returns each reading beside the arrival that followed
it and the signed error, summarised **by client build**. Admin HEADER only, and
deliberately outside `/api/stats` so the stats cookie's `Path=/api/stats` scope
is untouched. It pairs on `bus_name` (the identity invariant), not `bus_id`.
Use it to check `rider-sim` against reality — the procedure is at the end of
`docs/prediction-log.md`; when the two disagree, the logged row wins.

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

### The stand/drive split is served (2026-09-04)

PR #81's first-hop pricing — `median(stand − r | stand > r) + drive` at the
stop, drive alone prorated en route (`web/src/hopPricing.ts`) — was live and
INERT for a night: `/api/buses` carried neither `dwells[route][stop].q` nor
`segments[route]["A-B"].drive`, so every request took the fallback path. The
calibrator now reads `stop_visits` / `legs` (PR #83's derivation) on its
5-minute cadence and attaches, on the **`at_stop_since` clock** (the client's
`r`), pooled over 30 days — a (stop, hour) cell has a median of two samples:

- `q` / `qn` — ten ascending stand quantiles at levels `(i + 0.5) / 10`
  (`STAND_Q_COUNT` is part of the wire contract) over PINNED visits:
  `departed_at − pinned_at` for a stopped one, **0 s for a pass-through the
  detector pinned**. That zero is deliberate and measured: over stopped visits
  only, the client billed the median stopped stand from the instant `at_stop`
  appeared to riders whose bus was rolling through — Pink 280 → 431 strands,
  Blue Day's Prospect / Huntington +28 in the simulator. `qn` counts both.
- `drive` / `driveN` — the **median** one-hop leg, `at_stop_since(B) −
  departure(A)`; a drive includes any hold at a light, and one red should
  not move the number the way it moves a mean.

Three rules to preserve:

- **Serve what is measured with the true counts; never pre-filter.** The
  client gates (`MIN_STAND_SAMPLES` 20 / `MIN_DRIVE_SAMPLES` 10) and prices a
  thin hop exactly as before. A server-side floor would drift from the
  client's and silently hide cells the client would take.
- **Served only on routes the rider simulator has cleared**
  (`SPLIT_SERVED_ROUTE_IDS`: Red, Blue Day), and never on a route that repeats
  a stop (`foldRoutes`: Green 9, Purple 10 — one stop id cannot carry two
  passes' tables, and the derivation inherits the detector's anchor on the
  folds). The client's sample gate is NOT sufficient: Pink cleared it on 11
  hops and went **280 → 431 strands** (LEPH / 60 College +122). The reason is
  in the arithmetic, not the data — master is *pessimistic* at a layover-ish
  stop (the stall credit is bounded by the dwell, so a rider at LEPH is
  promised ~400 s while the bus stands at York / Cedar) and the conditional
  *median* replaces that with an unbiased number, stranding the half of
  riders whose bus leaves before its median. Red nets a win (1,041 → 769
  strands, jumps ≥180 s 39% → 23%, the Winchester departure-poll rise
  +220 s → +2 s) only because the cliff there was worse; Blue Day's jumps
  fall 25.6% → 8.6% for +9 strands in 6,470. Served everywhere, Purple went
  163 → 188 and Green 165 → 173. **Adding a route means running the pair**
  (`scripts/eta-replay/rider-sim/run.ts`, master vs `PAYLOAD_PATCH`, then
  `--compare`) and pasting its numbers beside the id. The fold exclusion is
  interim, not a finding that the folds cannot be helped: a moving bus
  reveals its branch over two fresh fixes; only a bus stationary on a shared
  segment with no history is undecidable (`docs/eta-estimator-design.md`). A
  lower conditional quantile than the median on the client is the obvious
  next experiment for Pink — measure it there before serving it anywhere.
- **Whole seconds on the wire, and the payload is not compressed in
  production** (`content-encoding` is absent), so the cost is the raw one:
  +3.9 KB per poll (+4.4%) for Red + Blue Day; +12.4 KB (+13.9%) if every
  line were served. Compressing the cached payload string once per version
  would be the real fix; not done.

Validated against `docs/data/departure-tables-2026-09-03.json`: Red 344
Winchester `q` p5/≈p50/p95 = 118/302/598 s over n=24 (reference
118.1/302.8/598.1), drive 15 s over n=25 (reference median 15.1).

**A bus standing still may not push its own arrival later**
(`flooredStandSec`, `web/src/hopPricing.ts`). The conditional median RISES
wherever the stand CDF flattens — on Red's 344 Winchester table it climbs 42 s
across r = 107..168 s and 15 s across r = 456..473 s — so the app was quietly
sliding the predicted arrival later while the bus sat. That is what the
operator caught live on 2026-09-04: #310 parked, the pause chip counting up,
the board frozen on "5 min". Two things it is NOT:

- **It is not the step bug.** PR #99 already replaced the point-sample median
  with the interpolated CDF; the curve is continuous (no single second moves
  it by more than 2.3 s). Continuous is not decreasing, and the rise survived.
- **It is not the slew limiter the operator rejected** ("it can go 5->1 if it
  leaves early. but if it is jitter we need a fix"). A rate limiter damps real
  corrections. A bus standing still produces NO EVENT — the rise is an
  artifact of conditioning on elapsed time, not news arriving. The ceiling is
  consulted only on the standing path and is dropped the instant the bus
  rolls, so the departure collapse is bit-identical to master's.

The ceiling lives per (bus, stop) on the caller's `AnchorStore`, beside
`standingAt`'s memory and the anchor gate's, and resets on a different stop, a
restarted hold clock, a stale entry or the departure. **A storeless caller —
every hypothetical, every pure test — prices exactly as it did before.** The
chip reads the same ceiling through the same key (`shownStandSec`), because
the hold shown must be the hold billed.

Do not monotonise the CDF inside `remainingStandSec` instead: the rise is the
correct conditional median and the estimator's measured bias depends on it
(dropping the elapsed term costs 203 s MAE / +141 s bias).

`web/src/accuracy-layover.test.ts` now replays the recorded Red pass a second
time with the split served (`__fixtures__/red-split-tables.json`, route 3's
own tables from 2026-09-03) and a store open — the first block is storeless
and had no way to see any of this. It pins the defect as a fixture (unclamped,
the board climbs 55 s while the bus stands) as well as the fix.

**Backfill from the archive.** `scripts/backfill-departures.ts` runs the
collector's own reducer over `~/shuttle-captures/positions-*.jsonl` and writes
rows through the collector's own mapping (`src/collector/visitRows.ts`, shared
with `persistVisits`), with a cutoff at the earliest live row and exact-key
dedup (idempotent). `--out rows.json` + `scripts/backfill-departures-apply.cjs`
(plain CJS, runs on the machine with `/app/node_modules/better-sqlite3`) is the
production path. Without it the live tables start at 22:21 ET 2026-09-03 and
Red's 344 Winchester hop needs ~a service day to clear the gates; with it, 60
hops clear them at once (Red 29, Blue Day 31).

**The cutoff belongs to the TARGET, and an empty backfill is a failure.** The
first production run of this script emitted `{"visits":[],"legs":[]}` and exited
0, under a per-route coverage table that looked exactly right — the table counts
"the target after this backfill", so it reads the same whether the rows came
from the run or were already there. The `--db` it was given had itself been
backfilled from this archive, so its earliest `stop_visits` row WAS the
archive's first sample, and every derived event landed at or after the cutoff
and was correctly skipped. Two things now make that impossible to miss: `--target
<path>` names the database the rows are FOR (the cutoff and dedup keys come from
it; `--db` still supplies the network), and `checkBackfill`
(`scripts/backfill-guards.ts`, unit-tested) refuses **any** run that keeps zero
rows, and refuses a cutoff at or before the corpus's first sample even when
`--allow-empty` is passed — since that one can only ever keep nothing. A failed
run prints a `=== BACKFILL SUMMARY ===` block with the cutoff and its
provenance, writes nothing, and exits 1.

### The rider canary (`scripts/rider-canary.mjs`)

Everything above scores predictions **in aggregate** — median error, share
within two minutes. The canary is the only thing that watches the SEQUENCE one
rider sees, which is the operator's complaint (2026-09-03): "i'm not worried
about a few seconds. i'm worried about saying a bus is 10min away and then a
few seconds later dropping to 1 second." Reports #64 and #32 are riders saying
the same thing.

**It is the standing watch.** On 2026-09-03 the operator retired the other one
("remove the cron. the canary agent can do it all"), so this harness inherited
the whole job: all fifteen lines, round-robin, one browser at a time. A line
counts as running when `/api/buses` shows live buses on it — the server already
drops out-of-service ghosts, so that is the service-hours gate and no schedule
table is copied into the harness.

Each line is ridden on the operator's own trip, Prospect/Canner → the School of
Public Health, whenever it comes within 700 m of both ends; otherwise on a trip
derived from its own published stops (board at the first, ride a quarter of the
loop). The 700 m is deliberately not `MAX_WALK_M`: at 1500 m fourteen of the
fifteen lines "serve" this trip, including ones the app is right to bury, and
every one of them would be reported as a missing line.

It watches the countdown every 15 s until the bus physically reaches the board
stop it read out of the app's own Directions link. `npm run canary -- --loop`
keeps one rider going; silent on a healthy run; `--summary` for the digest.

**It never files a report, and a run that read nothing fails.** Both are
lessons from the watch it replaced: that one auto-filed `[first-rider]` reports
at `priority: "urgent"` — the behaviour the operator turned off once already —
and it logged "Purple kept its promises at Building 800" off a ride whose own
record says `"promises": 0`. A scraper that has silently stopped reading looks
exactly like a healthy line, so `no-countdown` is a failure here.

**The display is bucketed** (`fmtMin`: "now", "<1 min", "N min"), so every
comparison in `canary-metrics.mjs` is between INTERVALS and reports the
smallest movement the two readings permit. A jump it reports is one the app
provably made; bucket edges cannot invent one. Its unit tests are the spec.

**A reading holds TWO buses, and comparing them by POSITION was wrong**
(2026-09-04). The countdown is `fmtBusPair(busEtaLive, nextArrLive?.eta)`:
slot 0 is the pinned vehicle, slot 1 whatever `nextArrivalAfterPinned` found
behind it. Comparing slot 0 against slot 0 charged any change of cast to the
bus that stayed — **44 of the archive's 77 "catastrophic" jumps were not one
bus moving at all**. The mechanism is NOT re-sorting, which was the first
guess and is measurably rare (2 of 2104 two-bus readings print out of ETA
order; 1 of the 77 flags). It is SUBSTITUTION: the leader vanishes and
everything shifts up a slot. `pairBuses` now matches vehicles across a
transition and `scoreSequence` reports three kinds — `drift` (the same bus
moved; the ONLY kind the catastrophic/reversal thresholds apply to),
`dropped` (a bus left the list; `severe` inside 2 min, and the only one that
fails a run) and `appeared` (a newcomer takes the head of the list).
Like-for-like the pinned-bus catastrophic count went 77 → 33; the balance of
the new drift population is the SECOND bus lurching, which is real and was
never measured before (`leaderCatastrophic` / `secondaryCatastrophic` keep
them apart). Identity comes from the caller where it exists: `rider-sim`
passes the pinned `busName` per tick and gets exact slot-0 pairing, so "the
same bus re-priced a lap later" stays a lap of drift; the live canary has no
names in the text and falls back to nearest-ETA under `pairWindowSec`
(600 s — a judgement between two measured landmarks, not a valley in the
data; the sweep is in the constant's comment).

**A flag with an EVENT behind it is not a defect.** `docs/eta-lurch-
classification.md` (#71) measured that 92.4% of catastrophic drops have a
real-world event behind them: the bus reached the stop, pulled away, and the
card honestly moved to the next one. `departureBetween` asks that question
from the `buses` array every sample already carries — take the nearest bus in
the earlier reading, find it BY NAME in the later one, and see which way it
moved. Every event carries the verdict (`departure` / `closing` / `none` /
`unknown`) and **only the eventless ones fail a run**; the rest are counted
(`catastrophicEventful`, `droppedSevereEventful`) and reported. Over the
archive that explains 8 of 15 severe drops — the population that fails a run
— and only 1 of 64 catastrophic drifts, because a departure from the BOARD
stop is a much narrower event than the ones #71 counts; **do not read the two
as the same measurement.** The `NEAR_STOP_M` (120 m) precondition is
load-bearing: without it a bus merely driving away on the far side of its
loop reads as a departure and 23 of the 64 drifts talk themselves away.

**`ARRIVAL_M` is 60 m, not 45** (2026-09-04), and the canary now takes the
feed's own `at_stop_id` naming the board stop as an arrival regardless of
distance. A run filed `no-arrival` while #304 sat **49 m out with
`at_stop_id` naming that very stop** — four metres, on a feed with a ~30 m
deadband. The old bound was truncating its own distribution: 32 detected
arrivals at 12..44 m, four in [40,45) and none above. 60 m is where the
feed's own reckoning stops agreeing — by distance band, at_stop against not:
[0,30) 42:1, [30,45) 24:2, [45,60) 5:2, [60,80) 6:7, [80,100) 0:10.
`eta-accuracy.mjs` deliberately KEEPS its own 45 m: its published numbers
were taken at that bound.

**A run that parsed zero countdowns is the instrument, not the app.** Eight
runs in the log were recorded between #111 (which removed the glyph
`parseOptions` keyed on) and #113 (which fixed it), and one of them filed
`line-missing` against a perfectly healthy Red. Exclude `readings === 0` runs
from any before/after over `runs.jsonl` and say how many you dropped.

**What the first live run measured.** Red, 2026-09-03 17:01 ET, bus #304,
board stop Division/Prospect (#48), on a build that already had #77's
rest-as-a-spread work:

    17:01:04  "🚌 in 7, 39 min"   #304 386 m out, at_stop_id 11
    17:01:19  "🚌 in 2, 37 min"   #304 361 m out, moving
    17:02:10  #304 reaches the stop — 66 s after the "7 min"

The pin never changed and the feed moved 25 m, so the 3.75-minute drop was
entirely a recompute. 420 s is exactly the served chain from the bus's anchor:
11→146 (364 s) + 146→49 (33 s) + 49→48 (23 s) — and **11→146 is 112 m**, which
no bus drives in six minutes. That segment is the 344 Winchester layover,
billed arrival-to-arrival as the estimator intends; what the canary adds is
that when a bus takes a SHORT rest the whole billed rest falls out of the
number in one tick, in front of a rider. It is the same distribution problem
#77 named, seen from the rider's side rather than the estimator's.

Two things to take from it rather than the anecdote:

- **The gate's blind spot is the rider's whole complaint.**
  `accuracy-layover.test.ts` bounds a lurch at 180 s using the same arithmetic
  — and skips "the moment the bus is recorded leaving the stop", because a real
  discontinuity exists in the data there. It does; the rider still sees 7 min
  become 2 min in fifteen seconds. The canary's catastrophic bar IS that 180 s
  (a test pins the two together), applied without the exemption, which is why
  it caught 225 s on its first run. Do not loosen either bound to match a
  change — check the canary log first.
- **The mirror is predicted and unconfirmed**: a bus ARRIVING at a layover
  should make the countdown jump UP by the same 4–6 min, which is what report
  #32 ("6 min then it said 16") describes. Look for it in
  `scripts/.canary/runs.jsonl` before designing against it.

## Investigations that did not become code

- `docs/bus-speed.md` — showing a bus's speed (rider report #63). A 30 s
  trailing window beats a constant-velocity Kalman filter on this feed, and
  the number is only informative about two minutes ahead, so it must never
  feed the ETA. Not built; read it before building it.
- `docs/eta-error-budget.md` — where the ETA error actually lives, and why the
  rider-visible problem is **stability, not accuracy**. Decomposes a hop into
  dwell / hold / drive (standing is 95% of the within-segment variance,
  driving 5%); measures the *sequence* of numbers a rider sees rather than
  |predicted − actual|. A mode-switching route-progress filter was built and
  **lost**: it cuts anchor flips 84% and the catastrophic ETA jumps do not
  fall, because they are conserved and merely re-labelled. Even a perfect
  anchor is worth 1.00% → 0.96% of them. It concluded an output-side rate
  limiter wins (95% fewer catastrophic jumps for 2.7 s of median accuracy);
  **the operator rejected that** — "it can go 5->1 if it leaves early. but if
  it is jitter we need a fix" — and the lurch classification below explains
  why he is right: most of those jumps are real events. Read it before
  proposing a Kalman filter, a traffic model, or anchor work aimed at
  stability.
- `docs/eta-lurch-classification.md` — every ETA jump ≥ 300 s classified by
  whether a real-world event caused it, on the SHIPPED client (the replica is
  checked against `computeUpcomingArrivals` on all 444,409 pairs and the run
  fails on a mismatch). **92.4% of the catastrophic DROPS are eventful** — the
  bus really departed, arrived or moved — so the 5→1 is information and must
  arrive instantly. The jitter is the opposite sign: 93% of the eventless jumps
  are the number going UP, and 250 of 380 are the collector restarting a
  standing bus's clock, which zeroes the stall credit and re-prices the whole
  first hop in one poll. **The served-dwell credit cap is NOT the lever**: it
  binds on 11.5% of standing observations, the median standing bus having
  served 0.4 of its expected rest. Fix the clock (`stationarySince`), and
  prorate in both regimes; do not build a slew limiter.

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
| `lookup-sweep.mjs` | every named Yale/campus place in OSM is findable by the pipeline a rider hits (no browser) |
| `rider-canary.mjs` | a continuous synthetic rider: watches ONE countdown tick by tick until the bus arrives, and scores the SEQUENCE (jumps, reversals) rather than the aggregate |

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

`lookup-sweep.mjs` answers "what can a rider NOT find?" without waiting for a
report to arrive — the Chaplain's Office cost one. It pulls every NAMED
node/way in the New Haven bbox whose `name` or `operator` mentions Yale, plus
every place of worship, from Overpass, and runs each name through the lookup
pipeline. A place counts as answered when a hit within **250 m of it ranks in
the top 3**: name equality is the wrong test ("Yale University" matches a dozen
labels) and rank matters because the dropdown is short. Places farther than the
planner's `MAX_WALK_M` from every stop are set aside before any lookup is spent
on them — no trip exists to them, so a landmark would answer a search with a
journey the app cannot plan.

**"Found" has to mean found by the pipeline a rider actually hits.** The first
cut of this measurement scored against `geocode()` alone — curated landmarks
plus stop names — and reported **213 of 311 places missing. That number was
wrong.** Production does not stop at the local layer: `geocodeV1` falls through
to Photon and then Nominatim, and those know every object Overpass just handed
us, because it all came out of OSM in the first place. Sampled against the real
stack, 16 of 18 supposed misses were findable. Curating 200 entries off that
list would have diluted ranking for nothing — `landmarks.ts` warns about
exactly that in its own header. So the script scores against `geocodeV1` with a
real external geocoder and sorts into three buckets that mean three different
things:

| bucket | meaning | action |
|---|---|---|
| `curated` | the local layer answers it | none — the goal state |
| `uncurated` | only Photon/Nominatim answer it | **not a defect.** Curating buys rank, latency and a better label; it is an improvement |
| `UNFINDABLE` | no layer answers it | **the defect.** Only a curated entry can fix it |

Measured 2026-09-03 (149 landmarks, 172 stops, 342 places, none out of reach):
**98 curated (28.7%), 239 uncurated (69.9%), 5 UNFINDABLE (1.5%)** — the Yale
New Haven Hospital heliport, Harkness Memorial Auditorium, and SHM's I-, L- and
B-Wings. **Five**, not 213 — and fewer than the 18-place hand sample implied,
because the sample could not see how many of its misses the local layer catches
at rank ≤3.

It also reports **8 places we already curate that answer to a name the matcher
scores at zero** — it reads each landmark's OSM id back out of the trailing
comment on its own line, so a hit on an id we already hold is a missing ALIAS,
not a missing place: `Payne Whitney Gymnasium` vs our "Payne Whitney Gym"
("gymnasium" is 9 letters, "gym" is 3 — past the fuzzy tier's length rule),
`Yale Police Department` vs "Yale Police (101 Ashmun)", `Ingalls Ice Rink` vs
"Ingalls Rink" (the same "ice rink" a rider already wrote in about). One line
each.

Flags: `--sample=N` (with `--seed`) for a quick reproducible check, `--json`,
`--all` to include the uncurated list, `--max-unfindable=N` as a CI gate,
`--cache` to reuse the last Overpass answer. `--local-only` skips the network
entirely and is deliberately reported as `not answered locally / UNCLASSIFIED`,
never as unfindable — that conflation is the mistake above, and
`--max-unfindable` refuses to arm on it.

Two constraints the script exists inside. **The external path is throttled to
one lookup per 1.1 s by design**, to keep our egress IP off Nominatim's block
list, so the sweep calls `geocodeV1` in-process (the same throttle applies),
runs strictly sequentially and prints its own ETA. Calling `geocodeV1` rather
than a server's `/api/geocode` is also what keeps the sweep out of the rider
data: that route records every query in `search_terms`, and a few hundred
synthetic OSM names would be indistinguishable from demand.

Overpass answers **406 to Node's default User-Agent**; the script names itself,
and that is why.

### "5 unfindable" does not mean lookup is 98.5% complete

It means lookup is 98.5% complete **against OpenStreetMap**, which is a
different and much weaker claim. There are two failure classes, they need
different instruments, and the sweep can only see one of them:

| failure | instrument | reading, 2026-09-03 |
|---|---|---|
| **OSM knows the place, we cannot answer it** | `lookup-sweep.mjs` | 5 of 342 |
| **The place exists, OSM does not know it** | `search_terms` (`GET /api/stats/searches`) | invisible to any sweep |

The second class is the one that started all of this. **The Chaplain's Office
does not appear in a sweep run at all** — not as a miss, not as a hit. An
unbounded Overpass search for `[Cc]haplain` returns **zero objects** — checked
twice, and the second time across ANY tag rather than `name` alone and over a
bbox far wider than the sweep's (41.20,-73.05,41.45,-72.80) — and both external
providers answer with unrelated offices. An OSM-derived sweep can only grade against OSM, so a place OSM has
never heard of is not scored, not counted, and not in any bucket. The same goes
for every office, centre and department that a rider knows by a name Yale
publishes and OSM never imported. "The anchor bar" surfaced this way too.

So do not read a clean sweep as a complete lookup, and do not size the curation
backlog from it. The sweep says *we answer what OSM knows*; only what riders
actually typed and got nothing for (PR #49's table) says *we answer what riders
ask*. Run both, and treat a zero-result search term as the higher-priority
signal of the two — it is a rider who already failed.

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
