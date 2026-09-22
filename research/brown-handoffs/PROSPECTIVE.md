# Prospective Brown validation protocol

Pinned after documenting handoff audit35686521295, before reading any subsequent
outcomes. Retain both arms; no winner is selected from18 development visits.
This protocol schedules no scoring or deployment by itself. September17–20 are
development dates, September21 is excluded from the validation set, and no
September21 or later candidate outcomes have been opened by this audit.

## Fixed arms and comparator

- Brown frozenK8: immutable canonical training visits known before
  September16 00:00ET, from artifact35684356219. No later paths enter this arm.
- Brown rollingK5: at each future evaluation date D, train only on complete
  visits whose actual reducer-emission known_at is strictly before D−1 at
  00:00ET (full prior-calendar-day embargo). Source, intermediate and target
  evidence must all meet that knowledge cutoff. GPS quality uses fixes strictly
  before the same cutoff, including bracketing fixes.
- Comparator: contemporaneous deployed point/window and reminder policy,
  preserving the exact production checkpoint overlay over its recorded live
  fallback, with deployment/model/input hashes recorded before outcomes open.
  Brown currently uses that live fallback. If production models or topology
  change, retain all data and version strata, and block an unqualified pooled
  promotion claim rather than silently changing the comparator.

Both arms retain the379ea69 hybrid exactly:

```
eta = deployed.eta
low = min(deployed.low, candidate.low, deployed.eta)
high = max(deployed.eta, candidate.high)
```

Unsupported underlying candidates return the exact deployed forecast. This is
a hybrid point/interval, not a coherent50-quantile distribution. Do not export
probabilities or change planner probabilities from these bounds.

## Full canonical scope and adjacent context

Canonical Brown sequence is fixed, including every occurrence:

| Index | Stop |
|---:|---|
| 0 | Science Park Garage145 |
| 1 | Winchester/Sachem147 |
| 2 | 130 Prospect Street(S)4 |
| 3 | College/Wall(S)42 |
| 4 | Phelps Gate98 |
| 5 | Union Station(N)121 |
| 6 | State St Station115 |
| 7 | Humphrey/Whitney172 |
| 8 | Divinity/409 Prospect47 |

Wait0 qualifies targets1–5; wait5 qualifies targets6,7,8,0. Preserve these whole
groups even when a target had little/no development telemetry. FrozenK8 sources
are1 before wait0 and6 before wait5. RollingK5 sources are4 before wait0 and0
before wait5. Do not limit scoring to favourable stops, discard either ending
wait target, or silently restrict reactivation/long-source cases. Audit adjacent
targets across each group boundary, source/wait neighbours and every observed
entry, withdrawal, confirmed/progress release and source-occurrence change.

## Unchanged numerical and temporal parameters

- Canonical topology/occurrence resolution and wait map from3f7b5e9;
  topology SHA256eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc.
  Freeze waits0/5. The original wait rule is at least30 completed visits on
  3dates with standing-time p75>=180s, all known beforeSeptember16.
- Brown training-path maximum90minutes; circular120-minute Gaussian clock
  weighting; weekday/weekend separation; effective sample count>=12 and
  at least3 dates each carrying>=5% of total weight; empirical q10/q90 bounds;
  production rounding of seconds. No post-outcome quantile or K tuning.
- Existing10-minute warmup,15-second GPS freshness,45-minute retained-source
  horizon, canonical release latches and phase/progress rules. Whole-target
  fallback when any group's historical support fails or point countdown<=60s.
  No smoothing, holding, horizon extension or occurrence-rule modification.
- Historical GPS must be same route/provider, gaps<=60s and speed<=22m/s.
  Replay raw observations chronologically with production stepManyWithVisits;
  preserve ambiguity and actual emission known_at, perform prefix-deletion
  assertions, never manufacture EOF completion or backdate knowledge.

## Later unopened evaluation set

Fixed prospective interval: **September23–29,2026, inclusive, ET**. These are
future calendar dates at protocol pinning. Include every date and all captured
Brown windows; report missing/unknown service and coverage separately. Do not
select days from their errors or widen the interval until a desired result
appears. If support is insufficient, report it and preregister a separate
extension before opening further outcomes. Only sufficiently complete archived
intervals can support connected outcomes; missing GPS is censoring, not service
absence or an invented arrival. No scoring of this interval is performed here.

Persist all forecasts, deployed comparators and both arms before attaching any
labels. Attach identical next-physical-visit labels with matching canonical
occurrences and connected resolved departure; do not skip an intervening stop
visit. Verify raw/input/model hashes and byte-identical paired label/baseline
streams. Report all forecasts/fallbacks plus the same union changed by either
of these two fixed arms. Per-arm changed subsets are descriptive only.

## Outcomes and unchanged gates

Visit-balanced width/MAE/coverage; early tails30/60/120s and late-tail magnitude;
source-journey/date clustering; every route/date/stop; introduced point/bound
ordering reversals; all causes and absolute-clock handoff movements. Report
GPS/provider continuity and observational gaps without filtering inconvenient
transitions. A mean gain never establishes that a large individual jump is
warranted. Handoff review remains unresolved and independently required.

Replay fixed-visit actions on common deployed-point5–20min arming, walks1/3/5/10
minutes,30s buffer and0/30s response delay. Compare both point and rendered-low
guidance against the corresponding deployed policy, preserving actual observed
departure, GPS continuity, point-decision parity, waiting time and censoring.
Do not claim actual rider misses or full frontend bus selection simulation.

All prior promotion gates remain: width improvement>=60s; MAE degradation<=20s;
coverage>=80% with loss<=2 percentage points; zero newly introduced early>60s
visits; early-rate increase<=1point; zero new false-now or point/bound ordering
reversals>30s; no additional paired avoidable action misses; satisfactory
handoff review. Require at least30 physical pickups,12 source journeys and
3 unopened service dates in proposed scope. This support floor does not replace
uncertainty assessment. No automatic deployment, threshold relaxation or
winner selection; if both qualify, report both with uncertainty and costs.

Temporary-freshness envelopes, source-age policies and occurrence-release fixes
are separate future experiments. None is folded into these fixed arms or
selected using the prospective validation outcomes.
