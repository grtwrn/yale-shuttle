# The closed loop: measuring the ETA every hour, and what learns from it

**Operator's ask (2026-09-06):** "I want our algos continually improving with
data … build the closed loop." And, the same day: "can the nightly learning be
increased to hourly?"

**Status:** stage 1 (the scorecard) and stage 2 (the archive) are built —
this document says what they are, what they write, and what stages 3 and 4
need from them. Stages 3 and 4 are designed here and not built.

## The four stages

| stage | what | cadence | where | status |
|---|---|---|---|---|
| 1 | **Scorecard** — every ETA arm scored against the detector's arrivals under one set of rules, per ET day / route / horizon / surface, versioned by the server build | hourly at :35; a day closes at 03:35 the next morning | `src/server/scorecard.ts`, table `scorecard_days`, `GET /api/stats/scorecard`, the "ETA scorecard" section of `/stats` | **built** |
| 2 | **Archive** — the rows a replay needs, pulled off the production volume every day before retention sweeps them, kept 180 days on the Pi | daily at 03:40 ET (Pi cron) | `GET /api/archive/day`, `scripts/archive-day.mjs`, `scripts/archive-check.mjs`, `~/shuttle-archive/YYYY-MM-DD/` | **built** |
| 3 | **Re-estimation** — the filter's parameters fitted from the last N weeks and served in the payload: EM for the HMM's emission/transition probabilities, conformal widening of the 10–90 band per horizon, departure hazards per stop | DAILY, multi-week window (see below) | not built | designed |
| 4 | **Promotion** — champion/challenger: a candidate parameter set (or estimator) replayed in shadow against the archive and promoted only when the scorecard says so | DAILY, after stage 3 | not built | designed |

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
