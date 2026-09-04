# rider-sim: a day of riders, each one's countdown from first sight to boarding

**Status: instrument, validated against the live canary's archived runs.
First findings from one day (2026-09-03) below.** Scripts:
`services/shuttle-v2/scripts/eta-replay/rider-sim/` (`run.ts`, `lib.ts`,
`lib.test.ts`); usage in `scripts/eta-replay/README.md`.

The operator's ask, verbatim:

> "like the canary rider, but we should be able to do expedited simulations
> given the days data we can create riders and then simulate the algorithm
> results while 'waiting' at a stop"

and, sharpening it:

> "red is the case we should optimize for. even though its a simple loop,
> we're messing up big on the 344 Winchester to prospect and canner timing"

## Why a third instrument

Two exist and neither answers the question. `scripts/rider-canary.mjs` is a
real browser at a real stop watching the countdown tick until the bus arrives
— it scores the *sequence a rider reads*, which is exactly right, but one run
is ~30 readings and a day of them is a handful. `scripts/eta-replay/*` replays
1.5 M transitions offline — huge N, but a transition is an aggregate over
(bus, stop) pairs and cannot say what one person standing at one stop saw from
arrival to boarding.

The operator's complaint — "saying a bus is 10 min away and then a few seconds
later dropping to 1 second" — is a property of one person's sequence. So the
unit of output here is **a wait**: a rider is (line, board stop, arrival
instant, optional origin), and the instrument replays, poll by poll, the exact
text the trip card would have shown them until their bus reached the curb.
Thousands of riders, a day of data, minutes of wall clock (a Red-focused
day runs in about five minutes on the Pi; every line, thirteen).

## Fidelity: nothing is re-implemented

Every poll runs the real client functions, in the browser's order and with the
browser's arguments, imported from the tree under test (`CLIENT_ROOT`):

| step | function | note |
|---|---|---|
| when the rider reaches the stop | `planTrip(origin, alight, …)` | the option, its board stop, its pinned bus. A rider whose plan boards elsewhere is recorded as skipped, not simulated at the wrong stop |
| every poll | `computeUpcomingArrivals(targets, buses, …, now, dwells, anchorStore)` | one `AnchorStore` per rider, opened when they opened the app (PR #72). Riders arriving on the same poll share one store and one call — exact, because `gateAnchor` is idempotent within a poll (checked, not assumed) |
| | the `options` memo: `hereBus` / `departed` / `pickLiveArrival(live, o.busName, walk)` | **`o.busName` is the plan-time pin, every poll** — that is what `stableOptions` holds. A tidier simulator would have silently fixed this |
| | `shuttleCtx` + `remainingSec` | decide whether a countdown is rendered at all |
| | `nextArrivalAfterPinned` | or the pre-#74 `eta > shown + 30` filter on a tree that predates it |
| | `fmtBusPair` | the text on the row |

The payload comes from the real detector (`planTracks` + `stepMany`, from the
same tree) and the collector's own at-stop rule (`stationarySince`, 15 s,
75 m); a bus that misses a poll stays on the payload for `LIVE_BUS_TTL_MS` as
in production, and the client's `isBusInService` filter runs before anything
reads `buses`. Calibration is time-travelled per ET hour from a DB snapshot
(`common.ts`, the machinery every other replay uses, plus a shared
`makeDwellCache` so the dwell replica is written once).

Scoring is the canary's own (`canary-metrics.mjs`, imported): display
buckets, the smallest movement two consecutive readings permit, the 180 s bar.
Truth is the canary's 45 m curb rule from the same positions (re-armed past
120 m); the detector's arrival event rides alongside. A rider arriving with a
bus already inside 45 m is armed like the canary (that bus does not count)
and reported separately — the app is right to say "arriving now" to them.

Every run stamps the tree it scored: path, HEAD, branch, dirty flag, whether
`anchorGate.ts` exists, which "next in" rule it found.

### Pointing it at a candidate

`CLIENT_ROOT=/path/to/worktree/services/shuttle-v2`. The contract a candidate
tree must keep, because these are what get imported:

- `web/src/arrivals.ts`: `computeUpcomingArrivals(targetStopIds, buses, routeStops, stopCoords, segmentTimes, now, dwellTimes, anchorStore?)` returning `{eta, busName, stopId, routeLabel, …}[]` sorted by eta; `nextArrivalAfterPinned` if present.
- `web/src/anchor.ts`: `registerRoutePaths`, `isBusOnRoute`, `findRouteAnchor`.
- `web/src/anchorGate.ts` (optional): a per-rider `Map` is passed as the 8th argument when it exists.
- `web/src/planner.ts`: `planTrip`, `pickLiveArrival`, `dwellBoardWindowSec`.
- `web/src/format.ts`, `web/src/routes.ts`, `web/src/schedule.ts`, `web/src/walk.ts`, `web/src/geo.ts`; `src/collector/detector.ts`.

A pure module behind `computeUpcomingArrivals`' signature drops in without
touching the instrument. Same capture, same snapshot, same seedless
deterministic population → two runs pair wait for wait:

```bash
npx tsx scripts/eta-replay/rider-sim/run.ts --compare a.waits.jsonl b.waits.jsonl
```

## Populations

- **Focus** (`ROUTES`, default `Red`): a rider at every stop every 10 min
  while the line has a bus (uniform), plus riders placed 8, 4 and 1 min before
  every departure after a ≥60 s stand at the six stops downstream of it, 5 min
  before every drop in the line's bus count, and every 10 min in the last half
  hour before the published close (targeted). Uniform sampling alone drowns the
  interesting cases in easy ones; the targeted set is where the incidents live.
- **Hold-out** (`HOLDOUT`, default `Green,Purple`): uniform riders, always
  generated and always reported per route beside the focus. Red is a plain loop
  with no fold-back; every case that kills a point anchor is on Green and
  Purple. A Red-tuned fix must not be able to regress them silently.
- **The chain** (`CHAIN`, default `Red:11:6`): riders at the six stops
  downstream of 344 Winchester — Winchester / Division (146), Division /
  Sheffield (49), Division / Prospect (48), Prospect / Hillside (104), SCL (113),
  130 Prospect Street (S) (4) — placed 30 s after a Red bus parks at the garage
  stop, every 2 min while it stays, and 30 s before it leaves. Each carries the
  departure it is downstream of, so the departure moment is scored: the raw
  ETA's movement beyond the clock at +0 / +30 / +60 s after `at_stop` clears,
  and the displayed drift at that poll. Its own section in every summary, per
  stop, never folded into the Red aggregate.
- **Named** (`--rider Line@stop@ISO[@lat,lon]`): the acceptance cases, or any
  incident. `TRACE=1` prints every poll: bus, distance, `last_stop_id`,
  `at_stop`, raw and gated anchor, the live list, the text.

Give-up is 45 min. Sampling is every poll (5 s) as the primary; the canary's
15 s cadence is scored alongside so the two are comparable.

## Per wait, per run

Each wait records the compressed displayed sequence with timestamps; first
sight vs actual arrival (signed, negative = the bus came earlier than
promised); the largest single-tick drift and its direction; reversals; the
vehicles followed and whether the app announced a swap; countdown episodes
that vanished (Departed / no countdown) and whether one came back; lap
re-pricing (same bus, +10 min); **strand** — a downward jump of at least two
display minutes, larger than the countdown left after it, with the bus then
arriving within two minutes ("told 7, then 2, gone in 66 s"); overshoot — any
jump at least as large as the number that was on screen; and total wait vs
first promise.

The summary is one glance per group (all / focus per route / hold-out per
route / chain per stop): scored waits, median wait, first-promise |miss|
median and p90 with the early and late tails, and the share of riders who saw
a jump ≥180 s, ≥300 s, a reversal ≥60 s, a strand, an overshoot, a pin change,
a vanished countdown, a lap re-price; the worst-drift distribution; the worst
stops and the ten worst waits as sequences. `--compare` pairs two runs and
prints both/only-A/only-B for each flag plus the per-wait drift delta.

## Acceptance: the four archived incidents, from data alone

Each named rider was run on the tree that was **live at the time** (from the
deploy log) and on the baseline `972c5ba`, with the canary's own origin
(Prospect / Canner, 41.325351 −72.922891) and start instant, against the same
capture the canary's server was writing. The canary's sequence is the archived
`runs.jsonl`.

### Red #309 — tree 9cb8c85, rider at Division / Prospect (48) from 21:21:25 UTC

| | canary (browser, 15 s) | rider-sim (15 s cadence) |
|---|---|---|
| held "6–7 min" for three minutes | 23:27 `7,23` · 23:58 `7,22` · 24:29 `6,22` · 25:00 `7,22` · 25:30 `6,22` · **26:47 `7,22`** · 27:02 `6,22` | 23:22 `7,23` · 24:02 `7,22` · 24:37 `8,22` · 24:57 `7,22` · 25:12 `6,22` · 26:32 `5,23` · **26:47 `7,23`** · 27:07 `6,22` |
| the collapse | 27:48 `5,22` → 28:03 `1,22` → 28:20 `<1,22` | 27:57 `1,22` → 28:17 `<1,22` |
| arrival (45 m) | 21:29:27 (#309) | 21:29:22 (#309); detector 21:29:17 |

**Reproduced.** The rise at 26:47 lands on the same second; the collapse to
"1 min" lands within 6 s; the strand flag fires. Level differences are one
display bucket at most.

### Red #316 — tree d6aeba2 (pre-hotfix), rider at 48 from 20:36:03 UTC

The canary record for this run is not in the archive (it predates
`runs.jsonl`); the incident is report #82's "it jumped from 3 min to 8 min!".
rider-sim on the pre-hotfix tree: `… 20:44:38 in 3, 21 min · 20:45:08 in 3, 20
min · 20:45:23 in 8, 20 min · 20:46:18 in 7, 20 min · 20:46:38 in 1, 19 min ·
20:46:53 in <1 · 20:47:13 now`, arrival 20:47:18. **The layover-clock reset
reproduces at 20:45:23, exactly the row `docs/layover-clock.md` lists as the
destroyed clock (20:45:23, 340 s thrown away, 60 s before departure), as "3 min
→ 8 min", followed 75 s later by an 8 → 1 collapse and a strand.**

On the baseline (with #67, the clock pinned to the stop) the same rider sees
`20:44:48 in 2, 19 min · 20:45:23 in 8, 18 min · 20:45:38 in 2, 18 min`: the
reset is gone, but the poll at 20:45:23 still re-bills the whole layover for
one poll — the bus's shuffle took it past the 75 m radius within which
`at_stop_id` is published at all, so for 5 s the stall credit was zero. A
15 s "2 → 8 → 2" is what #67 leaves behind. (Finding, not tuned for.)

### Red #304 — tree d6aeba2, rider at 48 from 20:58:03 UTC

Archived only as prose: "in 7 min → in 2 min in 15 s, arriving 66 s later".
rider-sim (15 s): `21:00:43 in 7, 40 min · 21:00:58 in 6, 39 min · 21:01:13 in
5, 37 min · 21:01:33 in 1, 35 min · 21:01:53 in <1`, arrival 21:02:08. **The
shape and the timing reproduce — a four-bucket collapse inside 20 s, the bus
at the curb ~55 s later — one display bucket lower on both sides than the
browser read (5 → 1 against 7 → 2).** The ~1 min level difference is within
what the calibration phase explains (below); the shape is not sensitive to it.

### Brown #301 — tree 61f32ce, rider at Divinity / 409 Prospect (47) from 21:41:34 UTC

This one **diverged first, and the divergence was the finding.** With the
rider standing at the stop the simulator showed `21:48:04 in <1, 57 min` to
the curb; the canary showed `21:48:01 in 1, 57 min → 21:48:16 in 56 min` and
the card fell to the bottom. `TRACE=1` showed the same payload (77 m out,
`last_stop_id` 172, no `at_stop`) and the same anchor. The difference was the
rider: the canary's geolocation is Prospect / Canner, ~200 m from stop 47, so
the app billed a 182 s walk and `pickLiveArrival` — correctly, by its rule —
decided a rider three minutes away could not catch a bus 24 s away, and
re-pinned the same vehicle a lap later. Nothing jumped; a catchability
boundary was crossed, with no "You can't catch #301" line because the missed
bus and the new pin are the same vehicle.

With the origin supplied the simulator prints `21:47:49 in 1, 58 min · 21:48:04
in <1, 57 min · 21:48:14 in 57 min` — the flip at the same 77 m sample. **On
the baseline it still happens** (`21:48:14 in 57, 57 min`). Open, and now
measurable.

The second Brown run (rider at Science Park Garage from 21:59:55, bus parked
there) diverged on the length of the "now" state (canary: `now, then 55 min`
until 22:02:02; simulator: dropped to `in 46 min` at 22:00:03) and on the
second figure (55 vs 48 min). Both point the same way — production's
`at_stop_since` was ~7 min later than the simulator's — and the deploy log
explains it: three deploys landed 21:55–21:58 UTC and each restarts the
collector, so production's detector was cold and the bus's layover clock had
restarted at boot. `DETECTOR_FROM=2026-09-03T21:58:30Z` reproduces `now, then
55 min` then `in 54 min`. **The warm-up suspect was right, in the other
direction: the simulator was warm and production was not.**

## Two findings nobody asked for

Both came out of the acceptance step, both are live on master, and both are
recorded here so they are not re-hunted in the wrong place.

### 1. The layover-clock fix (#67) removed the sustained reset, not the one-poll flash

Red #316 at 344 Winchester, rider at Division / Prospect, tree **`972c5ba`
(master after #67)**, every poll:

```
20:44:33 in 3, 19 min · 20:44:48 in 2, 19 min
20:45:23 in 8, 18 min      <- one poll: the bus's shuffle crossed the 75 m radius
20:45:38 in 2, 18 min      <- and was back inside it 15 s later
20:46:38 in 1, 18 min · 20:46:53 in <1 · 20:47:13 now
```

Before #67 the same poll started a 75 s reset ("3 → 8 → 7 → 8 → 1"); after
it the clock survives — `stationarySince` is pinned to the stop — but
`at_stop_id` is only *published* while the bus is within `AT_STOP_MAX_M`
(75 m) of the stop, so the poll the bus sits at 85 m carries no `at_stop` at
all, the stall credit is zero, and the whole 557 s hop is billed once. The
clock was never the only way to lose the credit; the publication radius is
the other, and the fix left it. The chain section above shows the same flash
at every departure, which is the same arithmetic with a different trigger.

### 2. Brown's "1 min → 56 min" is `pickLiveArrival`, not the estimator

The Brown #301 incident (rider at Divinity / 409 Prospect, 21:48:16 UTC, "in 1
min" then "in 56 min" at 77 m out, card to the bottom of the list) was
investigated as an ETA jump. **It is not one.** Trace, tree 61f32ce, the
canary's origin at Prospect / Canner (~200 m from stop 47):

```
21:48:04  d=147 m  live=[301:46 s, 301:3461 s]   "in <1, 57 min"
21:48:09  d=107 m  live=[301:33 s, 301:3449 s]   "in <1, 57 min"
21:48:14  d=77 m   live=[301:24 s, 301:3439 s]   "in 57 min"        <- the flip
```

The live list never changed shape: the pinned bus was 24 s away and, a lap
later, 57 min away. What changed is that the rider's billed walk is 182 s
(`walkSecFromMeters` of 200 m), and `pickLiveArrival`'s rule is
`canCatch = walk <= eta + STOP_DWELL_SEC (60)`, with a 90 s buffer for GPS —
at eta 46 and 33 the buffer held the pin; at eta 24, 24 + 60 + 90 = 174 < 182,
so the 24 s entry became uncatchable, the first catchable entry was the same
vehicle a lap later, and because the missed bus and the new match are the
same vehicle `missedBus` is undefined and no "You can't catch #301" line is
rendered. The card's total grows by a lap, so it sinks. **Still present on
master (`21:48:14 in 57, 57 min`).** Whether a rider three minutes away should
be told the bus they can see is 57 min away is a product question about the
catchability rule and its explanation line; nothing in `computeUpcomingArrivals`,
the anchor or the calibration is involved, and no estimator change will move it.

### What the acceptance step changed in the instrument

Two things it did not have before: a rider's **origin** (the walk is part of
the app's arithmetic, not decoration), and **`DETECTOR_FROM`** (production's
detector state is younger than the last deploy). Both are now inputs. Nothing
in the scoring was tuned to fit.

## First findings, 2026-09-03 (13:51–24:00 UTC), baseline `972c5ba`

Default run (`ROUTES=Red`, `HOLDOUT=Green,Purple`, `CHAIN=Red:11:6`), capture
`positions-20260903.jsonl` (109,858 positions, 7,233 polls), snapshot taken
2026-09-04 01:32 UTC so the calibration for every hour is complete. 9,470
riders → 8,327 waits (1,081 skipped because the planner boarded them at a
neighbouring stop — mostly (N)/(S) twins — and 62 with no option). Five
minutes on the Pi. `scripts/.eta-replay/red0903-base.{json,waits.jsonl}`.

### The 344 Winchester chain (675 scored waits) — the operator's case

| stop downstream of the garage | hops | waits | first promise \|miss\| median | bus came >60 s **earlier** than promised | jump ≥180 s | reversal ≥60 s | **strand** |
|---|---|---|---|---|---|---|---|
| Winchester / Division (146) | 1 | 115 | 95 s | **50%** | 60% | 77% | **51%** |
| Division / Sheffield (49) | 2 | 114 | 105 s | 47% | 68% | 74% | **56%** |
| Division / Prospect (48) | 3 | 115 | 90 s | 44% | 68% | 77% | **50%** |
| Prospect / Hillside (104) | 4 | 112 | 85 s | 44% | 72% | 79% | 10% |
| SCL (113) | 5 | 111 | 95 s | 46% | 68% | 78% | 3% |
| 130 Prospect Street (S) (4) | 6 | 108 | 101 s | 61% | 57% | 66% | 7% |

**Half of the riders waiting at the first three stops after the garage while
a Red bus is parked there are stranded** — told a number, the number
collapses by two or more display minutes, the bus is at the curb inside two
minutes. At Division / Prospect the first promise is beaten by 250 s at p10
and the median rider is told 35 s more than the truth. (The strand share
drops from stop 4 onward not because the promise gets better — the early tail
is the same — but because by then the collapse comes more than two minutes
before the bus, which is the strand definition's cut-off, not a recovery.)

**The departure moment.** 657 of the 675 chain riders were watching when the
bus's `at_stop` cleared at 344 Winchester. On that poll the raw ETA moved
**+291 s beyond the clock at the median** (mean +225 s; ≥120 s for 464 riders,
≥240 s for 358), and by the next reading 30 s later it was back to where it
had been (p50 0; all 590 riders with a reading at +30 s were within 60 s of
the pre-departure number). Displayed, the departure poll is a drift of 245 s
at the median and 425 s at p90; **366 of 657 riders saw ≥180 s at that one
poll, 232 saw ≥300 s**. What that looks like on the screen, a rider at
Division / Prospect during #316's 14:37 layover:

```
14:43:49 in 3, 22 min · 14:44:05 in 3, 21 min · 14:44:35 in 3, 20 min · 14:44:50 in 2, 20 min
14:44:59 in 10, 20 min      <- the departure poll: at_stop clears, the whole 557 s hop is billed
14:45:15 in 2, 20 min · 14:45:45 in 2, 19 min · 14:45:55 in 1, 19 min · 14:46:00 in 4, 19 min
14:46:10 in <1, 19 min · 14:46:50 now, then 19 min
```

and one hop closer, at Winchester / Division during #309's 14:23 layover:
`14:32:20 in <1, 12 min · 14:32:38 in 9, 13 min · 14:32:48 in <1, 13 min`. The
mechanism is the one the estimator design names: 11 → 146 is 112 m priced at
557 s because that segment *is* the layover; while the bus stands the stall
credit cancels most of it; the poll `at_stop` clears the credit is zero and
the proration factor is still ~1, so the hop is billed in full for one poll
and then collapses as the bus moves. A rider sees "2 min → 10 min → 2 min"
in fifteen seconds. Every candidate fix for this hop should be run against
this section first; the per-stop rows make a fix that helps stop 146 and
hurts stop 48 visible.

### Red as a whole (focus: 6,075 scored waits)

Median wait 7.6 min; first promise |miss| median 70 s, p90 365 s, the bus
beating the promise by more than a minute for **33%** of riders and missing
it by more than a minute for 19%. **39% of riders saw a jump ≥180 s, 28% saw
≥300 s, 53% saw a reversal ≥60 s, 12.8% were stranded**, 11% watched the
pinned vehicle change. 777 strands in all, 599 of them at the six chain stops
plus Union Station (N) (121); Union Station is the worst stop on the line —
84% of its 166 waits saw a ≥180 s jump and 83% a strand — for the same reason
the garage is: it is a layover, and the hop out of it is standing time priced
as driving. Uniform and targeted populations agree to within two points on
every share.

### Hold-out: Green and Purple (938 scored uniform waits)

Green: first promise |miss| median **431 s**, 64% jump ≥180 s, 30% strand, 48%
pin change, 22% lap re-priced. Purple: 188 s, 62%, 35%, 54%, 13%. The
fold-back lines are two to three times worse than Red on every share, and
the pin-change and lap-re-price columns are where the branch ambiguity shows
up: the anchor relocates, the pinned entry becomes a lap later, and the card
follows another bus. Any Red-tuned change must leave this section no worse.

### Canary cadence

Scored at 15 s instead of every poll, the shares move by a point or two
(Red 37.6% ≥180 s vs 39%; strand 13% vs 12.8%): the canary's sampling is not
hiding the incidents, and its numbers and these are directly comparable.

### Every line (`ROUTES=all`, 33,006 riders, 25,580 scored waits, 13 min)

| line | scored | wait min | miss s | ≥180 s | ≥300 s | rev | strand | pin | lap |
|---|---|---|---|---|---|---|---|---|---|
| Blue Day | 5909 | 6.7 | 50 | 25.6 | 16.9 | 26.5 | 3.5 | 7.4 | 0 |
| Orange Day | 4125 | 9.3 | 45 | 27.3 | 17.7 | 30.3 | 4.0 | 7.0 | 1.9 |
| Orange East | 315 | 14.4 | 91 | 21.3 | 4.1 | 39.0 | 0 | 0 | 1.9 |
| Gold | 1131 | 14.4 | 109 | 32.4 | 17.6 | 54.5 | 3.1 | 0 | 1.5 |
| Red | 6075 | 7.6 | 70 | 39.0 | 28.1 | 52.8 | 12.8 | 11.3 | 0.5 |
| Orange Night | 905 | 8.1 | 63 | 32.6 | 28.6 | 35.5 | 13.7 | 23.1 | 10.5 |
| Blue West | 163 | 12.3 | 329 | 37.4 | 13.5 | 16.6 | 17.8 | 0 | 13.5 |
| Pink | 2552 | 7.0 | 132 | 60.0 | 46.5 | 65.0 | 12.6 | 16.8 | 5.0 |
| Purple | 1652 | 5.5 | 125 | 51.6 | 38.0 | 58.7 | 30.8 | 44.1 | 8.5 |
| Green | 1475 | 7.9 | 225 | 57.6 | 49.7 | 64.6 | 34.3 | 39.4 | 16.7 |
| Blue Night | 417 | 8.8 | 160 | 62.1 | 56.4 | 63.5 | 12.0 | 26.1 | 13.2 |
| Brown | 861 | 20.6 | 150 | 74.3 | 63.0 | 83.0 | 2.7 | 0 | 35.0 |

(shares in %; "miss" is the first-promise |miss| median; "lap" = same bus
re-priced a lap later.) All lines: 38.8% of riders saw a jump ≥180 s, 10.7%
were stranded, first-promise |miss| median 75 s with 27% early and 27% late.
The two-bus downtown loops (Blue Day, Orange Day) are the healthy end — a
quarter of riders see a ≥180 s jump, 3–4% a strand. Red sits in the middle on
jumps and near the top on strands, which is the garage hop. Brown, a single
bus on a 56-minute loop, re-prices a lap later for 35% of riders (the
catchability flip in the acceptance case, at scale). Green, Purple and Blue
Night are the fold-back and night lines where the pin changes for a quarter
to a half of riders.

The instrument runs every line in 13 min on the Pi; the Red default in about
five.

### The number to beat, on master after #80 (`3e56f03`)

The same run on the rebased master (PR #80, the departure-retreat rule in
`anchorGate.ts`) — paired wait for wait against `972c5ba`, 8,327 waits, no
population change:

| | `972c5ba` | `3e56f03` (#80) |
|---|---|---|
| chain: raw rise beyond the clock at the departure poll, p50 / mean | +291 s / +225 s | **+220 s / +196 s** |
| chain: riders seeing ≥180 s on the departure poll | 366 of 657 | **330 of 657** |
| chain: ≥300 s on the departure poll | 232 | 192 |
| chain: stranded at 146 / 49 / 48 | 51% / 56% / 50% | 54% / 58% / 44% |
| Red: jump ≥180 s / strand / reversal ≥60 s | 39.0% / 12.8% / 52.8% | 39.1% / 12.4% / 49.4% |
| Red: worst drift p90 | 545 s | 498 s |
| paired: worst drift improved / worsened / same | | 1,137 / 222 / 6,329 |
| Green / Purple ≥180 s | 64.4% / 62.0% | 64.1% / — |

#80 takes 260 s off the reversal population (266 waits lose a ≥60 s
reversal, 6 gain one) and trims the departure flash without removing it. So
for a candidate on the 344 Winchester cohort the number to beat is **+220 s
median beyond the clock at the departure poll, 330 of 657 riders seeing
≥180 s on that poll, and half the riders on the first three stops stranded.**
`scripts/.eta-replay/red0903-master.{json,waits.jsonl}` is that baseline.

**PR #81 (`eta/stand-drive-pricing`, 0923c0a) without the split data is
byte-identical to master on every one of the 8,327 sequences** — as its
description claims. Scoring it for real needs `dwells[route][stop].q` and
`segments[route]["A-B"].drive` from the derivation lane, injected with
`PAYLOAD_PATCH=file.json` (shape in `run.ts`'s header); the run is then
`CLIENT_ROOT=/home/gwarren/yale-shuttle-kalman/services/shuttle-v2
PAYLOAD_PATCH=… OUT_NAME=red0903-pr81` followed by `--compare` against the
master file above, chain section first, then the three Red acceptance riders,
then the hold-out rows.

## Scoring PR #81 (stand/drive pricing) on the 344 Winchester cohort

Tables: `docs/data/departure-tables-2026-09-03.json` (PR #83), the **pinned**
clock (`standPinned`, `drivePinned` — `at_stop_since` → plateau end, the clock
#81 conditions on), injected as `dwells[route][stop].q ← standPinned.q` and
`segments[route]["A-B"].drive ← drivePinned.mean` via `PAYLOAD_PATCH`
(`scripts/.eta-replay/patch-pr81-pinned.json`: 218 stops, 224 hops; 46 stops
have n < 5, 2 hops do). The headline hop, 344 Winchester → Winchester /
Division, 112 m served as one 557 s number: stand 327 ± 177 s (n 24), drive
17.1 ± 4.8 s (n 25). Every run below is paired wait for wait against master
`3e56f03` on the same 9,470 riders; the cohort-shared `AnchorStore` is passed
as the 8th argument (the run log states it).

### First cut, `0923c0a` — the flash changed sign

| chain, departure poll (657 watching riders) | master | #81 @0923c0a |
|---|---|---|
| raw rise beyond the clock, p50 / mean | +220 s / +196 s | **−123 s / −146 s** |
| riders ≥ +120 s on that poll / ≤ −120 s | 365 / 25 | **2 / 217** |
| displayed drift p50 / p90 | 185 s / 370 s | 55 s / 175 s |
| riders seeing ≥180 s on that poll | 330 | **40** |
| stranded at 146 / 49 / 48 | 54% / 58% / 44% | 34% / 38% / 38% |
| jump ≥180 s at 146 / 49 / 48 | 61% / 66% / 67% | 34% / 47% / 32% |
| chain strands, paired | | both 54, only master 141, **only #81 88** |
| Red focus: jump ≥180 s / strand / reversal ≥60 s | 39.1% / 12.4% / 49.4% | 32.5% / **13.8%** / 41.1% |
| Red focus: first promise \|miss\| median, early >60 s | 70 s, 33% | 54 s, 28% |
| Green / Purple hold-out: jump ≥180 s | 64.1% / 62.0% | 66.5% / 67.4% |
| Green / Purple hold-out: strand | 28.1% / 35.4% | 34.0% / 37.2% |

The rising cliff is gone: 2 riders instead of 365 see the number rise ≥2 min
as the bus leaves. But the flash on the 75 m publication radius is still
there with the sign reversed — the poll `at_stop` drops, `standingForSec` is
null, the hop prices at drive-only 17 s: `in 8, 24 min → in 1, 24 min → in 6,
24 min` (#316, 20:39:38), `1 → 5 → 1 → 4 → 5` (#309) — and the departure
itself is now a **drop** of 123 s beyond the clock (the conditional remaining
stand is by construction ~2 min until the instant the bus leaves), so the
strand share on Red went *up* (12.4 → 13.8%; chain: 141 fixed, 88 new). The
hold-out regressed on both jumps and strands, on thin tables. Named riders:

```
#316  master  20:44:33 in 3 · 20:44:53 in 2 · 20:45:33 in 8 · 20:45:48 in 2 · 20:46:43 in 1 · <1
      #81     20:39:28 in 8 · 20:39:38 in 1 · 20:39:48 in 6 · 20:40:18 in 5 … 20:43:23 in 5 · 20:43:53 in 4 · 20:45:03 in 3 · 20:45:23 in 1 · 20:45:38 in 3 · 20:46:38 in <1
#309  master  21:26:47 in 7 · 21:27:07 in 5 · 21:27:23 in 4 · 21:27:57 in 1 · 21:28:17 in <1
      #81     21:25:52 in 5 · 21:26:47 in 1 · 21:26:57 in 5 · 21:27:07 in 4 · 21:27:17 in 5 · 21:27:52 in 1 · 21:28:02 in <1 · 21:28:22 in 1 · <1
```

### Second cut, `e02f442` — standing is the clock, not the flag

The client now remembers the last published `(stop, at_stop_since)` per bus
on the `AnchorStore` it is passed and keeps pricing `median(stand − r | stand
> r) + drive` while the bus is within 125 m of that stop; the run log states
`anchorStore passed to computeUpcomingArrivals = yes (one Map per rider
cohort, 8th argument)`, so the memory engaged. Paired against master
`3e56f03`, same 9,470 riders, same patch:

| chain (657 watching riders) | master | #81 @0923c0a | **#81 @e02f442** |
|---|---|---|---|
| raw rise beyond the clock at the departure poll, p50 / mean | +220 / +196 s | −123 / −146 s | **+3 / +3 s** |
| riders ≥180 s on the departure poll | 330 | 40 | **4** |
| largest drift in [T−5 s, T+30 s] (release lands a poll later): p10 / p50 / p90 | −170 / +70 / +430 s | −170 / +10 / +190 s | **−110 / 0 / 0 s** |
| … riders with \|drift\| ≥180 s in that window | 352 | 180 | **39** |
| … ≤ −120 s / ≥ +120 s in that window | 93 / 313 | 82 / 183 | **55 / 12** |
| stranded at 146 / 49 / 48 | 54% / 58% / 44% | 34% / 38% / 38% | **0% / 23% / 33%** |
| jump ≥180 s at 146 / 49 / 48 | 61% / 66% / 67% | 34% / 47% / 32% | **0% / 25% / 31%** |
| reversal ≥60 s at 146 / 49 / 48 | 74% / 73% / 74% | 64% / 58% / 56% | **1% / 11% / 16%** |
| chain strands, paired (both / only master / only #81) | | 54 / 141 / 88 | **41 / 154 / 39** |
| chain jump ≥180 s, paired | | 136 / 298 / 91 | **92 / 342 / 50** |
| promise error 60 s before departure, p50 / p90 pessimistic | +5 / +215 s | | **+10 / +140 s** |
| longest run of one first figure in the 4 min before departure, p50 / p90 | 40 / 125 s | | 40 / 114 s |
| first-promise miss, chain, p10 / p50 / p90 | −270 / −50 / +80 s | −190 / −25 / +111 s | −190 / −25 / +111 s |

| Red focus (6,097 scored) | master | #81 @e02f442 |
|---|---|---|
| jump ≥180 s / ≥300 s | 39.1% / 26.3% | **25.0% / 18.7%** |
| reversal ≥60 s | 49.4% | **24.1%** |
| strand | 12.4% | **10.0%** |
| first promise \|miss\| median, bus >60 s earlier than promised | 70 s, 33.3% | 54 s, 28.1% |
| paired jump ≥180 s: fixed / introduced | | 1,660 / 569 |
| paired strand: fixed / introduced | | 486 / 281 |
| paired reversal ≥60 s: fixed / introduced | | 2,225 / 266 |
| worst drift per wait: improved / worsened / same | | 3,412 / 2,319 / 1,927 |

| hold-out (uniform) | master | #81 @e02f442 |
|---|---|---|
| Green jump ≥180 s / strand | 64.1% / 28.1% | **66.7% / 34.8%** |
| Purple jump ≥180 s / strand | 62.0% / 35.4% | **73.0% / 40.5%** |
| Purple jumps ≥180 s, paired: introduced / fixed | | 51 / 10 |

Read plainly:

- **The departure cliff on the 344 Winchester chain is gone.** +220 s → +3 s
  at the median, 330 → 4 riders seeing ≥180 s on the poll itself, 352 → 39 in
  the 35 s window that also catches the one-poll-later release. Winchester /
  Division, one hop out, goes from 54% stranded / 74% reversals to 0% / 1%.
- **Strands fall, they do not vanish.** Chain: 154 fixed, 39 introduced.
  Red as a whole 12.4 → 10.0%, but 281 riders are newly stranded, 183 of them
  at Division / Sheffield and Division / Prospect (stops 2 and 3 of the
  chain), and 157 of the 207 Red-only new strands have the same shape: a
  first figure of 4 min or more collapsing to ≤1 min. That is the conditional
  median doing what it says — the remaining stand is ~2 min until the instant
  the bus leaves — and then the drive-only price landing 5–10 s after the flag
  clears. The plateau itself does not cost: 60 s before departure the shown
  number is +10 s pessimistic at the median against +5 s on master, and its
  p90 pessimism is *lower* (140 vs 215 s); the longest run of an unchanged
  figure before departure is the same 40 s median. The remaining strands are
  the release, not the plateau.
- **The bus still beats the first promise for 46% of chain riders by more than
  a minute** — the same share as master (the p10 miss improves −270 → −190 s,
  the median −50 → −25 s). Part of the 344 Winchester layover is `hold` on
  the inbound leg for buses parking beyond 75 m (the derivation's own
  caution), and the split only prices what lands inside the radius.
- **The hold-out regressed**, on thin tables: Green 19 of 23 stops carry a
  `q` with n as low as 1 (p10 n = 2); Purple 10 stops, and the introduced
  jumps (51 against 10 fixed) sit at the West Campus fold — Building 750 (24),
  which has no `q` at all, West Haven Train Station (127), Building 600 (23),
  Building 900 (26). Whether that is the pricing or the tables cannot be told
  from one day of Green/Purple departures; it is the section a Red-tuned
  merge must not ignore.

Named riders, e02f442 (canary origin), 5 s cadence:

```
#316  20:39:28 in 8 · 20:39:38 in 6 · 20:40:18 in 5 · 20:41:33 in 4 · 20:41:43 in 5 · 20:42:23 in 5 · 20:43:53 in 4 · 20:45:03 in 3 · 20:45:23 in 3 · 20:46:53 in <1 · 20:47:13 now       (arrival 20:47:18; no flash, no strand)
#304  20:58:03 in 6 · 20:58:38 in 5 · 20:59:48 in 4 · 21:00:03 in 5 · 21:01:03 in 5 · 21:01:28 in <1 · 21:02:03 now                                                                  (arrival 21:02:08; strand, −230 s)
#309  21:25:17 in 6 · 21:25:52 in 5 · 21:27:07 in 4 · 21:27:17 in 5 · 21:28:12 in <1 · 21:28:22 in 1 · 21:28:27 in <1 · 21:28:37 in 1 · 21:28:57 in <1 · 21:29:17 now             (arrival 21:29:22; strand, −235 s)
```

Files: `scripts/.eta-replay/red0903-{master,pr81,pr81b}.{json,waits.jsonl}`,
`acc-{master,pr81,pr81b}-red.json`, `patch-pr81-pinned.json`.

## What the simulation cannot see

It replays the *arithmetic*, not the rendering. It cannot see a card reorder
(Brown's third-row-to-last), a missing explanation line, a layout bug, a
countdown hidden behind "Show N more routes", or the sub-poll `remainingSec`
tick between polls. It does not model a rider walking. **The canary remains
necessary**; this instrument tells it where to stand.

Two approximations to keep in mind when a level differs by a minute:

- **Calibration phase.** Production recalibrates every 5 min from process
  start (and a deploy restarts the phase), so the served tables lag the ET hour
  boundary by an unknown 0–5 min; the replay rolls on the hour. `CALIB_LAG_MIN`
  is a sensitivity knob. At a garage layover stop the windowed dwell median can
  sit within seconds of the catchability boundary for a rider a long walk away,
  so this alone can move a "now" by minutes.
- **Detector age.** Production's detector state is as old as the last deploy.
  On a day with twenty deploys that matters; `DETECTOR_FROM` models it, and
  the deploy log (`gh run list --workflow deploy.yml`) says when.
