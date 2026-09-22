# Protected highway windows: fixed plan before scoring

This research-only study starts from commit `00bfa2e4545c76dfbb18fbcb9944479acfcedf5a`. It transforms already-frozen forecasts; it does not fit models, select K, change quality rules, or use new dates. September 17–20 remain reused development dates. No production, archive, watcher, or schedule changes. All replay, fixtures and evaluation run on GitHub hosted runners.

## Pinned source and two quality policies

Use completed highway study run `35688081446`, implementation commit `a15928c15184e49c8ca01790f09b2b81a3e16343`, artifact `highway-context-window-results`, artifact ID `10678256735`, GitHub artifact SHA256 `b153fdd8de2b259692f90a6b46619be45cba7356342154d65f132cee3f4159e3`. Verify that metadata before computation and record exact SHA256s of every consumed file. Original raw/prediction hashes, static geometry hashes and source plan hash remain those in the completed study. Source bytes remain immutable.

Evaluate `highway25` as primary and `highway50` as the fixed sensitivity, retaining all seven Ks (1, 2, 3, 5, 8, 10, 15) in both frozen and daily-refreshed modes. Preserve their existing causal features, training cutoffs, whole-group support, occurrence handling, source/release evidence, 15-second freshness and 45-minute live-origin clock exactly. No refitting or retuning. The geometry-aware policy is used unchanged for action connectivity; policy labels are reused exactly, never recomputed.

## One deterministic transform

For every Green or Purple unscored row and every one of its 14 raw arms:

```
eta  = deployed.eta
low  = min(deployed.low, raw_candidate.low, deployed.eta)
high = max(deployed.eta, raw_candidate.high)
```

For every other route, every arm equals the exact deployed forecast. No rounding, clipping, smoothing, latching, new clocks, fallback changes, or additional variants. Raw candidates and their original evidence remain preserved separately. Explanatory `changed` flags reflect the transformed forecast; an origin counts toward actual source-trip support only when the transformed arm differs from deployed. Retain the original raw evidence for auditing this distinction.

Persist the complete transformed unscored streams before reading/joining the source labels. Join on the original forecast key and assert every label, truth, cohort flag, deployed prediction and causal feature is unchanged. No outcome influences the transform, arm availability, or support.

## Identical cohorts and mandatory reporting

Within each policy, all arms and exact deployed use the same policy-labelled cohort. Retain the original canonical-labelled snapshot subset and policy-added snapshot subset. These can overlap in physical visits; report exact overlaps and entirely new visits explicitly. Also report:

- Full route denominator, including unchanged fallbacks, and all generated/labelled/changed snapshots, physical visits, actual changed source trips, and dates.
- A shared union where any protected arm changes, all arms evaluated on it, and a separate fixed union where any original raw arm changed. Keep the latter fixed so the transform cannot conceal lost availability or weaker raw arms.
- Raw arm, protected arm, and deployed comparisons on those same unions and on each individual raw-arm changed subset; frozen/refreshed same-K unions; primary/sensitivity common cohort and sensitivity-only additions. Retain every K regardless of results.
- Visit-weighted MAE, width, coverage, early tails at 0/30/60/120 seconds, late tails, severe new early visits, false-now, stop ordering, endpoint movements, and same-physical-pickup handoffs. Report unresolved, next-occurrence and gapped transitions explicitly.

Rider action uses the unchanged fixed-bus/physical-visit arming, all 1/3/5/10-minute walks, 0/30-second response delays, 30-second buffer, point/raw-lower/rendered-lower rules and censoring. Run both the full policy cohort and original snapshot cohort. Compare with deployed using both the same action policy and the source study's deployed-point baseline. Report all attempted/scored counts, newly missed/rescued visits, all censor reasons, and paired waiting differences conditional on both reminders triggering. Original action arming/deployed records and every protected point-action result must match the source exactly; point invariance is a structural control, not evidence of improved calibration. No statistical safety claim from unscored/censored cases.

## Pre-score controls and display checks

Before scoring: synthetic transform fixtures, immutable source metadata/file hashes, exact deployed forecasts, no point changes, no later lower endpoints, valid ordered finite windows, all non-target routes equal deployed, row-by-row transformation independent of future/outcome fields, and full-stream/prefix deletion parity. Original source prediction/label joins must be bijective for the labelled cohort. After action replay, require exact deployed action/arming controls, exact point-decision controls, no later lower-based triggered action where both are scored, and actual application-renderer parity for every policy/cohort. Test aging/rounding/expired-window boundaries explicitly.

Retain raw coverage and tail deterioration in the report even when a protected arm looks better. Freshness fallback and handoff discontinuities remain part of the original model and must be measured, not silently repaired. No threshold changes or promotion based on these reused dates. A failure is reported with its denominator and stops any deployment claim.
