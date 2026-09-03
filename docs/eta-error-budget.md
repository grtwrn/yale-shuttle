# The ETA error budget, and why the fix is stability rather than accuracy

**Status: investigated. One thing recommended for building, several things
deliberately not built.** Measured 2026-09-03 against a production snapshot:
75,003 `raw_positions` (09:51–16:22 ET, 21 buses, 8 routes running), 359,296
`segments` and 561,453 `arrivals` over 90 days.

Scripts: `services/shuttle-v2/scripts/eta-replay/` — `hop-anatomy.ts`,
`traffic-variance.ts`, `eta-budget.ts`, `eta-stability.ts`,
`progress-filter.ts`. Read `docs/eta-accuracy.md` and `docs/bus-speed.md`
first; this extends both and overturns part of the framing of both.

---

## The correction that reframes the whole thing

This investigation started as "decompose the ETA error budget so a model can
be aimed at the term that dominates". It answered that. Then the operator said
what they actually wanted:

> "i'm not worried about a few seconds. i'm worried about saying a bus is
> 10min away and then a few seconds later dropping to 1 second."

**The product problem is stability, not accuracy.** Every measurement on this
project — `docs/eta-accuracy.md`, the 28 estimator variants, the ETA specialist's
work, and the first half of this document — optimises median absolute error
against truth. Nobody had measured what a rider actually experiences, which is
the *sequence* of numbers shown for one bus and stop over successive polls.

A prediction that is 40 s off but ticks down smoothly is a good product. One
that is 5 s off on average and jumps 10 min → 1 min between two polls five
seconds apart is a broken one, and it discredits every other number on screen.

That reframing also rescues the operator's original instinct. They asked for a
smooth state estimator; the error-budget answer below says a motion model is
worth 4.6% of the *accuracy*, and on that basis I would have told them not to
build it. **Judged on stability that reasoning is wrong**, because smoothing is
not a means to an accuracy gain — smoothing IS the deliverable. What the
measurements below still change is *where* the smoothing belongs.

---

## Two facts about the data that were not known

### `arrivals.dwell_sec` is misnamed: it is anchor residence time, not standing time

`segments.travel_sec` and `arrivals.dwell_sec` **are the same number**.
`detector.ts` computes one `elapsedSec` per anchor transition and emits it
twice — as the dwell event for the stop being left and as the segment event for
the hop being completed. Joining the two tables to split dwell from drive
returns "drive = 0 s, dwell = 100% of every hop": arithmetically correct,
semantically vacuous.

Verified on the snapshot: **97.6% of 29,179 joined rows are byte-identical**
(the residual 2.4% are mis-joins, not disagreements).

So `dwell_sec` is the time a stop spent as the bus's *anchor* — arrival at A to
arrival at B — which includes the drive from A toward B. It is not standing
time, and there is no dwell/drive split anywhere in the schema. Any such split
must be re-derived from `raw_positions`, which retains only 6 hours.

This was found independently the same day by a second engineer auditing PR #40,
whose arithmetic rested on the opposite premise and which was reverted for
making ETAs 9 s worse. Two derivations from opposite directions.

### The feed has a ~30 m position deadband

Upstream reports a new coordinate only once the vehicle has moved about 30 m.

| | |
|---|---|
| Distinct fixes measured | 33,118 |
| Displacements below 28 m | **2 (0.01%)** |
| p1 / p10 / p50 of displacement | 30.1 m / 30.7 m / 35.0 m |
| Floor at Δt = 5 s / 6–10 s / 11–20 s | 30.0 m / 30.1 m / 30.0 m |

The floor is **constant in metres, not in speed**. If buses simply never crept,
the floor would scale with elapsed time — 30 m at 5 s would be 60 m at 10 s. It
does not move. Coordinate rounding is ruled out: 6 decimal places dominate and
the sixth digit is uniform.

The discriminating test: after a freeze of *any* length, including over two
minutes, the first displacement is p10 = 30.3 m, p50 = 31.8 m. A bus pulling
away from a genuine standstill would show a small first step. It never does.

Three consequences:

1. **A repeated fix is not noise and not missing data.** It is a *censored
   observation*: |Δx| < 30 m, which is an upper bound on speed, and it is the
   single most informative signal for "is this bus standing". While a bus is
   genuinely still, 99.2% of consecutive fixes are byte-identical and the
   still-run radius is a median of 0 m — the receiver does not wander, it holds.
2. **This explains why the 2026-09-02 Kalman test failed.** That test used
   predict-without-update, correctly implemented (the time base advanced only
   on accepted fixes, with q·dt³/3 covariance growth — not a dt bug). It fails
   structurally: a constant-velocity predict step cannot revise velocity
   downward, so the filter coasts at its last speed through exactly the
   interval that proves the bus stopped. Its false-stop rate was the lowest of
   all eight estimators tested — it *cannot* learn to call a bus stopped.
3. **Inertia is unobservable, and here is the number.** The smallest measurable
   displacement is 30 m, so at 5 s polling the velocity quantum is 6 m/s ≈
   13 mph. A bus reaching 20 mph from rest covers ~45 m — one or two fixes.
   There is no acceleration signal to fit, so a model with mass and inertia has
   nothing in this feed to estimate them from. This is a statement about what
   the sensor can see, not about whether vehicle dynamics matter.

---

## Where a hop's time actually goes

Replaying the production detector over every raw position recovers hop
boundaries exactly as production drew them; each 5 s tick inside a hop is then
classified as **dwell** (stationary within 75 m of the origin stop), **hold**
(stationary elsewhere — signals, queues, off-stop layovers) or **drive**.
"Stationary" is a run of ≥15 s inside a 25 m ball, *not* "coordinate
unchanged", which would call a moving bus stopped a fifth of the time. Three
cases were hand-checked against raw tracks and all three confirmed.

2,571 hops:

| | share of seconds | share of **within-segment** variance |
|---|---|---|
| dwell (at the stop) | 40.1% | **72.5%** |
| hold (stopped elsewhere) | 14.9% | **22.4%** |
| driving | 45.0% | **5.1%** |

Within-segment sd is 71.7 s. "Within-segment" means deviation from each
(route, from, to) group's own mean — the residual an estimator still faces
*after* it has looked up the segment, which is the only part it can be blamed
for.

Swept across the full parameter grid (radius 15/25/40 m × duration 10/15/25 s),
**standing is 94.3–98.8% of the variance and driving 1.2–5.7%.** The time share
moves a lot across that grid (47–77% standing); the variance conclusion does
not move at all.

The hand-checked cases are worth stating because they are the operator's
"bus dwelling at a different stop": a Gold bus sat 171 m from Union Station (N)
for 15 minutes with a frozen coordinate — genuinely standing, but outside the
75 m radius, so it is *hold*, not *dwell*, and no stop-level dwell statistic
sees it.

### Traffic explains less than it looks like

Over 90 days and 345,796 plausible segment samples, of the variance *within*
one (route, from, to) group:

| conditioning | R² | ω² |
|---|---|---|
| hour of day | 19.4% | 18.8% |
| (day of week, hour) | 25.2% | 22.2% |
| peak flag | 4.3% | 4.2% |
| day of week | 2.2% | 1.9% |
| weekend flag | 1.0% | 1.0% |
| **randomised 24-bin control** | **1.8%** | **0.3%** |

The calibrator already conditions on weekday and hour ±1, so most of that is
already spent.

And the hour effect is mostly **not congestion**. For a typical segment the
hourly p10 — the fastest trips, a bus that stopped for nobody — moves only
**5.2 s** across the day, while the hourly p90 moves **11.9 s**. If rush hour
were slowing the *driving*, the floor would rise with the ceiling. It barely
does. (Medians across 202 segments; the means, 18.7 s and 45.6 s, are dragged
by a handful of layover segments.)

---

## The accuracy budget (secondary, but it is what a motion model competes for)

Predictions made at each hop boundary, chains of 5 contiguous hops, n = 10,275,
scored against the detector's own arrival — the quantity hop times sum to, so
`perfect everything` scoring exactly 0 is the proof that the plumbing is right.

| | overall median | k=1 | k=3 | k=5 |
|---|---|---|---|---|
| shipped (sum of served values) | 41.4 s | 19.2 | 45.7 | 72.4 |
| **perfect standing** | **12.0 s** | 6.7 | 13.0 | 18.8 |
| perfect driving | 38.8 s | 19.8 | 43.1 | 63.4 |
| perfect *next hop entirely* | 24.2 s | 0 | 32.4 | 60.6 |
| **perfect motion model** | **39.5 s** | 19.8 | 43.9 | 68.5 |
| perfect everything | 0 s | 0 | 0 | 0 |

- Perfect knowledge of standing removes **71%** of the median error.
- Perfect knowledge of driving removes **6%**.
- **A perfect motion model is worth 1.9 s of 41.4 s — 4.6%.** That row gives a
  filter perfect knowledge of the driving time on the current hop and nothing
  about how long any driver chooses to stand, now or later, which is the most a
  motion model can ever know.

For anchoring: a perfect anchor is worth 98.5 → 92.5 s median over 350k
observations, and anchor disagreement affects 9.5% of them, tripling their
error (291.9 vs 89.5 s), concentrated on Green 35%, Purple 21%, Pink 10%.

**Hold that last figure.** It is the number that led me, and led the review, to
expect anchoring to dominate the stability problem. It does not. See below.

---

## Stability: the measurement nobody had made

For each (bus, stop) followed across consecutive 5 s polls, the metric is the
drift of the **predicted arrival instant** A(t) = t + eta(t). A well-behaved
countdown holds A constant and ticks the displayed number down by the poll
interval; a lurch is A moving. `jump = A(t') − A(t)`, in seconds — exactly
"change in eta, corrected for elapsed time".

Two series, because pin flapping produces the symptom with no estimator error
at all: **perBus** (one bus at one stop — isolates the estimator) and **board**
(the soonest arrival at a stop across all buses — what a rider reads off a stop
card).

Baseline, 1,589,494 perBus transitions and 521,060 board transitions:

| | perBus | board |
|---|---|---|
| \|jump\| p50 / p90 / p99 / p99.9 | 4.9 / 23.4 / 305.6 / 3489.1 s | 4.9 / 25.5 / 528.5 / 2425.1 s |
| displayed countdown went UP | 8.5% of polls (rise p90 130 s) | 8.6% (rise p90 369 s) |
| jumps ≥ 300 s | **16,025 (1.0%)** | **7,554 (1.4%)** |

Attributed causes of the catastrophic jumps:

| perBus | | board | |
|---|---|---|---|
| anchor flip | **9,586 (60%)** | pin switch | **5,082 (67%)** |
| lap wrap (bus passed the stop) | 3,290 (21%) | anchor flip | 1,317 (17%) |
| at-stop change | 2,700 (17%) | at-stop change | 795 (11%) |
| feed movement | 445 (3%) | lap wrap | 227 (3%) |
| re-price | 4 (0.02%) | re-price | 3 (0.04%) |

By route, big jumps track the anchor-disagreement routes exactly: Green 2.7%,
Blue Weekend 2.7%, Purple 2.5%, Pink 1.0% against Blue Day 0.4%, Orange Day
0.4%.

Of the board's 5,082 pin switches, 2,544 (50%) are legitimate — the bus you
were watching pulled in and the card moved to the next one. **2,202 (43%) are
genuine swaps of a bus that was still more than five minutes out.** That is
0.42% of all board transitions and it is the closest match in the data to the
operator's complaint.

---

## What I built, and how it lost

A 1-D route-progress filter with an explicit standing/running mode
(`progress-filter.ts`): state is (progress along the loop in metres, speed,
P(standing)), the mode is a two-state HMM whose emission is the censoring
bound — a repeated fix is evidence for standing in proportion to how long it
has been repeating, because |Δx| < 30 m gets harder for a running bus to
satisfy as time passes. All parameters measured, not chosen:

| | |
|---|---|
| P(frozen \| standing) | 0.9191 (n = 39,319) |
| P(frozen \| running) | 0.1585 (n = 35,576) |
| P(run → stand) per second | 0.01612 (2,886 transitions / 178,999 s) |
| P(stand → run) per second | 0.01457 (2,884 transitions / 197,986 s) |
| mean standing / running spell | 68.6 s / 62.0 s |

The filter emits a smoothed position on the route polyline, which is fed to the
**unmodified** `computeUpcomingArrivals`, so everything downstream is real
client code. Arms: `filterPos` (filtered position only), `filterFull` (adds the
filter's own standing mode), and `detAnchor` — a ceiling arm that hands the
client the *server detector's* stateful anchor, which the browser does not
have, to bound what any anti-teleport scheme could achieve.

| arm | p90 | p99 | p99.9 | jumps ≥300 s | board ≥300 s | genuine swaps | accuracy median |
|---|---|---|---|---|---|---|---|
| shipped | 23.4 s | 305.6 s | 3489 s | 16,025 (1.00%) | 7,554 (1.4%) | 2,202 | 188.3 s |
| filterPos | 23.2 s | 376.4 s | 3487 s | 17,861 (1.12%) | 8,158 (1.6%) | 2,329 | 188.2 s |
| filterFull | **17.7 s** | **257.2 s** | 3473 s | 15,219 (0.96%) | 6,884 (1.3%) | 1,890 | 206.2 s |
| detAnchor (ceiling) | 22.2 s | 283.9 s | 3467 s | 15,281 (0.96%) | 7,460 (1.4%) | 1,904 | 182.9 s |

**It loses, and the reason is the finding.** The filter suppresses anchor flips
by 84% — 9,586 down to 1,519 — and the catastrophic jump count *does not fall*.
The jumps are conserved and simply re-labelled: "feed movement" goes 445 →
8,054 and "at-stop change" 2,700 → 6,408. Removing the anchor flip does not
remove the lurch; it moves it.

The ceiling arm settles it. Handing the client a perfect stateful anchor — the
server's own, flip-resistant, production-proven — takes catastrophic jumps from
1.00% to 0.96%. **The entire anchoring theory is worth 4% of the catastrophic
jumps, not the 60% that cause-attribution suggested.**

That is the number that would have talked me out of my own conclusion, and it
did. Attribution is not causation: "anchor flip" was the *label* on a
relocation, not its cause. Any scheme that relocates a bus, or changes its
at-stop status, produces the same lurch, because the ETA is recomputed from
scratch every poll by a function with no memory. Change the input however you
like and the discontinuities survive.

`filterFull` — the standing mode, the part the review correctly predicted would
matter more than motion — is the only arm that helps at all: p90 −24%, p99
−16%. It costs 18 s of median accuracy and raises the share of polls where the
ETA does not move at all from 32.4% to 49.5%, which is partly stabilising by
going stale. Not worth shipping on that trade.

---

## What wins: constrain the output, not the input

Since every input-side intervention leaves the jump count intact, the
intervention belongs on the output. A rate limiter on the predicted arrival
instant — it may move at most N seconds per poll, released once the bus has
effectively arrived (eta < 30 s):

| MAX_SLEW | p50 | p90 | p99 | p99.9 | jumps ≥300 s | board ≥300 s | countdown UP | rise p90 | accuracy median | mean signed | ETA frozen |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped | 4.9 s | 23.4 | 305.6 | 3489 | 16,025 (1.00%) | 7,554 (1.4%) | 8.5% | 130 s | 188.3 s | +184.9 s | 32.4% |
| 10 s | 10.0 | 10.0 | 10.0 | 41.3 | 366 (0.02%) | 411 (0.1%) | 60.0% | 5.1 s | 284.6 s | −354.5 s | 10.4% |
| 20 s | 10.8 | 20.0 | 20.0 | 52.1 | 438 (0.03%) | 550 (0.1%) | 37.2% | 15.1 s | 205.2 s | **−7.4 s** | 19.1% |
| 30 s | 5.1 | 30.0 | 30.0 | 56.6 | 555 (0.03%) | 665 (0.1%) | 28.5% | 25.1 s | 195.5 s | +73.0 s | 22.7% |
| **45 s** | **5.0** | **45.0** | **45.0** | **62.4** | **748 (0.05%)** | **837 (0.2%)** | **22.2%** | **40.1 s** | **191.0 s** | +119.1 s | 25.5% |

At 45 s per poll: **catastrophic jumps fall 95% (16,025 → 748), p99.9 falls
from 3,489 s to 62 s, and the accuracy cost is 2.7 s of median** (188.3 →
191.0). At 20 s per poll the reduction is 97% and the mean signed bias is
almost perfectly corrected (+184.9 → −7.4 s), for 17 s of median.

It is **not** stabilising by freezing. The share of polls on which the ETA does
not move at all *falls* — 32.4% shipped to 25.5% at 45 s and 19.1% at 20 s. The
number moves more often, just by less. A 10-minute correction still lands
in full; it takes 14 polls instead of one.

The cost is real and must be stated: the displayed countdown ticks *up* more
often (22% of polls at 45 s against 8.5% shipped), because a slow catch-up
climbs in small steps instead of jumping once. But the size collapses — p90 of
the rise 40 s against 130 s. "5 min then 6 min" instead of "5 min then 16 min".

**Note on the accuracy column**: 188.3 s is the median over *every* stop on the
route including stops a full lap away, so it is not comparable with the 41.4 s
and 103.6 s figures elsewhere in this document. It is a paired guard rail — all
arms are scored identically — not an absolute.

---

## Smoothing the GPS (EMA) — measured, and it fails the operator's test

The operator asked whether EMA on the raw positions was worth doing before a
Kalman filter. Measured as an arm on the same board, exponential smoothing of
lat/lon with a time constant, before anchoring:

| arm | jumps ≥300 s | vs shipped | twitch | **eventless** | folding routes | accuracy median | frozen |
|---|---|---|---|---|---|---|---|
| shipped | 16,128 (1.0%) | — | 7,047 | **437** | 2.2% | 160.4 s | 32.5% |
| EMA τ=15 s | 14,634 (0.9%) | −9% | 4,908 | **1,394** | 1.8% | 162.6 s | 19.3% |
| EMA τ=30 s | 16,418 (1.0%) | **+2%** | 5,826 | **3,181** | 2.0% | 165.5 s | 19.6% |
| corroborated anchor | 12,881 (0.8%) | **−20%** | 3,289 | 379 | 1.6% | 161.7 s | 33.6% |
| both | 13,903 (0.9%) | −14% | 3,024 | 1,894 | 1.5% | 166.3 s | 21.0% |

**It makes the eventless population three to seven times worse.** That was the
prediction to check — smoothing should have done *nothing* to jumps where the
GPS fix is byte-identical, because `last_stop_id` is the cause — and the
measurement says the opposite, for a reason worth keeping: a smoothed position
keeps converging on polls where the raw fix has not changed. EMA therefore
manufactures anchor movement out of **zero new sensor information**. It is not
merely that smoothing invents a position the bus was never at; it invents
*motion* on polls that carry no observation at all.

**And it delays departures, which is disqualifying on its own.** Measured
across every real departure in the window (the collector's `at_stop_id` going
non-null → null), as the arm's ETA minus production's in the following 60 s:

| arm | median | p90 | polls later than production |
|---|---|---|---|
| corroborated anchor | **0 s** | **0 s** | **0.8%** |
| EMA τ=15 s | +1.5 s | +29.8 s | **44.8%** |
| EMA τ=30 s | +14.8 s | +61.9 s | **58.3%** |
| both | +15.4 s | +63.8 s | 59.0% |

EMA is the rate limiter moved upstream: the same indiscriminate damping, now
applied to the input, with the same inability to tell a real move from a
quantisation step. It withholds the 5 → 1 on nearly half of all departures.
Rejected on the operator's own criterion.

It also adds nothing on top of corroboration — the combined arm is *worse* than
the gate alone (−14% against −20%) and inherits the departure lag.

**What this implies for a Kalman filter.** EMA is the simplest member of the
family the operator was heading toward, and the two objections that sink it are
structural, not tuning: this feed's error is a 30 m deadband rather than
Gaussian noise, so there is nothing for a smoother to average away, and any
smoother that produces a position estimate on an observation-free poll will
invent movement. The mode-switching filter already tested here cut anchor flips
84% and did not move the catastrophic tail. Read `docs/bus-speed.md` too: a
30 s trailing window already beat a constant-velocity Kalman on this feed.
Nothing measured here disagrees with that document.

## What shipped: the corroborated anchor

`web/src/anchorGate.ts`. The anchor may only relocate the bus when something
corroborates the move:

- **`at_stop_id` changed** — the collector says the bus arrived or departed.
  Releases in the SAME poll, which is what keeps 5 → 1 instant.
- **the move is consistent with ground covered** — the raw anchor may advance
  as far along the sequence as the distance travelled can account for, one hop
  per `ANCHOR_M_PER_HOP` (120 m), and the first hop is not free: it needs at
  least one 30 m deadband step of real displacement.
- **`last_stop_id` changed AND the bus moved** — kept as an input, because
  withholding it was measured and is worse (16,128 → 24,986), but required to
  be corroborated rather than obeyed.
- otherwise the previous anchor is held, for at most 5 minutes.

Displacement is measured **net, from where the anchor was last accepted**, not
as path length. A parked bus twitching 38 m back and forth accumulates
unlimited path while never leaving a 40 m circle, so a cumulative measure would
open the gate on precisely the population the gate exists to reject. There is a
test for that.

Measured (1.59 M transitions, one weekday):

| | shipped | gated |
|---|---|---|
| jumps ≥ 300 s | 16,128 (1.00%) | **12,881 (0.80%) — −20%** |
| twitch jumps | 7,047 | **3,289 — −53%** |
| eventless jumps | 437 | 379 |
| folding routes (Green/Purple/Pink) | 2.2% | **1.6% — −27%** |
| every other route | 0.5% | 0.5% |
| departure lag, median / p90 | — | **0 s / 0 s** |
| accuracy median / mean bias | 160.4 s / +106.9 s | 161.7 s / +111.7 s |
| ETA frozen | 32.5% | 33.6% |

It costs 1.3 s of median accuracy and 1.1 points of freeze share. The freeze
figure is the one to watch on any future change here: an arm that "wins" by
raising it is holding a stale number, which is how the first version of the
progress filter looked like a 97% win before a NaN in its geometry was found.

The named regression case, Red #309 (the canary bus that sat 400 m out, left,
and arrived 84 s later): across 189 polls covering three departures the gated
ETA is **identical to production at every departure poll**, and the anchor is
held on 2% of polls. `scripts/eta-replay/trace-departure.ts` replays it from
the captured corpus.

## Recommendation

**Build the output-side rate limiter. Start at 45 s per poll.**

The single number that justifies it: **catastrophic jumps fall 95%, from 16,025
to 748 out of 1.59 M transitions, for 2.7 s of median accuracy.** No input-side
change tested came within an order of magnitude of that, including a perfect
anchor.

Design notes for whoever builds it:

- It belongs where the ETA is rendered, per (bus, stop), and must release
  immediately once the bus has effectively arrived (eta < 30 s) or the number
  will defend a stale promise past the bus's arrival.
- Sweep the rate against both columns before fixing it. 20 s is best-calibrated
  on bias, 45 s is best on accuracy; anything below 20 s starts trading badly.
- It does **not** address board-level bus swapping — 2,202 genuine swaps of a
  bus still 5 min out survive every arm here (330 with the limiter, because the
  limiter blunts the jump rather than preventing the swap). That is a separate
  mechanism in `pickLiveArrival` and deserves its own investigation.

---

## What we did NOT build, and why

- **A constant-velocity Kalman filter over lat/lon.** Already refuted in
  `docs/bus-speed.md`; this document adds the mechanism. The feed's 30 m
  deadband means a repeated fix is a censored observation, and a CV predict
  step cannot revise velocity downward, so the filter coasts through the very
  evidence that the bus stopped.
- **Vehicle mass and inertia.** The velocity quantum is 6 m/s ≈ 13 mph at 5 s
  polling. Acceleration is below the sensor's noise floor by a wide margin.
  Nothing to fit.
- **A mode-switching route-progress filter.** Built and measured here. It works
  as designed — anchor flips down 84% — and buys nothing, because the jumps are
  conserved. Kept in the tree as `progress-filter.ts` for the measurement, not
  wired into anything.
- **Anti-teleport anchoring in the client.** The ceiling arm says a perfect
  stateful anchor is worth 1.00% → 0.96% of catastrophic jumps. Do not spend
  effort here on stability grounds. (It is still worth ~6 s of median accuracy,
  which is a different argument.)
- **Traffic modelling beyond the current (weekday, hour ±1).** Hour explains
  19.4% of within-segment variance against a 1.8% null, and the calibrator
  already uses it. The hourly p10 moves 5.2 s across the day: congestion is not
  moving the driving time much.
- **Anything keyed on `arrivals.dwell_sec` as standing time.** It is anchor
  residence time. PR #40 rested on that premise and was reverted.

## Limits of the measurement

- `raw_positions` retains 6 h, so the dwell/hold/drive split and every
  stability figure come from **one weekday, 09:51–16:42 ET**, 21 buses, 8 of 15
  routes. No morning peak, no evening, no weekend, no night routes, no bad
  weather. The 90-day figures (traffic variance) are not so limited.
- The stability harness scores every stop on a bus's route, including stops
  nearly a lap away, where a small anchor difference is a large ETA difference.
  Jump statistics are unaffected by this (they are differences); the accuracy
  guard rail is inflated by it and is only meaningful as a paired comparison.
- The slew limiter was measured by post-processing the shipped ETA stream, not
  by a client implementation. A real implementation has to decide what happens
  across a page reload and when a bus disappears from the feed; neither is
  modelled here.
- Ground truth for the accuracy guard rail is the detector's own arrival event,
  which fires roughly at the midpoint before the stop — about 25 s early
  relative to a rider's kerbside view.
- `predictions_log` is still empty. Nothing in production records what riders
  were actually told, so all of this is reconstruction. The single highest-value
  piece of instrumentation this project could add is to start logging served
  ETAs, at which point stability becomes directly observable rather than
  replayed.
