# The IMM estimator: plan, predictions, and what it is allowed to change

**Status: the plan and its predictions, written and committed BEFORE any of it
was measured (2026-09-04, branch `eta/kalman-imm`, baseline `origin/master`
1617c92).** The predictions below are here so that the result — win, wash or
loss — cannot be reinterpreted after the fact. `docs/eta-estimator-design.md`
is the specification; this file is the build and measurement plan for it, and
the results section at the end is filled in from the paired runs.

## What is being built

The Gaussian-sum IMM the design names, as a pure module (`web/src/estimator.ts`)
behind `computeUpcomingArrivals`' existing signature, its state in a `WeakMap`
keyed on the caller's `AnchorStore` exactly as `hopPricing.ts` keys its
standing memo. No new store, no module-level state, no change to any call site.

Three pieces, in the order they matter:

1. **A branch posterior instead of a point anchor.** `findRouteAnchor` picks
   one leg out of the candidate set; where two candidates run anti-parallel
   (the folds, and the (N)/(S) twins) that choice is decided by centimetres.
   The estimator keeps at most two hypotheses with weights, from the
   perpendicular residual, the direction of travel over the last two distinct
   fixes (PR #86's rule, as a likelihood rather than a filter), and
   `last_stop_id` — the last of these only on the poll its reading CHANGES,
   because a stale reading held across a 5 km run is one observation, not a
   hundred.
2. **An IMM over {standing, running}** with the measured hazards, updated by a
   **Tobit (Type I censored) step on a repeated fix**: the feed publishes a new
   coordinate only past ~30 m, so a repeated fix is not "no data", it is the
   observation `displacement < 30 m`. That is what moves weight to standing
   without an EMA's manufactured motion.
3. **A mixture output.** Each hypothesis is priced by the arithmetic already in
   `arrivals.ts` — the same stand/drive split, the same credit, the same
   proration, the same downstream hops — and the reported `eta` is the median
   of the mixture, `low`/`high` its 16th/84th percentiles. Nothing about how a
   hop is priced changes; only which leg, and how sure.

The mixture median is the reason to expect anything at all. With one
hypothesis it is master's number exactly. With two well-separated hypotheses at
weight w it moves **continuously in w** — at 50/50 it sits above the near
branch's own upper tail, and it returns to the near branch's median as w → 1.
So a belief that shifts over three polls produces a number that moves over
three polls, where a point anchor flips a third of a lap in one. That is not a
slew limiter: nothing is damped in TIME, and a bus that provably leaves still
collapses the number in the same poll, because the evidence moves the weight in
that poll.

## Predictions, before the measurement

Written ex ante. I expect this to be a small win at best, and I expect the
largest part of the value to be a negative result plus one enabling fact.

1. **Red and the 344 Winchester chain: no change worth having.** PR #81/#85
   already price the first hop from the stand/drive split, which is the rest
   term the IMM's standing mode reduces to, and Red has no fold. I predict the
   departure-poll rise stays within a few seconds of +1 s and the chain strand
   shares move by less than 3 points in either direction. Red's 27.5% of
   anti-parallel polls are within 100 m of a stop (82.6% of them), where the
   two hypotheses price almost identically, so the mixture should be nearly
   invisible there.
2. **Green and Purple: the pin and the lap, not the strand.** The population
   this exists for is 42.8% of Purple's ambiguous polls and 23.2% of Green's.
   I predict the visible movement is in **pin change** (Purple 44.1%, Green
   39.4%) and **lap re-price** (16.7% / 8.5%) rather than in strand, because a
   cold-start coin flip that commits and is then held by the gate is exactly
   what produces a pinned vehicle a lap out of position. I predict strand moves
   by less than 5 points, and I am genuinely unsure of the sign.
3. **The freeze metric is where this most likely dies.** A mixture is a
   smoother by construction, and an arm that "wins" by going quiet has already
   been rejected once at 44.7% frozen polls. I will check the freeze split —
   by whether the raw fix moved — before I look at any jitter number, and if
   frozen-while-moving rises materially above master's 16.5% I will call the
   arm failed whatever else it shows.
4. **The departure poll is the second way it dies.** A branch lock at a
   departure was 10.3% of departures over 300 s late and p99 +4,989 s on an
   earlier arm. The mixture is meant to make that impossible — a locked branch
   holds weight, it does not hold the answer — but "meant to" is not a
   measurement, so the departure cohort is scored second, before anything else.
5. **The enabling fact may be worth more than the filter.** The calibrator
   withholds the stand/drive split from Green and Purple (`splitWithheldRoutes`)
   for a structural reason: one stop id carries two different passes of a
   repeated stop, so its stand table is pooled over a layover and a
   pass-through. A branch posterior is exactly what says which pass a bus is
   on. If the mixture resolves the fold, the split can be served there, and on
   Red that split was worth +220 s → +1 s at the departure poll. I predict this
   is the larger prize and that it is NOT reachable in this pass, because the
   derivation that produced the tables inherits the detector's anchor and would
   have to be re-derived per occurrence first.

**Summary of the prediction: no better than master on Red, a measurable but
small improvement in the fold routes' pin-change and lap-re-price shares, no
improvement in strand, and a real risk of failing the freeze check.** If that
is what the numbers say, the recommendation will be to not ship the estimator
and to spend the next pass on occurrence-keyed stand tables instead.

## How it is measured

Instrument: `scripts/eta-replay/rider-sim/run.ts`, run from a pristine
`origin/master` worktree so the harness itself is fixed, with `CLIENT_ROOT`
switched between that worktree (baseline) and this branch (candidate). Same
capture (`~/shuttle-captures/positions-20260903.jsonl`), same snapshot
(`store/snap3.db`, 21:34 ET), same seedless population, so the two runs pair
wait for wait through `--compare`.

`PAYLOAD_PATCH` carries the stand/drive split into the replay, because the
offline calibration in `common.ts` predates PR #85 and serves neither `q` nor
`drive`. `scripts/eta-replay/split-patch.mjs` builds it from
`docs/data/departure-tables-2026-09-03.json` on the same `pinned` clock and the
same allowlist the calibrator uses (Red 3, Blue Day 1), and reproduces PR #85's
own validation figures at 344 Winchester (q p5/p95 = 118/598 over n = 24,
drive 15 s over n = 25). Both arms get it.

Order, deliberately: the freeze split first, the departure poll second, then
the chain cohort, the named riders #316/#304/#309, Red overall, and last the
Green/Purple hold-out where the case actually lies.
