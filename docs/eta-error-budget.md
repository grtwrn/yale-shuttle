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

**Then the objective narrowed once more, and this is the version that matters.**
Smoothness is not the goal either:

> "I don't want a slew limiter. it can go 5->1 if it leaves early. but if it is
> jitter we need a fix."

A 5 min → 1 min collapse is *correct* when the bus really did pull out early —
that is information a rider standing at a stop needs immediately, and damping
it is withholding the truth to make a graph look better. So the objective is
neither accuracy nor smoothness but:

> **eliminate changes that no real-world event caused, and let real ones
> through instantly.**

That distinction is what the rest of this document is organised around, and it
is why an indiscriminate rate limiter — measured here, and effective at the
wrong thing — was rejected. It also rescues the operator's original instinct:
they asked for a state estimator with context about what we are tracking, and
the context that pays turns out to be *whether anything happened*, not vehicle
dynamics.

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

**Which code these numbers are of.** The scoreboard calls the real
`computeUpcomingArrivals` and the real `stepMany` from the worktree it runs in
— there is no replica anywhere in it (`gps-replay.ts`'s replica, which went
three commits stale, is not used). The baseline below is **commit d6aeba2**,
i.e. before PR #54 and PR #57. The post-fix figures are **commit 61f32ce**.

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

### Did today's two fixes solve it? Accuracy yes, jitter no

PR #54 (reverting #40's re-pricing) and PR #57 (the layover clock) replayed on
the same snapshot, d6aeba2 against 61f32ce, identical harness:

| | before (d6aeba2) | after (61f32ce) |
|---|---|---|
| \|jump\| p50 / p90 | 4.9 s / 23.4 s | 4.9 s / **20.0 s** |
| \|jump\| p99 / p99.9 | 305.6 s / 3489 s | 305.5 s / 3449 s |
| jumps ≥ 60 s | 3.6% | **3.0%** |
| jumps ≥ 120 s | 1.6% | 1.6% |
| **jumps ≥ 300 s** | **16,025 (1.00%)** | **16,128 (1.00%)** |
| board jumps ≥ 300 s | 7,554 (1.4%) | 7,468 (1.4%) |
| accuracy median / mean | 188.3 s / +184.9 s | **160.4 s / +106.9 s** |

Both fixes are real wins on **accuracy** — the median falls 28 s and the
pessimistic bias nearly halves — and they take the typical jump down 15%. They
do **not** touch the catastrophic tail: jumps over five minutes are unchanged
at 1.0%. Whatever causes the operator's "10 min then 1 min" is untouched by
either.

### Which jumps should never have happened

Reducing jump magnitude is the wrong objective. The operator's rule:

> "I don't want a slew limiter. it can go 5->1 if it leaves early. but if it
> is jitter we need a fix."

A 5 → 1 collapse is *correct* when the bus really did pull out early;
suppressing it withholds what a rider standing at a stop most needs. So every
jump ≥ 300 s was asked one question: between these two polls, did anything
actually happen to this bus? (16,128 jumps, commit 61f32ce.)

| | n | share | verdict |
|---|---|---|---|
| a detector arrival fired, or the at-stop flag flipped | 7,928 | 49.2% | **real — the ETA should move** |
| the bus moved ≥ 100 m | 716 | 4.4% | **real** |
| the bus twitched < 100 m | **7,047** | **43.7%** | jitter |
| the GPS fix was byte-identical | **437** | **2.7%** | jitter |

**46.4% of catastrophic jumps had no real-world event behind them** — 7,484
of 16,128, or 0.47% of all 1.59 M transitions. That is the first time this
population has been sized, and it is the only thing that should be suppressed.

The mechanism is the same in both jitter classes: **the anchor moved without
the bus meaningfully moving.**

- The twitch population displaces a median of **37.9 m** (p90 79.7 m, max 99 m
  by construction) — one or two steps of the 30 m deadband — and 6,259 of the
  7,047 are the anchor moving on GPS alone. It concentrates exactly where the
  route folds back on itself: **Green 3,319, Purple 1,929, Pink 648**, which is
  84% of it, against Blue Day 406 and Orange Day 206.
- All 437 eventless jumps have one cause: **the feed's `last_stop_id` advanced
  while the GPS fix was frozen.** `findRouteAnchor` reads `last_stop_id` to
  disambiguate a route that revisits a vicinity, so upstream's stop assignment
  can relocate the bus by a whole lap while its coordinate says it has not
  moved 30 m.

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

## Arm B (the rate limiter) was measured, then rejected — do not rebuild it

The numbers below are real and reproducible, and the arm is kept in
`eta-stability.ts` as a baseline. **It must not ship**, for a reason that is
better than the numbers:

> "I don't want a slew limiter. it can go 5->1 if it leaves early. but if it
> is jitter we need a fix." — the operator, 2026-09-03

A rate limit is **indiscriminate**. It cannot tell a spurious change from a
real one, so it damps both, and the 2.7 s of median accuracy it costs at
45 s/poll (17 s at 20 s/poll) is exactly that: real information arriving late.
The canary's post-fix trace makes the point concretely — Red #309 held 6–7 min
for three minutes while the bus sat 400 m away about to leave, then collapsed
to 1 min, and the bus arrived **84 seconds** later. The 5 → 1 was closer to
right than the steady number that preceded it. **The defect is the
steady-but-wrong number, not the correction.**

| MAX_SLEW | p50 | p90 | p99 | p99.9 | jumps ≥300 s | board ≥300 s | countdown UP | rise p90 | accuracy median | mean signed | ETA frozen |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped | 4.9 s | 23.4 | 305.6 | 3489 | 16,025 (1.00%) | 7,554 (1.4%) | 8.5% | 130 s | 188.3 s | +184.9 s | 32.4% |
| 10 s | 10.0 | 10.0 | 10.0 | 41.3 | 366 (0.02%) | 411 (0.1%) | 60.0% | 5.1 s | 284.6 s | −354.5 s | 10.4% |
| 20 s | 10.8 | 20.0 | 20.0 | 52.1 | 438 (0.03%) | 550 (0.1%) | 37.2% | 15.1 s | 205.2 s | **−7.4 s** | 19.1% |
| 30 s | 5.1 | 30.0 | 30.0 | 56.6 | 555 (0.03%) | 665 (0.1%) | 28.5% | 25.1 s | 195.5 s | +73.0 s | 22.7% |
| **45 s** | **5.0** | **45.0** | **45.0** | **62.4** | **748 (0.05%)** | **837 (0.2%)** | **22.2%** | **40.1 s** | **191.0 s** | +119.1 s | 25.5% |

It suppresses 95% of catastrophic jumps at 45 s/poll — **including the 53.6%
that were the app correctly reacting to a bus arriving, departing or moving.**
That is the whole objection in one number.

For the record, since it is the way this class of fix usually fails: it did
*not* stabilise by freezing. The share of polls on which the ETA does not move
at all falls (32.4% → 25.5% at 45 s, 19.1% at 20 s), and a ten-minute
correction still lands in full, over 14 polls instead of one. The arm was
sound; the objective was wrong.

**Note on the accuracy column**: 188.3 s is the median over *every* stop on the
route including stops a full lap away, so it is not comparable with the 41.4 s
and 103.6 s figures elsewhere in this document. It is a paired guard rail — all
arms are scored identically — not an absolute.

## Recommendation

**Suppress anchor changes that no movement corroborates. Do not rate-limit the
output.**

The number that sizes it: **7,484 of 16,128 catastrophic jumps — 46.4% — had
no real-world event behind them**, and in every one of them the anchor moved
while the bus did not. The twitch population moves a median of 37.9 m, which is
one step of a 30 m deadband, and swings the promise by a median of 22 minutes.

This is the *discriminating* fix the rate limiter was not: gate the anchor on
evidence rather than gating the output on time.

- Require an anchor change to be corroborated — by cumulative movement well
  past the deadband (the twitch population tops out at 99 m), or by a detector
  arrival or at-stop transition. A real departure releases it in the same poll,
  so 5 → 1 still happens instantly when the bus really left.
- `last_stop_id` must stay an input. Withholding it (`detAnchorPure`) makes
  things **worse** — jumps ≥300 s go 16,128 → 24,986 — because it is doing real
  disambiguation work where a route revisits a vicinity. The fix is to require
  corroboration before acting on it, not to ignore it.
- Validate on the replay before believing it. Two plausible interventions have
  already failed here: the progress filter conserved the jumps and merely
  re-labelled them, and the detector-anchor arm moved them 1.00% → 1.00%.
  Neither would have been caught by reasoning.

### Still open, and now the largest unexplained mechanism

**2,202 of the board's pin switches replace a bus that is still more than five
minutes out**, and no arm tested here changes that number (2,172 post-fix,
1,904 with a stabilised anchor). By the operator's definition a swap with no
real-world cause is jitter, and this is a separate mechanism living in
`pickLiveArrival`, not in the estimator. It deserves the same attribution
treatment this document gave the jumps.

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
- **An output-side rate limiter on the ETA ("slew").** Built, measured, and
  rejected by the operator on better reasoning than the numbers: it damps real
  corrections and spurious ones alike. Kept in `eta-stability.ts` as a
  baseline. See the section above before proposing anything shaped like it.
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
