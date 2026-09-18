# Red current-wait release model (2026-09-17)

## Problem and scope

While Red waited at Winchester, the ETA mixture repeatedly switched between
leaving now and continuing to wait. In report 115, the conditional departure
median moved less than one second while the displayed arrival moved five
minutes. A monotone ETA ceiling hid that mixture problem and retained stale
forecasts; the existing global band widening also inflated the new conditional
model's upper bound.

This change fits a conditional **current** layover model on the server and
pools absolute arrival quantiles while the tracked Winchester rest continues.
It does not change the route-position filter, future-layover tables, route
ranking, or historical-dot measurements. Union stays on the existing estimator:
its complete arrival forecasts did not consistently improve.

## Model and operation

- A regularized nine-feature logistic departure hazard uses 15-second exposure
  bins, elapsed wait, the bus's own elapsed lap at pin, and a first harmonic of
  the 15-minute clock. L2 penalty is 4; Newton fitting has bounded iterations.
- Server fitting uses completed pinned Red visits from the preceding 30 days,
  at least 60 observations, three dates and 40 usable laps. Features use only
  earlier confirmed departures, with a same-day intervening opposite-terminal
  visit. Outcome availability is delayed before fitting. A fit refreshes at
  most every six hours and is loaded at startup from existing server history.
- A bus requires a valid pin and supported lap (0.65–1.65 times the training
  reference). The lap and pin-time clock stay fixed throughout that visit.
  Missing or unsupported history falls back to the existing marginal model.
- Long completed holds contribute right-censored exposure through 30 minutes;
  the prediction has a continued exponential tail. Log-space conditional
  survival prevents an unusually long wait from collapsing to zero remaining
  time through floating-point CDF rounding.
- The accepted current-wait model replaces only that residual wait. It bypasses
  the old median ceiling and upper-side global widening; lower-side widening
  remains because removing both sides increased early-arrival misses.
- During a tracked Winchester rest, consecutive absolute arrival quantiles
  are convexly pooled with a 30-second time constant. Both target occurrences
  and the plotted distribution use the same pooling. Marginal fallbacks at
  Winchester also receive this stabilization when an accepted fit exists.
  Pooling ends as soon as the tracked rest ends, rather than using the first
  movement as a departure oracle. A gap over 15 seconds or a new route lap
  bypasses old pooling memory. Checkpoints persist that memory with the belief.
- The wire payload carries the small fit with dwell statistics. It is also
  included in the shared runtime module's Docker dependency closure. Fit cost
  and fit count are included in collector calibration logs.
  Periodic topology refreshes calibrate their replacement network with both
  cached fits before swapping it in; a failed refresh retains the fitted live
  network. A regression test covers refresh, failure and retry.

No normality assumption or calibrated on-time probability is introduced.
Pooling and asymmetric widening change the displayed distribution, so interval
coverage must continue to be measured on the final estimator.

## Chronological replay

The candidate shape and a predeclared historical-fit refresh were frozen before
examining September 17 after 13:14:00.913 ET. Earlier development used September
16–17 raw observations, pre-September-10 hazard fits, pre-September-14 marginal
tables and the movement parameters published September 15. At the afternoon
boundary, the final replay refreshes the same hazard using only outcomes already
available before that boundary. The runtime loader reproduces the research
fit's coefficients exactly on this cutoff (259 Winchester observations, ten
service dates). Selecting Winchester rather than both terminals used the
reserved afternoon result; it is a gated rollout, not independent confirmation
of a site choice made beforehand.

The final paired replay contains 16,253 actual raw frames and 150,020 forecast
rows. All 46,790 compared position beliefs were identical; 302 full server
parity checks passed and neither arm lost forecast availability. There are no
synthetic polls or watcher-session resets within observed continuous segments.
An overnight gap is preserved. Scoring requires ten minutes of observed warmup.

First-arrival outcomes require exact connected legs and visits to the first
physical target occurrence. The reserved afternoon contains 50 connected
journeys, 28 distinct target visits and 600 repeated checkpoints. These are
correlated checkpoints, not 600 independent journeys. Passed and stopped
endpoints are reported separately. Missing chains are retained as exclusions,
not treated as prediction errors or selectively repaired.

At one minute into a Winchester wait, the reserved afternoon results are:

| First target | Trips | Mean absolute error, old → new | Mean window width, old → new | Early / late misses, old → new |
|---|---:|---:|---:|---:|
| Division/Prospect | 13 | 216 → 81 sec | 550 → 492 sec | 0 / 1 → 0 / 1 |
| Rosenkranz | 13 | 126 → 105 sec | 814 → 622 sec | 0 / 0 → 0 / 0 |
| Division, stopped endpoints only | 9 | 163 → 44 sec | 500 → 453 sec | 0 / 0 → 0 / 0 |
| Rosenkranz, stopped endpoints only | 11 | 92 → 94 sec | 806 → 608 sec | 0 / 0 → 0 / 0 |

The weighted interval score (lower is better) improves from 111 to 62 seconds
for Division and 96 to 77 for Rosenkranz in the 13-trip rows. During the scored
standing/departure sequences, upward absolute-arrival changes over 60 seconds
fall from 4 to 1 for Division and 9 to 2 for Rosenkranz. Development counts fall
from 19 to 4 and 29 to 1 respectively. Remaining large route-occurrence changes
are not fixed by this wait model.

There is a departure tradeoff: first-update Division mean error rises from
23 to 43 seconds, and at +15 seconds from 25 to 36. At +60 seconds it is unchanged
at nine seconds. Rosenkranz at +15 seconds rises from 90 to 107 seconds. The
recorded departure is the retrospective final stationary fix; its first actual
movement is typically observed about five seconds later. Rest confirmation and
pooling can persist briefly beyond that first movement.

Second-occurrence scoring requires the exact first target followed by one full
connected lap to the next target. Across both replay segments, 801 checkpoints
are paired and 318 are absent in both arms; there is no differential loss.
The afternoon has 172 paired checkpoints, 12 sources and 14 next-target visits.
At +60 seconds standing (seven trips per target), Division error changes from
151 to 145 seconds and Rosenkranz from 156 to 166; widths increase slightly
(965 → 984 and 1026 → 1041 seconds), with no bound misses in either arm. The
second occurrence is not claimed to become materially narrower.

## Regression audit

Real short and long waits remain in training and evaluation. Four deliberately
selected development regressions (visits 64318, 58224, 65347 and 48550) were
reviewed against raw GPS where available and exact visit/leg clocks. None had
positive evidence of a detector error. The Union case lacks archived Red GPS
but has a complete event chain; that limitation is not an exclusion rule.

The two largest afternoon Winchester regressions, 67957 (#316) and 68304 (#300),
have 350- and 285-second pin-to-departure holds. Raw polls are continuous (maximum
gap 5.25 seconds), each retains one pin, each ends with a 40-second plateau,
and onward movement starts 4.95 seconds later. Both have exact connected target
chains. They remain scored. Only the independently verified restart truncation
at visit 65237 is excluded from fitting by its audited bus/stop/pin identity;
PR 279 prevents that split, and the database record is preserved.

## Other-shuttle interactions

A separate development-only review examined the user's dispatch hypothesis.
The predecessor is latched from the latest confirmed other-bus departure from
the same regulator before the focal pin. Features use only already-observable
stop/progress events, not the eventual predecessor path. All tested stop
families and before-event controls were retained.

A persistent “predecessor has reached this stop” feature interacting with clock
timing improves Winchester's mean per-hold departure-hazard log loss from
3.1923 to 3.0649 (about 4%), across three of four evaluation dates. Union's gain
is about 0.4% and inconsistent in sensitivity checks. Training-ranked
College/George and College/Crown associations have excess departures before
the events too: shared schedules or anticipation remain explanations. This is
not proof of a specific dispatch gate, and the 4% is not an ETA accuracy gain.
The feature is not deployed without a causal forecast of the predecessor's
future progress and a complete arrival replay.

Across all 29 Red stops in the development data there are eight detected
same-stop overlaps, seven with both buses stopped; all are at Winchester or
Union. Six of the seven leave several minutes apart (345–835 seconds). One
Winchester pair overlaps for 450 seconds and leaves 35 seconds apart. Earlier
peer presence, later peer presence, recent peer arrival and recent peer
departure add little reliable predictive value with this sample. These are
interesting descriptive encounters, not enough observations for a new rule.

## Reproduction and checks

The committed 440-poll fixture in
`services/shuttle-v2/src/server/__fixtures__/red-release-2026-09-17.json` covers a
real short hold and report 115. Tests check both target occurrences, unchanged
tracking beliefs, ordered bands/distributions, bounded upward jumps and warm
checkpoint restoration. Additional tests cover causal fitting, support gates,
retained extreme durations and the nonzero long-wait tail.

The working research archive at `/home/gwarren/projects/yale-shuttle-watcher/`
contains `release-integration-data/production-replay.mts`, `final-meta.json`,
`final-{development,holdout}-score.json`, `final-next-occurrence-review.py/.json`
and `final-regression-audit.py/.json`. `red-window-data/full-path-score.py`
produces the first-occurrence scores. The original read-only data and the
separate completed-afternoon capture are preserved. The corrected predecessor
review is `red-window-data/ahead-trigger-review.md`; files named
`before-causal-fix` are superseded. Same-stop analyses are
`release-integration-data/co-presence-{screen,all-stops}.py/.json`.

Required app checks: backend/frontend typecheck, full Vitest suite, frontend
build, Docker runtime closure test, then staging API/browser smoke and normal
CI deployment verification.
