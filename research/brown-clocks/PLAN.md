# Brown clock lifetime factorial, frozen before implementation/scoring

This research-only extension retains BOTH Brown frozen K8 and rolling K5;
neither is a selected winner. Fixed development inputs are canonical run
35684356219, window-only run35685527686 and raw run35677536788. Evaluate ONLY
September17–20,2026 ET, on the identical canonical physical-visit labels and
recorded deployed comparator. Never score September21 or later dates here.

For each lead, cross exactly two causal source lifetimes and two observation
freshness contracts (eight arms total):

| Factor | Current | Prespecified alternative |
|---|---|---|
| Source departure age | <=2700s | <=5400s |
| Last actual observation age | 0..15s inclusive | 0..<45s, strictly |

The source limit originated in Red PR312/c294fde, was retained in Blue
replay95645f6 and production PR316, then remained unchanged when the Blue
diagnostic changed ONLY the training path cap to90minutes. It is an inherited
validity guard, not a Brown-calibrated cap. Ninety minutes is the already fixed
Brown training-path maximum, not a constant selected from these errors.
Fifteen seconds is canonical-windows/replay.ts readiness and collector
k10Clock.ts snapshot freshness; the server k10Trial.ts/blueK10Trial.ts also
recheck it. The alternative is ETA_MAX_AGE_MS=45_000 from web/etaSource.ts,
enforced strictly by serverEta.ts per-bus live filtering. Brown currently has
no production checkpoint overlay. Existing support does NOT validate either
alternative in advance.

## Causal evidence and exact controls

Replay chronological raw observations using production stepManyWithVisits.
Keep histories and one-way release latches independently for each source-age
factor. Extend BOTH origin export and release processing to the same horizon;
never export a source absent from that arm's actual causal history. Require
source.departed<=source.knownAt<=asof, departed<=phase.began, and actual reducer
emission as knownAt. No EOF completion, arrival+invented dwell, simulated GPS,
backdated knowledge, or new phase/progress on request ticks.

The freshness alternative uses the most recently observed valid phase and
the actual observedAt, with elapsed time subtraction only. A new observation
with unknown/invalid phase invalidates eligibility immediately; do not carry
an older valid phase through it. Route change, provider ID change, simultaneous
name contention, and gaps>60s clear warmup/history/release evidence. Unknown
identity is unavailable. An ambiguity reset itself cannot create a source.
Apply these guards to every cell; preserve ten-minute warmup. If they change
the original45min/15s controls, retain a discrepancy audit and HALT BEFORE
aggregate scoring instead of claiming a pure factorial comparison. Do not
silently weaken guards to pass parity.

Completed last-wait departures and observed forward progress keep one-way
release for that exact source departure. Once released, phase return never
revives it. A later causally emitted source departure is a distinct occurrence.
The existing K8 modulo/phase-return ambiguity without a recorded release is
reported separately and remains a promotion concern; no occurrence-rule repair
is folded into this experiment. Route/provider ambiguity never carries evidence.

Before opening outcome rows, hosted tests must cover15s/45s observation
boundaries,45min/90min source boundaries, future/missing source knowledge,
known last-wait release, phase-only release, irreversible release on phase
return, genuinely new source, delayed emissions, provider/route/name reset,
and source/release horizon alignment. Replaying after deletion of future raw
polls/predictions must leave every earlier feature byte identical, including
cutoffs inside the new freshness and source-age ranges.

Reproduce canonical Brown feature fields and BOTH original lead forecasts,
reasons/evidence, and window-only transformed control forecasts exactly before
scoring. Persist all eight unscored candidate streams first, then attach exact
existing labels/truth/deployed baseline/occurrences. Preserve original raw and
protected prior artifact hashes; never use final labels to resolve features.

## Fixed estimator and full scope

Keep canonical3f7b5e9 topology, Brown route11, waits0/5, every full target group:
wait0→1..5, wait5→6,7,8,0. FrozenK8 source indices1/6; rollingK5 sources4/0.
Keep unchanged source visits known beforeSeptember16 midnight ET for frozen;
rolling dayD uses actual known_at strictly beforeD−1 midnight ET (full prior-day
embargo), and GPS training quality uses only raw fixes before that cutoff.
Keep90min paths,120min circular clock bandwidth, weekday/weekend separation,
12 effective paths and3 material dates with>=5% weight each, empirical q10/q90,
production rounding, whole-group support, and whole-group point-countdown<=60s
fallback. No quantile tuning, smoothing or cosmetic bound clipping.

For every supported candidate retain exactly:

```
eta = deployed.eta
low = min(deployed.low, candidate.low, deployed.eta)
high = max(deployed.eta, candidate.high)
```

Unsupported candidates equal deployed in all fields. The hybrid has no coherent
50-quantile distribution; do not export probabilities or alter planner behavior.

## Comparisons and unchanged gates

Report all rows and the SAME union changed by any of eight arms; also a fixed
union of the two original controls. Compare every cell on matched rows, visits,
source journeys and dates; per-arm changed-only subsets are descriptive.
Factor contrasts use that same union, never favorable per-cell subsets.
Report width, fraction narrower/wider/unchanged, MAE, coverage, early/late tails
and magnitudes, by source/date/stop, introduced false-now/ordering, and every
same-physical-visit handoff reason and absolute bound jump. Preserve unmatched
transition denominators and evaluate adjacent full-group targets. Use the
production primary-window formatter at0/5/15/30s aging; count unavailable bands
separately, and show printed widths/coverage/consistency alongside raw metrics.

Run fixed-visit action replay with common deployed-point5–20min arming,
walks1/3/5/10min,30s buffer and0/30s response delay, both point and rendered-low
policies. Keep identical deployed actions/control actions. Report matched
misses, earlier reminders and added waiting, plus censoring; this remains a
hypothetical action-risk proxy, not actual rider misses or full app selection.

All previous gates remain: >=60s width gain; <=20s MAE degradation; coverage
>=80%, loss<=2pp; no introduced early>60s visits; early-rate increase<=1pp; no
new false-now or ordering reversals>30s; no added paired avoidable action misses;
satisfactory handoff/occurrence review. Promotion separately needs>=30 physical
pickups,12 source journeys and3 unopened dates and uncertainty assessment.
Development reuse cannot satisfy fresh-date support. September23–29 prospective
validation remains unopened and is NOT automatically authorized by this run.
Retain all eight results without selecting a winner, relaxing gates or widening
date/route scope. Heavy tests/replay/fitting/scoring run on GitHub only.
