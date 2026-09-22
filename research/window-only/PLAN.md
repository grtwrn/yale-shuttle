# Window-only hybrid experiment, frozen before scoring

Research only; no production model, UI, or distribution export changes. Base
commit3f7b5e9, immutable canonical artifact35684356219. September17–20 remain
reused diagnostic dates, never a fresh holdout. No new fitting or K selection.
Run transformation, scoring, tests, and action replay only on GitHub runners.

For every frozen/rolling K1,2,3,5,8,10,15 arm already emitted in canonical
unscored predictions, retain its causal support decision. Unsupported rows
return the exact deployed forecast. For supported rows use:

```
eta = deployed.eta
low = min(deployed.low, candidate.low, deployed.eta)
high = max(deployed.eta, candidate.high)
```

This combines a deployed point forecast with an empirically estimated upper
tail and an early bound no later than deployed guidance. It is a hybrid
interval, not a fitted distribution whose mean is guaranteed to equal that
point. No coherent50-quantile export is claimed. Quantiles/route parameters are
not tuned, scaled, or chosen after observing outcomes. Windows may widen.

Write every transformed unscored row before opening canonical forecast labels.
Join by exact at/bus/route/physical target and verify occurrence indices, all
noncandidate feature fields, deployed forecasts and original candidate fields.
Copy canonical label and truth exactly, and require equal record order/count
and byte-identical serialized label/baseline streams. Do not relabel, filter
outliers, impute outcomes, or change any raw input. Preserve canonical raw and
prediction-log hashes, input-file hashes, and their manifests in the artifact.

Report all labelled rows (including fallback), the SAME route-wide union where
any transformed arm differs from deployed for comparing every K, and the SAME
frozen/rolling union for each K. Per-arm changed subsets are descriptive only.
Also compare each hybrid with its underlying canonical candidate on the same
union where either differs from deployed. Visit-balanced metrics and unique
physical visits, actual source journeys, service dates, route/date/stop slices,
unmatched/fallback denominators accompany every comparison.

For Red additionally split every common comparison by production target scope
(wait14, canonical targets15–28) versus expanded targets, and independently by
deployedChanged (checkpoint actually applied) versus current live fallback.
These states can overlap within one visit; their visit counts are not additive.
Do not call a target-only slice a replay of production's activation/support
gates. Preserve full-route failures and the original canonical group decisions.

Measure width, MAE, coverage, early tails30/60/120s, late-tail error magnitudes,
false-now, introduced point/lower/upper ordering reversals, and same-physical-
visit entry/release/refit jumps including their observation gaps. Reuse the
fixed-bus/target-visit action proxy with common deployed-point5–20min arming,
walks1/3/5/10min, buffer30s, response0/30s, and GPS continuity through observed
departure. Report point/raw-lower/rendered-lower guidance, waiting and misses,
common-pair support, and censoring. This is not a full rider journey simulation.
Verify rendered guidance against the actual production formatter.

Hosted invariants: deployed point unchanged; lower never later; valid ordered
bounds; unsupported output exactly deployed; all labels/baselines unchanged;
all raw hashes unchanged; point action decisions identical; no newly early
or false-now forecasts. Keep every existing promotion gate in
../useful-windows/PLAN.md, including width>=60s improvement, MAE degradation<=20s,
coverage>=80% with<=2pp loss, zero introduced severe early/false-now/ordering
failures, no additional paired avoidable action misses, and fresh unseen
support>=30pickup visits/12source journeys/3service dates. No automatic winner
or promotion; width reductions cannot excuse late coverage loss or bad handoffs.
