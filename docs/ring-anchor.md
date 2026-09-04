# The ring: putting the loop in the chooser, not just the veto

**Status: measured, PR open, not merged.** Instruments:
`scripts/eta-replay/hold-anatomy.ts` (new here) and
`scripts/eta-replay/rider-sim/run.ts`. Baseline is `origin/master` **91e4467**
(PRs #90, #93, #96, #97, #99-#103 included). Captures:
`~/shuttle-captures/positions-20260903.jsonl` (riders, 8,327 waits) and
`-20260904.jsonl` (mechanism, 74,976 polls on Red + Green + Purple).

The operator's framing:

> "if the full route is a closed loop graph and we know each stop can only be
>  hit in order and the edge weight paid once, then why are we fumbling with
>  going 'backwards' in the graph and re-paying the edge weight?"

---

## Summary

1. **The ring decision rule was already shipped — in the veto.** PR #93 rewrote
   `gateAnchor` in exactly these terms on 2026-09-04, and #90 closed the
   timeout's backwards door. Every release path now carries `forward <= N / 2`,
   so with a store the shown anchor cannot decrease except through `first`,
   `stale` or a missing fix. **The between-stops retreat that was thought
   uncovered is covered**; if a live harness still sees one it is a storeless
   call site or a reset, not the gate.
2. **What was left is that the CHOOSER is ring-blind.** `findRouteAnchor`
   re-decided from scratch every poll and proposed whatever leg looked best, so
   the gate's only remaining move was to FREEZE — and freezing is what the
   operator ruled out as a way to buy stability. This PR gives the chooser the
   prior and a physically-reachable forward window, so it stops proposing the
   impossible and the gate stops having to refuse it.
3. **On a plain loop the gate is left with almost nothing to refuse.** Red's held
   share goes 6.0% → **0.5%** of polls, and 8.1% → **0.4%** of the polls where
   the raw fix moved. Riders: reversal ≥60 s 48.7% → 46.8%, overshoot
   26.7% → 24.5%.
4. **On an out-and-back it makes things worse, and is therefore not served
   there.** Served on the folds it lifted Purple's lap-re-priced share
   10.1 → 14.6% and Green's jumps ≥180 s 56.8 → 60.5%. Green and Purple now
   take the prior-free path and are byte-identical to master on every rider
   metric and every mechanism count.
5. **The strand win it had this morning is gone; #97 took it.** Against
   `4a59795` this moved Red's strand share 13.3 → 11.6%. Against master today it
   moves it not at all, because #97's at-stop recovery reached that population
   first. What is left is the stability half — reversals, overshoots, the freeze,
   and the departure — which is a narrower case than the one this work opened
   with, and is the case the operator should judge it on.
6. **It retires nothing.** Every guard in `anchorGate.ts` is still load-bearing;
   see "What this does not retire".

## The mechanism table

`hold-anatomy.ts`, one frozen copy of the 2026-09-04 capture, 74,976 polls on
Red + Green + Purple. The gate is driven with PR #97's seventh argument, so its
at-stop recovery engages — omitting it silently scores a pre-#97 gate, which is
a mistake this script made once and now guards against in a comment.

| | before #90/#93 (`926af30`) | master `91e4467` | this PR |
|---|---|---|---|
| all: held | 22.2% | 25.4% | 23.8% |
| all: held while the fix moved | 29.8% | 32.2% | 30.6% |
| all: lap-wrong vs the detector | 5.1% | 4.3% | 4.4% |
| **Red: held** | 5.5% | 6.0% | **0.5%** |
| **Red: held while the fix moved** | 7.5% | 8.1% | **0.4%** |
| Red: holds whose proposal read backwards | 86.7% | 94.5% | **42.7%** |
| Green: held | 26.1% | 27.3% | 27.3% |
| Purple: held | 31.8% | 38.7% | 38.7% |

**On a plain loop the gate has almost nothing left to refuse.** Red's freeze goes
from 6.0% of polls to 0.5%, and the 42.7% is the tell: the backwards proposals
have not been suppressed, they have stopped being MADE, and what remains is
cold-start and post-gap cases where there is no prior to narrow with.

Green and Purple are identical to master down to the hold-episode table. That is
checked on every run, not asserted.

### A detour worth recording, because it nearly became a finding

Measured against `4a59795` — master as of this morning, before #97 — PRs #90 and
#93 looked like they had **doubled the freeze**: holds 22.2% -> 44.8% of polls,
index-level lap-wrongness 5.1% -> 11.0%, and by making the 300 s timeout
forward-only they removed the bound on how long a wrong hold could last (Purple
#332 held for 59 minutes where the old cap was 300 s by construction).

Two things then made that the wrong story to tell.

- **The riders were better off anyway.** Paired on the simulator, `926af30` ->
  `4a59795`: 248 waits lose a jump >=180 s against 8 that gain one, 173 lose a
  strand against 75, 445 lose a >=60 s reversal against 4. The index metric and
  the rider metric disagreed and the rider metric decided, exactly as
  `branch-lock.ts` warns.
- **#97 then gave most of the freeze back** — holds 44.8% -> 25.4%, lap-wrong
  11.0% -> 4.3% — by letting `at_stop_id` pull a backwards anchor home when the
  flag names the very slot the scan proposes.

The freeze is a cost to watch, not a defect on its own. What makes it one is a
hold that spans a real departure, which is the next section.

## The rider table

`rider-sim/run.ts`, 2026-09-03 capture, 8,327 waits, same population, paired
against master `91e4467`:

| | master | this PR |
|---|---|---|
| all: reversal >=60 s | 50.0% | **48.4%** |
| all: overshoot | 27.8% | **25.9%** |
| all: strand | 14.8% | 14.8% |
| all: jump >=180 s | 41.2% | 41.5% |
| all: jump >=300 s | 28.1% | 28.0% |
| Red: reversal >=60 s | 48.7% | **46.8%** |
| Red: overshoot | 26.7% | **24.5%** |
| Red: strand | 13.1% | 13.1% |
| Red: jump >=180 s | 38.7% | 39.1% |
| Green / Purple: every column | — | identical |

Paired, wait for wait: **243 waits lose a >=60 s reversal against 119 that gain
one**; 292 lose a jump >=180 s against 317; strands 198 against 200.

**The strand win this had six hours ago is gone, and #97 took it.** Against
`4a59795` the same change moved Red's strand share 13.3% -> 11.6% with 212 waits
losing a strand against 97. #97 reached most of that population first — master's
own Red strand is now 13.1% — and what is left here is the stability half:
reversals and overshoots, plus the freeze and the departure below. Two changes
aimed at one population do not add up, and the honest reading of this PR today
is narrower than the one it had this morning.

### The one regression, and why it is not the filter's shape

Worst drift moves the wrong way: p90 +60 s, 826 waits worsened against 479
improved. That is the tail this PR was required to report, because a
forward-committing model is exactly how the belief filter died (10.3% of
departures over 300 s late, p99 +4,989 s, branch-locked for a lap).

It is a different animal, and the classification says so. Of the waits whose
worst drift grows by more than 300 s (438 against `4a59795`, where the split was
measured; the shape is unchanged against `91e4467`):

- **353 are a newly-changed PIN** — the card switching to another vehicle — and
  368 waits improve by more than 300 s carrying the same signature in reverse.
  This is `pickLiveArrival`'s catchability boundary, which `docs/rider-sim.md`
  already records as "not the estimator": at eta 24 s a rider 182 s away becomes
  uncatchable, the first catchable entry is the same bus a lap later, and the
  card's total grows by a lap.
- **381 of 438 land in the last 20% of the wait** — the final poll or two before
  the bus reaches the kerb, not a mid-wait lurch.
- On that same population the ring newly strands 81 riders while master newly
  strands 190.

The filter's signature was a *sustained* lap-scale error from the departure
onward. This is a boundary crossed one poll earlier because the anchor advanced
one poll earlier. Worth watching; it is not the same failure.

## The reference incident, replayed

Red **#316**, 2026-09-04, 344 Winchester (stop 11, ring slot 14), the operator's
case. `hold-anatomy.ts` with `TRACE=#316`:

| | master `91e4467` | this PR |
|---|---|---|
| 11:45:20-11:45:30 (a shuffle at the kerb) | raw proposes slot 13, **3 polls HELD** | raw proposes 14, no hold |
| 11:46:45-11:47:31 (the bus actually leaves) | raw proposes slot 13, **10 polls HELD, 45 s** | raw proposes 14, no hold |
| the anchor reaches slot 15 | 11:47:35, when `last_stop_id` finally moves | **11:47:00**, the poll `at_stop_id` appears |
| holds in the whole window | **13** | **0** |

The detector reaches slot 15 at 11:46:45. So master is 50 s behind it and this
PR is 15 s behind it, and the 45-second freeze — which straddles the departure,
the one moment the operator's rule says must land in the same poll — does not
happen, because the retreat is never proposed for the gate to refuse.

**PR #97 does not reach this incident**, which is worth stating plainly since it
is the closest thing to it on master. #97 lets `at_stop_id` pull a backwards
anchor home when the flag names the very slot the SCAN proposes; here the flag
says 146 (slot 15) while the scan says slot 13, so the two never agree and the
hold stands. The freeze is live on master today.

## The model

`web/src/ring.ts`, pure and unit-tested.

- **`ringForward(from, to, n)`** — the only reading of a position change.
  "Backwards by one" is "forwards by n−1", and a five-second poll cannot carry a
  bus n−1 stops.
- **`occurrenceForward(stops, stopId, from)`** — the ring-aware `indexOf`.
  Routes 9 and 10 pass the same West Campus buildings twice, so `indexOf`
  silently ties two legs together; this asks which visit is meant. Degrades to
  `indexOf` with no prior.
- **`reachableHops(...)`** — how many slots forward the ground covered can
  reach, and the two details that matter:
  - **along the route's own spacing**, not a constant. `ANCHOR_M_PER_HOP = 120`
    cannot serve both Green's 6.7 km stopless leg and a 100 m downtown hop: on
    the long one it grants a hop the bus cannot have made, on the short one it
    withholds one it made twice over.
  - **from where the bus was ON its leg**, not from the stop behind it. An
    anchor of `i` means "on segment i → i+1", so a bus 89 m into a 112 m hop
    needs 23 m to reach the next slot. Measuring from the stop is what makes the
    window too tight to admit a real departure — on the #316 trace the bus had
    covered 102 m of a 112 m hop and a stop-relative window still read zero.
- **`travelBudgetM(pathM, elapsedMs, deadband)`** — observed road, capped by the
  clock, plus one deadband. Elapsed time alone is useless: a bus standing ten
  minutes at a layover would accrue 13 km of licence. Observed path is honest
  because the feed repeats a coordinate rather than interpolating, so a standing
  bus accrues nothing. The deadband is there because the feed publishes a new
  coordinate only once the bus has moved ~30 m, so the bus is always up to that
  much further along than its last fix — a window without it refuses the
  departure it exists to admit.

`findRouteAnchor` takes an optional `prior`, **narrows only**, and ranks the
admissible candidates by GPS distance alone. `last_stop_id` no longer ranks
anything when a prior exists: forward-distance-from-a-stale-value is precisely
what put the Canal / Munson chord ahead on the #316 trace. If nothing inside the
window is plausible the function returns exactly what it always returned, the
gate holds it, and the gate's timeout is still the release valve.

### Why the folds are excluded, and how

A route that serves a stop twice runs the same road in both directions, so its
two chords are anti-parallel and a prior that picks one **reinforces itself** —
every later poll is narrowed to the branch it already believes. On a plain loop
no two legs are anti-parallel, so a wrong commitment is bounded by the window
(~110 m per poll) and washes out at the next arrival.

The test is intrinsic — `hasRepeatedStop(stops)`, not a list of route ids — so a
route that grows a fold upstream is handled on the day it does. It selects
exactly Green (3 repeats) and Purple (4), matching the `foldRoutes` the
stand/drive split already excludes, for the same underlying reason.

Served on the folds, measured:

(measured against `4a59795`, before #97; the mechanism is a property of the
geometry, not of that baseline)

| | master | prior served everywhere |
|---|---|---|
| Green: jump ≥180 s / pin change | 56.8% / 40.9% | 60.5% / 44.5% |
| Purple: strand / lap re-priced | 40.2% / 10.1% | 42.0% / **14.6%** |
| Red: strand | 13.3% | 11.6% |

Purple's lap-re-price column is the mechanism showing itself. Their half of the
ambiguity is the stationary one `docs/eta-estimator-design.md` says needs a
distribution rather than a better point, and this is a better point.

**The at-stop refine rides with the prior for the same reason.** Using
`occurrenceForward` there is the more correct answer in the abstract and it is
not free on a fold: served there it moved Purple's hold share 67.7 → 73.7% of
polls. It is now gated on the prior, which makes the folds byte-identical to
master — a claim the mechanism table above checks rather than asserts.

## What this does not retire

The brief asked which existing guards the measurements license removing. **On
this evidence, none.**

| guard | verdict |
|---|---|
| #72 the corroborated anchor | Keep. The window narrows what is PROPOSED; the gate still rules on what is accepted, and on the folds it is the only thing doing so. |
| #80 the departure retreat | Already gone — #93 absorbed it into the ring rule. Nothing to retire. |
| #86 direction over two fresh fixes | Keep, untouched. It chooses between two legs the bus is ON, which no ring rule can do, and it is the folds' only defence. |
| #90 the forward-only timeout | Keep. It is the release valve for a prior that has gone wrong, and this PR leans on it as the recovery path when the window admits nothing. |
| #93 the backwards refusal | Keep. Measured a clear rider win in its own right (above), and it still catches the storeless and cold-start paths the window cannot. |
| `ANCHOR_M_PER_HOP` | Superseded **for the window only**; rule 2 of the gate still uses it. Removing it needs its own pairing. |

The honest summary is that the ring model **adds** a chooser-side mechanism on
plain loops. It does not let anything be taken away, and a PR that claimed
otherwise would be trading measured protection for tidiness.

## Where the prior is threaded, and a fix that was already shipped

The prior enters at `resolveAnchorIndex` in `web/src/liveAnchor.ts`, which is the
one place the sequence `noteFix` → `findRouteAnchor` → `gateAnchor` lives. So the
ETA path and every render site get the same answer by construction.

That file is **PR #102's**, not this work's. This PR originally carried its own
fix for the same five storeless call sites in `TransitMap.tsx`, and #102 shipped
first and shipped it better: it caught that the render sites build their own
DE-DUPLICATED stop list (Green 23 → 20 stops, Purple 15 → 11), so an index means
something different there, and sharing one store across the two index spaces
would have put fold buses a few slots out rather than fixing anything. This PR's
version did exactly that and was dropped in the rebase.

A caller with no store still gets no prior and exactly `findRouteAnchor`, which
is what the replay harnesses depend on.

## Reproducing

```bash
cd services/shuttle-v2

# mechanism: the freeze, its direction, and the hold episodes
TZ=America/New_York REPLAY_DB=./store/snap3.db CAPTURE=~/shuttle-captures/positions-20260904.jsonl \
  ROUTES=Red,Green,Purple npx tsx scripts/eta-replay/hold-anatomy.ts
#   CLIENT_ROOT=/tmp/newbase/services/shuttle-v2   (master, from a `git archive` of it)
#   TRACE='#316' FROM=2026-09-04T11:45:10Z TO=2026-09-04T11:47:40Z   (the reference incident)

# riders: same population, two trees, paired
TZ=America/New_York REPLAY_DB=./store/snap3.db CAPTURE=~/shuttle-captures/positions-20260903.jsonl \
  CLIENT_ROOT=<tree> OUT_NAME=<name> npx tsx scripts/eta-replay/rider-sim/run.ts
npx tsx scripts/eta-replay/rider-sim/run.ts --compare scripts/.eta-replay/a.waits.jsonl scripts/.eta-replay/b.waits.jsonl
```

**These runs do not carry the stand/drive split.** `common.ts`'s calibration
replicas emit neither `dwells[route][stop].q` nor `segments[route]["A-B"].drive`,
so a rider-sim run scores the pre-#85 pricing path unless it is given
`PAYLOAD_PATCH` (`scripts/eta-replay/split-patch.ts`, added alongside this
work). Both arms here were scored without it, so the pairing is valid for the
anchor's effect and the absolute departure-poll levels are not production's.
Re-scoring the departure cohort with the patch is the obvious next measurement.
