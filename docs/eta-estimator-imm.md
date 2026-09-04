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

The baseline run reproduces the numbers the brief quotes, which is the check
that the harness is set up right before anything is compared to it: the chain's
departure-poll rise is **+3 s** at the median with **2 of 657** riders seeing
≥180 s of displayed drift, and the chain strand shares at Winchester /
Division, Division / Sheffield and Division / Prospect are **0 / 22.8 /
36.5%** — the brief's "0/22.8/36.5". 8,346 waits, 9,470 riders, identical
population in every arm.

---

## Arm A: the mixture median. Measured, and it is a loss.

Arm A priced the reported ETA as the **median of the mixture** — the summary
`docs/eta-estimator-design.md` names, chosen because it is continuous in the
branch weight where a point anchor is not.

**It is continuous in the weight and that is not enough.** With two branches a
lap apart the mixture median's *derivative* in the weight is enormous near an
even split: the median sits wherever the combined CDF first reaches 0.5, and
between two far-apart modes that crossing point races across the gap as the
weight passes 0.5. So every poll of ordinary evidence noise — a metre of
perpendicular residual, one censored update — moved the promise by minutes. A
rider at Court / Olive, on Red, watching arm A:

```
21:48:54 in 13, 35 min · 21:49:04 in 5, 35 min · 21:49:19 in 5, 31 min
21:49:39 in 5, 30 min  · 21:50:04 in 12, 30 min · 21:50:34 in 12, 29 min
```

Transition level (`belief-scoreboard.ts`, 2.58 M transitions, both arms run in
their own tree so `shipped` is the client under test; no split served, so this
isolates the anchor):

| | master 1617c92 | arm A |
|---|---|---|
| jitter (jumps ≥300 s, wraps removed) | 13,906 (0.54%) | **16,760 (0.65%)** |
| EVENTLESS jitter | 4,975 | **11,361** |
| frozen % / frozen while moving | 37.8 / 15.2 | 28.3 / 9.6 |
| accuracy median / bias | 169.4 / +73.8 | 167.3 / +73.5 |
| Green jitter rate | 1.92% | **2.63%** |
| Purple jitter rate | 0.90% | **1.58%** |
| Red / Pink / Orange Night jitter rate | 0.35 / 0.88 / 0.49% | 0.29 / 0.63 / 0.16% |

The freeze check — the first thing to look at, because an arm that wins by
going quiet has already been rejected once at 44.7% — **passes**: arm A freezes
*less* than master (28.3% vs 37.8%), so nothing here is bought by silence. It
is bought by movement, and the movement is wrong.

Rider level (`rider-sim`, 8,346 paired waits, master vs arm A):

| | master | arm A |
|---|---|---|
| Red: jump ≥180 s / strand / pin change | 23.9 / 10.5 / 12.0% | 28.9 / **14.4** / 17.9% |
| Purple: jump ≥180 s / strand / pin change | 61.2 / 32.7 / 56.1% | 73.7 / **46.5** / 70.7% |
| Green: jump ≥180 s / strand / lap re-price | 61.7 / 25.1 / 27.6% | 70.1 / 24.4 / 37.0% |
| first-promise \|miss\| median (all) | 65 s | 85 s |
| paired: waits gaining / losing a strand | | **545 gain, 268 lose** |
| paired: gaining / losing a ≥180 s jump | | 872 gain, 539 lose |
| chain: riders seeing ≥180 s at the departure poll | 2 of 657 | 14 of 657 |

Purple's strand share going 32.7 → 46.5% is the arm's own thesis failing on its
own population. **Arm A is rejected.**

One thing in it did work and is worth recording: on the 344 Winchester chain,
where the two branches are near each other rather than a lap apart, the
mixture is smooth and it smooths — at Division / Prospect the ≥180 s share fell
37.4 → 23.5%, reversals 15.7 → 1.7%, and the worst-drift p90 410 → 230 s. The
defect is specific to far-apart branches, which is exactly where the fold lives.

## Arm B: the belief chooses, the arithmetic does not interpolate

Arm B keeps the whole filter and changes only the summary: the countdown is the
**leading branch's own arithmetic**, and the lead moves to another branch only
when that branch is believed at `SWITCH_AT` = 0.7. The other branches set the
interval. Nothing is damped in time — 0.7 is one fresh fix of direction
evidence from an even split, so a bus that pulls out still moves the number in
the poll it moves. What cannot happen any more is a promise that races across
the gap between two branches while the evidence sits at 51/49.

Transition level, same 2.58 M transitions:

| | master 1617c92 | arm A | **arm B** |
|---|---|---|---|
| jitter | 13,906 (0.54%) | 16,760 (0.65%) | **14,778 (0.57%)** |
| EVENTLESS jitter | 4,975 | 11,361 | **9,377** |
| frozen % / while moving | 37.8 / 15.2 | 28.3 / 9.6 | 33.1 / 10.9 |
| accuracy median / bias | 169.4 / +73.8 | 167.3 / +73.5 | 167.3 / +74.3 |
| Green / Purple jitter rate | 1.92 / 0.90% | 2.63 / 1.58% | **2.18 / 1.42%** |
| Red / Orange Night / Blue West | 0.35 / 0.49 / 0.22% | 0.29 / 0.16 / 0.15% | **0.27 / 0.16 / 0.14%** |
| departure: median signed error at 0 s / +30 s | 20 / 100.5 s | 19.2 / 120.9 | 18.1 / 120.9 |

Rider level (8,346 paired waits):

| | master | arm B |
|---|---|---|
| Red: jump ≥180 s / strand / reversal ≥60 s | 23.9 / 10.5 / 23.9% | 23.9 / **13.7** / 27.8% |
| Green: strand / jump ≥180 s / lap re-price | 25.1 / 61.7 / 27.6% | **21.9** / 64.6 / 33.5% |
| Purple: strand / jump ≥180 s | 32.7 / 61.2% | **46.0** / 72.3% |
| all: strand | 12.8% | 15.6% |
| paired: waits gaining / losing a strand | | 479 gain, 263 lose |
| paired: gaining / losing a ≥180 s jump | | 515 / 515 (a wash) |
| chain: riders seeing ≥180 s at the departure poll | 2 of 657 | 18 of 657 |
| chain @ Division / Prospect: ≥180 s / reversal | 37.4 / 15.7% | **22.6 / 1.7%** |

Arm B recovers most of arm A's damage and keeps its gains on the plain loops —
and it is **still worse than master on eventless jitter, on the rider's strand
share, and at the departure poll**, which are the three things the operator
states his rule in. Its shape is one the repository has already recorded once:
*Green improves, Purple gets worse*. `anchorGate.ts` says of letting direction
release the gate, "Green's strand falls to 24.9% but Purple's rises to 32.6%";
arm B is Green 21.9% and Purple 46.0%. **This is that negative result again, at
a larger magnitude, reached by a different mechanism** — which is itself worth
knowing: it is a property of the two routes, not of the rule that was tried.

The half that remains is not the summary any more; it is the switch itself.
When the belief crosses 0.7 the shown branch changes by a lap, and to the feed
that poll looks like a bus that twitched 40 m. Master's gate refuses that
relocation unless something corroborates it. The belief's accumulated
likelihood is a different kind of corroboration and, measured, a worse one.

## What the posterior actually knows (`scripts/eta-replay/belief-split.ts`)

The measurement that should have come first. One shared store, every poll of
the 2026-09-03 capture, reading the belief back with `peekBelief`:

| route | polls | belief carries ≥2 branches | **undecided** (no branch at 0.7) | leader disagrees with the gate |
|---|---|---|---|---|
| Green | 13,910 | 61.1% | **5.6%** | 26.2% |
| Purple | 19,452 | 63.5% | **6.0%** | 28.3% |
| Red | 17,550 | 83.0% | **27.5%** | 7.8% |

Two things fall out of that table, and they are the reason this lane ends here.

**The undecidable population is small.** The design's case — hold both because
nothing can choose — is 5.6% of Green's polls and 6.0% of Purple's, not the
42.8% the ambiguity count suggested. The count of anti-parallel candidate legs
measures how often a POINT anchor has a choice to make; the belief usually
finds a reason to prefer one of them. On the genuinely undecided remainder,
holding both is exactly what arm A did, and it was a disaster.

**Where the belief is confident it is confidently disagreeing.** Its leader
differs from the gate's anchor on 26–28% of fold polls while being decided on
94% of them. Arm B acts on precisely those disagreements, and the rider numbers
say the gate is right more often than the posterior is. A better-calibrated
likelihood might narrow that; nothing in the measured priors suggests it would
reverse it, and the failure is not in the filter's mechanics — the fixtures
show those working — but in the fact that the evidence separating two chords
50 m apart is thin and the cost of acting on it wrongly is a lap.

Red is the mirror image and is worth stating because it is counter-intuitive:
Red's belief is split MORE often (83%) and undecided far more often (27.5%),
because its coincident legs are the downtown Olive/Court pair where neither
direction nor `last_stop_id` separates anything — and it disagrees with the
gate least (7.8%), which is why Red's jitter rate actually improves under both
arms. Splitness is not the problem. Confident disagreement is.

## The named riders, and how the predictions scored

The three archived Red incidents (`docs/rider-sim.md`, riders at Division /
Prospect) are **unchanged** by arm B, which is the right answer — they are not
fold cases:

| rider | master | arm B |
|---|---|---|
| #316 20:36:03 | first sight "in 11, 27 min", miss 0 s, worst drift −55 s, no strand | identical shares; worst drift −55 s |
| #304 20:58:03 | miss −115 s, worst drift −230 s, strand | miss −115 s, worst drift −230 s, strand |
| #309 21:21:25 | miss −125 s, worst drift −235 s, 3 reversals, strand | miss −125 s, worst drift −230 s, 3 reversals, strand |

Against the predictions committed before any of this ran:

1. **"Red will not move worth having" — half right, and the wrong half
   matters.** Red's jump share is unchanged (23.9%) and its transition jitter
   improves (0.35 → 0.27%), but its strand share rises 10.5 → 13.7%. Red does
   have coincident legs — the downtown Olive/Court pair — and I had assumed it
   effectively did not.
2. **"The folds move in pin-change and lap-re-price rather than strand" —
   wrong.** Purple's strand share moved most of all (32.7 → 46.0%). Pin change
   and lap re-price did move as predicted (Purple 56 → 70%, Green 28 → 34%),
   but they were not where the damage was.
3. **"The freeze check is where this most likely dies" — wrong, and cleanly
   so.** Both arms freeze *less* than master. This was the prediction I was
   most confident of and it is the one the data refuted outright.
4. **"The departure poll is the second way it dies" — right.** Chain riders
   seeing ≥180 s at the departure poll went 2 → 14 (arm A) and 2 → 18 (arm B).
5. **"The enabling fact — occurrence-keyed tables — is the larger prize and is
   not reachable in this pass" — unchanged, and now the recommendation.**

## The recommendation

**Do not ship the estimator.** Neither arm beats the bar, and the bar is not
close: master is better on the two routes the lane exists for, on the metric
the operator states his rule in, and on the rider's strand share. The design in
`docs/eta-estimator-design.md` is not wrong about the physics — the branch
posterior does what it says, the Tobit update does move mode weight to standing
on a repeated fix, the fixtures hold — but the object it produces cannot be
spent. A countdown is one number, and every way of turning a two-branch belief
into one number is either an interpolation nothing believes (arm A) or a switch
that fires on evidence the feed cannot corroborate (arm B).

What the two arms did establish, and what should be taken out of this lane:

1. **The freeze check clears both arms.** Neither wins or loses by going quiet:
   arm A freezes 28.3% of transitions and arm B 33.1% against master's 37.8%.
   Whatever is wrong here is not the failure mode that killed the earlier
   filters.
2. **The mixture median is a trap on far-apart branches, and it is a genuine
   smoother on near ones.** The chain cohort — where the two hypotheses differ
   by a hop, not a lap — improved under arm A on every stability measure.
   Anyone tempted by a mixture summary should apply it only where the
   components overlap.
3. **The prize on the folds is not the anchor.** The calibrator withholds the
   stand/drive split from Green and Purple because one stop id carries two
   different passes of a repeated stop, not because the anchor is unsure —
   `splitWithheldRoutes` in `src/calibrator/calibrator.ts` says so. On Red that
   split moved the departure-poll rise +220 s → +1 s and strands 1,041 → 769.
   Green's West Haven Train Station stands for a median of 235 s and Purple's
   Building 400 for 115 s: the same layover-cliff shape, priced today by the
   arrival-to-arrival number. Keying `stop_visits`/`legs` and the payload's
   `dwells` by (stop, occurrence) — the derivation already knows the sequence
   position — is a bounded piece of work with a measured precedent, and it
   needs no belief at all. **That is where the next pass should go.**
4. If a belief is revisited, the measurement that should come first is the one
   in `scripts/eta-replay/belief-split.ts`: how often the posterior is
   genuinely undecided, and how often its leader disagrees with the gate. That
   bounds the headroom before any code is written, and it is the step this
   pass took in the wrong order.

### Reproducing any of this

```bash
# the harness is master's; only CLIENT_ROOT changes between arms
cd /path/to/pristine-master/services/shuttle-v2
node scripts/eta-replay/split-patch.mjs > /tmp/split-patch.json
TZ=America/New_York REPLAY_DB=/path/to/store/snap3.db REPLAY_OUT=/tmp/out \
  CAPTURE=$HOME/shuttle-captures/positions-20260903.jsonl \
  PAYLOAD_PATCH=/tmp/split-patch.json \
  CLIENT_ROOT=<master|candidate>/services/shuttle-v2 OUT_NAME=<name> \
  npx tsx scripts/eta-replay/rider-sim/run.ts
npx tsx scripts/eta-replay/rider-sim/run.ts --compare /tmp/out/a.waits.jsonl /tmp/out/b.waits.jsonl

# transition level: run it IN the tree under test, so `shipped` is that client
TZ=America/New_York REPLAY_DB=… ARMS=ungated npx tsx scripts/eta-replay/belief-scoreboard.ts
# what the posterior knows
TZ=America/New_York REPLAY_DB=… npx tsx scripts/eta-replay/belief-split.ts
```

Two cautions for whoever runs this next. `belief-scoreboard.ts`'s `replica` arm
is a copy of `arrivals.ts` frozen at 972c5ba, so its "replica mismatches: must
be 0" line has been non-zero on master itself since PR #80 — 2,974 on
`1617c92`. Read the `shipped` row, which is the tree under test, and ignore the
guard until the replica is re-derived. And `rider-sim` without `PAYLOAD_PATCH`
scores the PRE-#85 client on every route, because the offline calibration in
`common.ts` serves neither `q` nor `drive`; every number above has the patch on
both sides.
