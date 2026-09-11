# The closed loop: measuring the ETA every hour, and what learns from it

**Operator's ask (2026-09-06):** "I want our algos continually improving with
data … build the closed loop." And, the same day: "can the nightly learning be
increased to hourly?"

**Status:** all four stages are built. This document says what each one is,
what it writes, and the rules the last two decide by.

## The four stages

| stage | what | cadence | where | status |
|---|---|---|---|---|
| 1 | **Scorecard** — every ETA arm scored against the detector's arrivals under one set of rules, per ET day / route / horizon / surface, versioned by the server build | hourly at :35; a day closes at 03:35 the next morning | `src/server/scorecard.ts`, table `scorecard_days`, `GET /api/stats/scorecard`, the "ETA scorecard" section of `/stats` | **built** |
| 2 | **Archive** — the rows a replay needs, pulled off the production volume every day before retention sweeps them, kept 180 days on the Pi | daily at 03:40 ET (Pi cron) | `GET /api/archive/day`, `scripts/archive-day.mjs`, `scripts/archive-check.mjs`, `~/shuttle-archive/YYYY-MM-DD/` | **built** |
| 3 | **Re-estimation** — the filter's re-estimable parameters counted from the last N archived days and served in the `/api/buses` payload: the deadband emissions, the two hold hazards, the shuffle rate, the departure prior, and a conformal widening of the 10–90 band per horizon | DAILY, 14-day window | `scripts/reestimate-params.mjs` + `scripts/reestimate-lib.mjs`, `web/src/eta/params.ts`, `src/server/modelParams.ts`, table `model_params`, `POST /api/model-params`, the "Learning" section of `/stats` | **built** |
| 4 | **Promotion** — champion/challenger: the candidate replayed against the archive through the real client and promoted only when the scorecard says so | DAILY, in the same run | `scripts/eta-replay/archive-db.ts`, `gps-replay.ts`'s `MODEL_PARAMS`/`PAIRS_OUT`, `POST /api/scorecard/replay`, `surface = "replay:<name>"` | **built** |

**Why the scorecard is hourly and stages 3–4 stay daily.** The scorecard and
the alerts read from it are *observations*, and an observation is worth
having as soon as its truth has settled — a bad deploy at 10:00 should be
visible on the dashboard by 11:35, not tomorrow. The parameters stages 3–4
estimate are *stationary over days*: a stop's departure hazard, a hop's drive
distribution, the emission probability of a repeated fix do not change hour
to hour, and re-fitting them hourly on a sliding window would only add noise
(and a 03:00 fit on two hours of night-route data would be actively wrong).
So stage 3 fits once a day on a multi-week window — the calibrator already
uses 30 days, and the replay found calibration "at its floor" (docs/eta-accuracy.md),
which says the window is not the lever — and stage 4 promotes once a day on
the same cadence. Hourly is for the scorecard; daily is for learning. The
archive is daily because the day is the unit a replay needs whole.

## Stage 1 — the scorecard

### What is scored

Three arms, in the vocabulary of the `surface` column:

| surface | what it is | source | rows / day |
|---|---|---|---|
| `trip`, `ride`, `card` | what a sampled browser (25% of page loads) actually had on screen, one row per (bus, stop, 15 s, surface) — see `docs/prediction-log.md` | `predictions_log`, `surface <> 'upstream'` | ~3k on a weekday |
| `ours` | the three pooled — what "ours" means on the dashboard | derived | |
| `upstream` | the official app's `routes_eta.php`, sampled at the stops riders watch, capped at 30 min by the poller | `predictions_log`, `surface = 'upstream'` | ~15–20k |
| `census` | the same endpoint, every stop of every live route, uncapped, verbatim | `upstream_etas` | ~320k on a weekday (absent before the 0014 migration, 2026-09-06) |

Every arm is scored under **the same rules**, and they are the rules PR #147
put under the dashboard's head-to-head, measured into shape by
`docs/upstream-eta-measurement.md`. The truth function is one exported
function, `truthAt` in `src/server/predictions.ts`; the scorecard imports it
rather than carrying a copy.

1. **Horizon cap, both arms.** A promise past 30 min (`COMPARE_HORIZON_SEC`,
   what upstream publishes to) is counted as `beyondHorizon` and not scored.
   The route cards list every stop of a line, so ~40% of our rows are past the
   cap on a weekday and were what made the old head-to-head read backwards.
2. **A standing bus is not a forecast.** A row whose bus's latest `arrivals`
   visit at the predicted stop has not departed by `predicted_at` (2 h
   lookback, so an unclosed visit from a lost bus cannot flag every later row)
   is counted as `standing` and not scored. Under the naive "first arrival at
   or after" rule those rows were a lap of error on both arms.
3. **Truth is the detector's first arrival within 45 min** of the prediction
   (`COMPARE_MATCH_WINDOW_MS`, the replay's `MATCH_MS`); none = `missing`.
4. **Error = promise − actual, seconds.** Negative is optimistic (the bus came
   later than promised), positive is pessimistic. The replay's sign.

Per row of (day, route, horizon, surface) the `metrics` JSON is:

```
n, beyondHorizon, standing, missing, paired          counts; paired = the scored rows
medianSignedSec, medianAbsSec, p90AbsSec             nearest-rank, as predictions.ts
within120Pct, pessimistic120Pct, optimistic120Pct    |err| ≤ 120 s; err ≥ +120; err ≤ −120
intervalRows, intervalCoveragePct                    rows with low < high, and the share whose
                                                     actual wait fell inside [low, high] — ours
                                                     carry the 10–90 band; upstream is a point
waits, strands                                       a wait = the consecutive rows of one
                                                     (surface, bus, stop) paired to one arrival,
                                                     whose LAST row was within 90 s of it (the
                                                     screen was still showing it); a strand = that
                                                     last number was still ≥ 180 s
jumpPairs, jumps                                     consecutive rows ≤ 5 min apart in one wait;
                                                     a jump = the promised arrival INSTANT moved
                                                     by ≥ 180 s between them, booked to the horizon
                                                     the rider was looking at
builds                                               rider surfaces only: rows per client bundle
                                                     hash, so a deploy is visible in the day
```

Horizons are promised minutes: `0-2`, `2-5`, `5-10`, `10-30`, and `all`
(everything at or under the cap). `route_id = 0` is every route pooled.
Pooled rows are computed from the underlying errors, never from the per-route
medians. Rows with `n = 0` are not written.

### The table and the API

`scorecard_days (day, route_id, horizon, surface, metrics, estimator_version,
scored_through, scored_at, final)`, primary key on the first four. Written in
one transaction per day: delete the day, insert its rows — so a re-run is a
replacement, never a duplicate. `estimator_version` is the server build
(`SHUTTLE_BUILD_SHA`, stamped by the Dockerfile from `scripts/deploy.mjs`'s
`git rev-parse HEAD`; `/healthz` reports it as `build`; `dev` when built by
hand). For the rider surfaces the client bundle hash in `builds` is the
version that actually produced the numbers — the ETA is computed in the
browser — and the two together date a row exactly. 400-day retention, pruned
on each tick.

`GET /api/stats/scorecard?days=N` (1..400, default 30) and the alias
`GET /api/scorecard` return `{ rules, days, rows, routes, estimatorVersion,
now }`: `rules` echoes every constant above so a reader can label the numbers;
`days` carries `scoredThrough`, `scoredAt`, `final`, `estimatorVersion` per
day; `rows` are the stored rows with `metrics` parsed. Auth is exactly
`/api/stats`'s: the `x-admin-token` header or the `stats_session` cookie. The
cookie is scoped `Path=/api/stats`, which is why the dashboard reads the
`/api/stats/scorecard` spelling and why `/api/scorecard` is header-only by
construction; neither unlocks `/api/reports`.

### Cadence, freshness, cost

The job (`createScorecardJob`, started in `src/index.ts` beside the collector)
ticks hourly at :35 and once 90 s after boot. A prediction is scored once its
truth has **settled** — `SETTLE_MS` = the 45-min window + 2 min for the
recorder's flush — so each tick scores predictions made in the hour that just
settled. A `DayScorer` holds the day's tallies in memory and is advanced over
index ranges (`predictions_time_idx`, `upstream_etas_time_idx`,
`arrivals_time_idx` for the truth: 2 h before the range to 45 min after), then
the day's rows are replaced. The dashboard prints "scored through 2:35 PM ET"
from `scored_through`.

The day's **closing pass** runs on the first tick after 03:30 ET the next
morning (the last night route is in by then) and recomputes the day from
scratch, marks it `final`, and drops the accumulator: a restart mid-day
rebuilds the day from midnight, and a late detector write (a `departed_at`
patched after the fact) is picked up, so the final row never depends on which
process happened to be running. A final day is never rescored. Boot backfill
is the same code path over every day the logs still hold that has no final
row (bounded at 45 days; `predictions_log` keeps 30, its upstream rows 7, the
census ~4 weekdays by row cap).

**Measured on the Pi against `snap-0906-1230.db`:** the closing pass for Fri
9/4 (19.3k rows) took 492 ms and Sat 9/5 (22.2k) 331 ms — 15–25 µs a row,
including the 24 hourly chunk reads. A weekday with the census on is ~450k
rows, so its closing pass is ~8–10 s of work spread over 24 chunks with a turn
of the event loop between each (≈0.4 s a chunk), and the hourly incremental
tick is ~20k rows ≈ 0.4 s. The retention sweep in the same process already
blocks up to 4 s per table hourly; this is smaller. Every path is
non-throwing; a failed tick costs an hour and is logged
(`scorecard.tick_failed`).

### What the dashboard shows

The "ETA scorecard" section of `/stats`: a 30-day line of median |error|,
ours against the official app, every route pooled (the two validated series
colours the rider chart uses); the freshness line; the latest day route by
route — paired rows, |err| p50, within 2 min, pessimistic/optimistic ≥2 min,
band coverage, strands/waits, jumps/looks, ours beside official; and the rules
printed in full. The census arm is in the API and not on the page: it covers
every stop, ours covers the stops riders watched, and putting them on one
line would compare populations.

### Offline replay: the hook that is not built here

Scoring **the current estimator on the day's positions** — what the ring
estimator would have said, not what an older bundle did say — needs the
positions, which are on the Pi (stage 2), not the volume. The row shape is
ready for it: a replay writes rows with `surface = "replay:<name>"` and its
own `estimator_version`, the same metrics, and the dashboard's reader ignores
surfaces it does not know. `scripts/eta-replay/gps-replay.ts` already produces
the errors; what is missing is a writer to `scorecard_days` (through an admin
endpoint, since the replay runs on the Pi) — a small job for stage 4, which
needs exactly that to compare a challenger.

## Stage 2 — the archive

The production volume is 1 GB with ~430 MB free; `raw_positions` is swept
after 6 h, the census after ~4 weekdays, `predictions_log`'s upstream rows
after 7 days. Nothing a replay needs survives on the volume long enough to
learn from, so the Pi keeps it.

`scripts/archive-day.mjs [YYYY-MM-DD]` (default: yesterday in ET) pulls, for
that ET day, `arrivals`, `stop_visits`, `legs`, `predictions_log`,
`upstream_etas`, `scorecard_days` and `raw_positions` from production through
`GET /api/archive/day?day=&table=` — admin header only, one table and one ET
day per request, streamed as JSONL, and refused for any other table. Positions
are the one table retention has usually beaten by 03:40: when the endpoint
returns fewer rows than the Pi's own capture (`~/shuttle-captures/
positions-YYYYMMDD.jsonl`, UTC-named, so an ET day spans two files) the
capture is used, filtered to the ET day and de-duplicated on
(bus_id, collected_at); the manifest says which source won. Everything lands
in `~/shuttle-archive/YYYY-MM-DD/<table>.jsonl.gz` beside a `manifest.json`
(rows, bytes, sha256, source, the server build, the schema's column list per
table) and days older than 180 are removed. `scripts/archive-check.mjs` lists
which days are complete and which tables a day is missing.

The crontab line (not installed by the PR; the operator's call):

```
40 3 * * * cd /home/gwarren/yale-shuttle/services/shuttle-v2 && TZ=America/New_York node scripts/archive-day.mjs >> /home/gwarren/shuttle-archive/archive.log 2>&1
```

Disk, measured against the 2026-09-06 snapshot on the Pi: Fri 9/4 archived
to **2.6 MB** gzipped (173,555 positions from the capture, 6,350 arrivals,
6,238 visits, 5,427 legs, 19,336 predictions, 211 scorecard rows; the census
table did not exist yet) in 4.7 s; Sat 9/5 to 1.3 MB. With the census on, a
weekday adds ~320k rows (~40 MB raw, ~4–5 MB gzipped), so budget **~8 MB a
weekday, ~3 MB a weekend day, under 1.5 GB for 180 days** — on a root
filesystem with 42 GB free. A partial day (a hand run at noon) is a legitimate
archive of what existed; re-running the day after 03:40 replaces it.

`archive-check.mjs` reads the manifests and prints rows per table, size,
source and completeness per day plus the gaps in the last N days, and exits
1 when yesterday is missing or incomplete — the same cron line's `&&` can
chain it, or a second line can alert on it.

## Stage 3 — the parameters, served and re-estimated

### What is re-estimable, and what is not

The ring estimator (`docs/eta-ring-posterior.md`) runs on a handful of
constants, and they are not all the same kind of thing. Seven of them are
**counts over the feed** — how often a standing bus repeats its fix, how often
a moving one does, the two hold hazards, the shuffle rate at rest, the share of
"a standing bus moved" events that were departures. Those are re-countable
every night from the archive, and they are what stage 3 serves:

| key | what it is | measured in |
|---|---|---|
| `P_REPEAT_STAND` | P(byte-identical fix \| standing), per poll | docs/eta-error-budget.md |
| `P_REPEAT_MOVE` | the same, moving, open road | " |
| `P_REPEAT_MOVE_ZONE` | the same, within 75 m of a stop of the route | filter.ts (an **estimate**, see below) |
| `HOLD_ENTER_PER_S` | off-stop run → stand hazard | docs/eta-error-budget.md |
| `HOLD_LEAVE_PER_S` | off-stop stand → run hazard | " |
| `SHUFFLE_PER_POLL` | repositions per poll at rest | docs/departure-derivation.md (an estimate) |
| `P_DEPART_ON_FRESH` | P(departure \| a standing bus moved), no stand table | departure.ts |
| `CONFORMAL[h]` | multiplicative widening of the shown 10–90 band, per promised-minutes bucket | **new here** |
| `ROUTE_SCALE[r]` | multiplicative correction of the shown arrival, per bus route | docs/route-bias.md |

Everything else in `filter.ts` stays compiled, on purpose. `SIGMA_M`,
`OFF_ROUTE_SHARE`, `TELEPORT`, `LEAD_SWITCH_MASS`, `REST_RADIUS_M` and the rest
are either derived quantities (`offRouteWeight` is a formula, not a count) or
decisions about behaviour rather than measurements of the world — a served
`LEAD_MAX_HOLD_MS` would be a UI change with no deploy and no review, which is
not what this loop is for. The line is: **a nightly job may re-measure the
world; it may not redesign the estimator.**

### The seam on the client

`web/src/eta/params.ts` holds one mutable object, `MP`, whose defaults are the
compiled constants byte for byte. `filter.ts` reads `MP.P_REPEAT_STAND` where
it used to read the literal — eight call sites, nothing restructured — and the
literals stay in `filter.ts` beside the measurement that set them, because that
is where a reader looks. `params.test.ts` pins the two copies equal AND runs a
scripted day on a synthetic block twice, once on the constants and once on a
served set equal to them, asserting **every cell mass and every priced row is
identical**. That test is what makes "publish" safe to reason about: the
default path is provably the old path.

`arrival.ts` applies `widenBand(eta, low, high)` as the last step of pricing,
after the floor clamp, because the factor is fitted against the number a rider
was actually shown. At a factor of exactly 1 it returns `[low, high]` itself
rather than computing `eta - (eta - low) * 1`, which can differ in the last
bit.

`TransitMap.tsx` calls `applyModelParams(data.model_params)` on every poll,
before anything prices a row. Absent, malformed, or with any key outside its
range, the whole set is rejected and `MP` resets to the constants — a set is
all or nothing, because a half-applied set is a mixture nobody measured. An
older server, a rolled-back publish and a corrupt field therefore all degrade
the same way, to today's client.

### The wire and the store

`/api/buses` grows one optional key:

```
model_params: { version, publishedAt, params: { …the eight above… } }
```

It is **absent** until something is accepted, so a database with no published
row serves exactly the payload it served before. The payload cache
(`createBusesPayloadCache`) keys on the parameter version as well as
`collector.dataVersion()`: a publish lands between two collector ticks and
would otherwise wait for one.

`model_params` (migration 0016) is append-only, one row per nightly decision —
**accepted or not**, because "we tried this and it was worse" is the half a
dashboard has no other way to show. Columns: `published_at`, `accepted`,
`version`, the window (`from`, `to`, `days`), `params`, `n`, `note`,
`decision`. The server serves the latest accepted row.

`POST /api/model-params` is **admin header only**, and deliberately not under
`/api/stats`: the dashboard's `stats_session` cookie is scoped
`Path=/api/stats`, so the browser never even sends it here. Reading
(`GET /api/stats/model-params`, which the Learning block on `/stats` uses) takes
either credential, like the rest of `/api/stats`. Every value is validated
against `PARAM_RANGES` on the way in, and the client re-checks the identical
table on the way out; a test pins the two equal, and a third copy in
`reestimate-lib.mjs` is pinned to them as well.

### The job

`TZ=America/New_York node scripts/reestimate-params.mjs [--dry-run]`, on the
Pi, reading `~/shuttle-archive` — **not** the volume, where `raw_positions` is
swept after six hours. It counts on the last 14 available archived days
(`--days`), replays the last 3 (`--replay-days`), and posts one row either way.

The counters live in `scripts/reestimate-lib.mjs` as pure functions over rows,
so `reestimate-lib.test.mjs` can hand them fixtures whose answers are known by
construction. The classifier is the repo's own: a sample is **standing** iff
some run of consecutive samples containing it stays inside a 25 m ball for at
least 15 s with no feed gap over 60 s (`hop-anatomy.ts`) — not "the coordinate
did not change", which calls a moving bus stopped on a fifth of its samples
(docs/bus-speed.md).

**Nothing is published that cannot be defended.** A key keeps the champion's
value, and the reason is printed and stored in `decision.issues`, when:

- its sample is under the floor (`N_FLOORS`: 5,000 poll pairs for the pooled
  emissions, 2,000 for the in-zone split, 500 transitions for a hazard, 200
  stopped visits for the visit rates, 300 scored pairs for a conformal bucket);
- the value is outside `PARAM_RANGES` — never waived, by any flag;
- it is further from the **compiled** constant than its drift bound (`DRIFT`: a
  probability by 0.15 absolute, a rate by a factor of two), unless
  `--allow-drift` is passed. A re-measurement of a stationary quantity lands
  well inside these; a jump past them is a changed definition or a broken feed,
  and wants a human.

### The first fit, 2026-09-07 — and the one number that disagreed

Counted on the four archived days 9/3–9/6 (455,009 positions, 15,524 stop
visits). Six of the seven reproduce the hand measurement; the seventh is a
finding.

| key | fitted | compiled | n |
|---|---|---|---|
| `P_REPEAT_STAND` | **0.92643** | 0.919 | 224,917 poll pairs |
| `P_REPEAT_MOVE` | **0.13503** | 0.159 | 228,752 poll pairs |
| `P_REPEAT_MOVE_ZONE` | **0.21541** | 0.5 | 65,792 in-zone moving pairs |
| `HOLD_ENTER_PER_S` | **0.01337** | 0.01612 | 15,401 transitions / 1,151,799 s |
| `HOLD_LEAVE_PER_S` | **0.01362** | 0.01457 | 15,418 transitions / 1,132,143 s |
| `SHUFFLE_PER_POLL` | **0.02774** | 0.03 | 3,054 shuffles / 110,104 rest polls |
| `P_DEPART_ON_FRESH` | **0.72607** | 0.76 | 8,095 stopped visits |

The two emission probabilities land within 0.008 and 0.024 of numbers measured
by hand on a different window, which is the check that the definition in
`reestimate-lib.mjs` is the one `docs/eta-error-budget.md` used. The hazards
are 17% and 6.5% below theirs; both classifiers agree on the shape and differ
in the detail (the error budget's labels came from the progress filter's
`|Δx| < 30 m` censoring bound, this one from the 25 m / 15 s run), so the
hazards are re-measurements, not reproductions, and the drift bound of ×2 is
what keeps that honest.

**`P_REPEAT_MOVE_ZONE` disagrees materially: 0.215 measured against 0.5
compiled, and the job refuses to publish it.** This is the right outcome and it
was not a surprise: `filter.ts` says of the 0.5 in as many words, "it is an
estimate, not a measurement" — the collector's three-poll rule written as a
probability, chosen high on purpose because calling every in-zone repeat a
stand once flipped an arriving bus to standing at 5.8 : 1. The measurement says
a moving bus inside a stop's zone repeats its fix about a fifth of the time,
not half. **Do not simply lower it.** The 0.5 is a deliberate bias in the
likelihood, and the number that would settle it is not the emission rate — it
is what the anchor does on the whole day at 0.215, which is a stage-4 replay
somebody should run behind `--allow-drift` and read before touching the
constant. Until then the drift bound holds the line and the disagreement is on
the record here.

## Stage 4 — champion against challenger

### Replaying an archived day through the real client

`scripts/eta-replay/archive-db.ts <day> <base snapshot> <out.db>` builds a
throwaway database in the replay's own schema (the real migrations, so
`model-patch.ts`'s calibrator loaders work unchanged): topology and 30 days of
prior calibration from the snapshot, the day's `raw_positions`, `arrivals`,
`legs` and `stop_visits` from the archive, de-duplicated on primary key.
Nothing after the day's end is copied — those rows are the future for every
rider in the replay.

`gps-replay.ts` then runs the day through `computeUpcomingArrivals`, i.e.
through the ring estimator itself, and two new environment variables make it a
champion/challenger harness:

- **`MODEL_PARAMS=<file>`** applies a served parameter set to the estimator
  before the run, through the client's own `applyModelParams` — so a set the
  client would reject cannot be scored, and the script exits 2 saying so.
- **`PAIRS_OUT=<file>`** writes the real client's three numbers per pair
  (`eta`, `low`, `high`) with the detector's truth, as JSON lines. Both arms
  are then scored by the same code (`scoreRows` in `reestimate-lib.mjs`, the
  scorecard's rules), so they cannot drift apart through the script's own
  summary.

**`MODEL_ROUTES` must be left unset for `gps-replay`.** Unset means the tree's
own allowlist, which is production (all fifteen routes since 2026-09-05).
Setting it to `"all"` builds the set `{"all"}`, matches no route id, and
quietly scores the *legacy* arithmetic on every line — an estimator no rider is
running. `model-patch.ts` reads the same variable with a different meaning and
does want `all`; the job passes it there and not to the replay.

The band widening is fitted on the champion's **raw** bands (the replay is run
with `CONFORMAL` forced to 1 on both arms) and both tables are applied
afterwards by `scoreRows`, so champion and challenger are compared band for
band by one piece of code. When the challenger's scalars equal the champion's —
only the widening moved — the second replay is skipped and the same pairs serve
both arms.

### Where the scores go

`POST /api/scorecard/replay` (admin header) writes one day's rows under
`surface = "replay:<name>"`, the hook stage 1 left open. Two consequences were
load-bearing:

- `writeDay`, the hourly job's own writer, used to delete **every** row of the
  day before re-inserting. It now spares `replay:%`, or a promotion comparison
  would live one hour.
- A replay's own re-run replaces only its own arm.

The dashboard's reader skips surfaces it does not know, so these rows sit
beside `ours` without being counted into it.

### The first conformal fit, 2026-09-07 — the band is too narrow everywhere

Fitted on 9/4 and 9/5 (the champion's raw bands, 1.1 M scored pairs), held out
on 9/6:

| bucket | factor to reach 80% coverage | n |
|---|---|---|
| 0–2 min | **5.39** — outside the accepted [0.5, 4], refused | 194,182 (5,170 with a zero-width band) |
| 2–5 min | 1.452 | 277,517 |
| 5–10 min | 1.302 | 291,987 |
| 10–30 min | 1.425 | 348,935 |

**The shown 10–90 band is too narrow in every bucket**, and in the nearest one
it is not close: a bus two minutes out would need its band scaled more than
five-fold to cover the arrival four times in five, and 5,170 of those pairs
showed a band with no width at all, which no factor can widen. That is not a
calibration knob to be turned quietly — a band that narrow next to a number
that is right (the median |error| is ~100 s) says the estimator is confident
about the last two minutes in a way the arrivals do not support, and the honest
place to look is `arrival.ts`'s mixture near the stop and the stall credit, not
the multiplier. The range guard refuses it and the run says so; the other three
buckets, at 1.3–1.45×, are ordinary widenings and are what the challenger
carries.

### The per-route scale (added 2026-09-08)

`ROUTE_SCALE` is fitted beside the conformal widening, on the same days, from
the same champion pairs, and held out on the same last one — but it is not the
same kind of quantity, and the difference is worth stating. The seven scalars
are counts over the feed: the loop re-measures the world. The conformal factor
and the route scale are fitted against the estimator's own scored errors: the
loop measures ITSELF. Both are legitimate, and the second kind needs harder
guards, because an estimator that is wrong for a reason will happily have that
reason fitted into a constant.

The fit is the factor on the excess above 180 s (`ROUTE_SCALE_FLOOR_SEC`, the
strand threshold the correction is hinged at) that puts the route's median
error at zero, bisected, shrunk toward 1 by `n / (n + 2000)`, on the replay's **proximity**
truth where the pairs carry it (`gps-replay`'s `PAIRS_OUT` now emits it). That
is a deliberate departure from the scorecard's truth, and `docs/route-bias.md`
§4 is the argument: the detector's arrival fires 10–75 s before the bus is at
the kerb, route by route, and the two truths ask a per-route correction for
opposite things. The consequence to keep in mind: **a published scale will read
on `/stats` as that route becoming more pessimistic**, because the dashboard
scores against the detector.

Five guards, and the middle one is the load-bearing one:

- the sample floor (2,000 pairs promising over 180 s — the ones a factor can move);
- **the pooled-prior share** — no scale for a route more than 10% of whose lap
  metres are priced from the network's pooled pace. Such a route is not
  biased, it is INCOMPLETE, and its error closes on its own as the collector
  fills the hops. Green on 2026-09-04 was 73% by this measure and read a
  +113 s bias; with its three new hops timed, as production had them by 09-08,
  the same replay reads −6 s. The fit asks for 0.759 there and the guard
  refuses it; had it published, Green's held-out median |error| would have gone
  71 → 118 s;
- the range [0.75, 1.25], never waived;
- the drift bound, ±0.20 from 1, waivable only with `--allow-drift`;
- **the held-out day, per route**: a scale that does not improve its own
  route's median |error| on a day it was not fitted on is not published. Twelve
  numbers fitted on twelve disjoint samples are twelve decisions, and one
  route's failure never touches another's.

Because the correction is the last step of pricing and feeds nothing back, a
scaled pair is exactly `eta × s`, so the held-out check is arithmetic on the
champion's own pairs and costs no replay. The challenger replay still runs, and
it is the CHECK on that identity: on 9/4, 0 of 226,052 pairs differed from
`eta × s` (max |Δ| 0.00 s).


### The promotion rule, and its noise bound

A challenger is promoted only if, over the replayed days:

1. its **mean median |error|** is not worse than the champion's by more than
   `medianBound`, and
2. its **held-out interval coverage** is not lower than the champion's by more
   than `coverageBound`.

Both bounds are **measured, not chosen**: they are the day-to-day standard
deviation of the *champion's own* numbers across those same days — that is how
much the same estimator moves with nothing changed — floored at 3 s and 2
percentage points so that a freak run of three near-identical days cannot make
the rule infinitely strict. The held-out day is the last replayed day, the one
the conformal table was **not** fitted on; its coverage is the only honest
coverage number, because a split-conformal factor covers its own fitting set by
construction.

The decision, its bounds, its per-day table and the reasons are stored in the
`model_params` row and shown on `/stats`. A run that declines to publish is
exactly the one worth reading, which is why the Learning block reads the last
decision from the history, not from the served set.

### The first decision, 2026-09-07 — promoted, and what actually moved

| day | champion p50 \|err\| / band coverage | challenger |
|---|---|---|
| Fri 9/4 | 77.2 s / 65.9% | 77.1 s / **77.1%** |
| Sat 9/5 | 128.9 s / 51.5% | 128.8 s / **64.0%** |
| Sun 9/6 (held out) | 126.0 s / 56.5% | 125.9 s / **70.8%** |

Bounds: median 29.0 s, coverage 7.3 points. Mean median difference **−0.1 s**;
held-out coverage difference **+14.3 points**. Promoted.

**Read this honestly.** The six re-counted scalars moved the median absolute
error by a tenth of a second — which is to say, by nothing. That is the
expected result and it is good news: it says the hand measurements those
constants came from were right, and that re-counting them nightly is
maintenance, not improvement. **Everything the challenger won, it won on the
band**: coverage rises 11–14 points on every day, because the shown 10–90
interval was too narrow and the conformal factors widen it. If a future run
ever reports a large median gain from these seven numbers, be suspicious of the
fit before believing it.

**The median bound is weak here, and knowingly so.** 29 s is the champion's own
spread across a Friday (77 s) and two weekend days (~127 s) — that spread is
*day type*, not estimator noise, so a challenger could be genuinely 20 s worse
and still pass. The coverage bound (7.3 points) has the same problem in
miniature. With only four archived days there is no way around it; the rule
degrades safely (it is a floor of 3 s and 2 points when the days agree, and
merely permissive when they do not) and it tightens on its own as the archive
fills with comparable days. **Comparing like days — weekday against weekday —
is the first improvement to make once 14 days exist**, and it needs no new
data, only a filter on which days enter the comparison.

**Coverage is still under target.** The factors were fitted to reach 80% and
the held-out day reads 70.8%: split conformal fitted on Friday and Saturday
does not fully transfer to Sunday, and the 0–2 min bucket — refused by the
range guard — is still at 1.0 and drags the pooled number down. The direction
is right; the level is not yet the promise.

## The cron line

Not installed by the PR — the operator's call. It runs after the archive's
03:40 line has landed the night's day:

```
20 4 * * * cd /home/gwarren/yale-shuttle/services/shuttle-v2 && TZ=America/New_York node scripts/reestimate-params.mjs >> /home/gwarren/shuttle-archive/reestimate.log 2>&1
```

Add `--dry-run` to watch it for a week before letting it publish.

**Cost, measured on this Pi (2026-09-07).** The counting half is 2 s over four
days of positions. The replay half is the whole job: `gps-replay` with the ring
on all fifteen routes takes **413 s for a weekday** (9/4, 173k positions,
822,671 scored pairs) and 175–200 s for a weekend day, and the run makes one
pass per arm per day — six for three days when the scalars move, three when
only the band does. Budget **~25 minutes**, which is why 04:20 and not a
service hour. Everything is cached under `scripts/.reestimate/` (gitignored):
~45 MB for a day's replay database and 25–63 MB for each arm's pairs, so
~170 MB a replayed weekday. An interrupted run resumes at the replay it had
reached, because a pairs file that already exists is not recomputed.

**Memory is the constraint, not CPU.** A weekday's pairs are 63 MB of JSON
lines; holding three days times two arms as objects is ~2.5 GB, which this Pi
does not have (it OOMed the first attempt). Everything downstream of the replay
streams the file one pair at a time (`readPairs`) and only the tallies are
held.

## What stages 3 and 4 need — and get

- **Stable rows.** `scorecard_days` is the contract: the metrics keys above
  are added to, never renamed; a new statistic is a new key; a new arm is a
  new `surface` value. A reader that does not know a surface skips it.
- **Versions.** `estimator_version` on every row, and `builds` inside the
  rider rows, so a change in the number can be attributed to a deploy before
  it is attributed to the world. Stage 4's promotion rule should compare
  challenger rows against champion rows **of the same days**, never across a
  version boundary.
- **Days, not windows.** Rows are per ET day and final after 03:35, so a
  multi-week fit in stage 3 reads a fixed set of final days and gets the same
  answer tomorrow. The `final` flag is what says a day may be read for
  learning; today's row is for the dashboard.
- **Fuel.** The archive gives stage 3 the positions and the events to fit on
  (positions for the HMM's emissions; `stop_visits` and `legs` for the
  hazards and drives; `arrivals` as truth) and stage 4 the positions to replay
  a challenger over, with `predictions_log` as the champion's actual record
  of the same day.
- **A place to write.** A challenger's replay writes `surface =
  "replay:<name>"` rows; the promotion decision reads them beside `ours` for
  the same days and horizons. Promotion means: the served parameters change
  (stage 3's output is served in the `/api/buses` payload the way `segments`
  and `dwells` already are), not a deploy.
