# General shuttle accuracy evaluation

The objective is to predict arrival times and total standing time accurately from the observations available when a rider asks. A successful change must work through a shared model across routes and stop occurrences. Route IDs may identify learned parameters; they must not select hand-written exceptions.

## Frozen comparison

The existing estimator is the production baseline. The undeployed Red departure-cycle experiment is preserved under `scripts/.eta-replay/overnight-2026-09-08/red-specific-baseline` as a diagnostic comparator. Candidate families are (1) a coherent empirical survival model with a learned recurring-departure expert and data-selected pooling, and (2) scikit-learn quantile gradient boosting with causal route, stop, clock, and prior-trip features. A full TransitClock/OneBusAway engine is assessed separately for adapter feasibility. No external engine is declared more accurate without a matched replay.

September 3 is discovery/training. September 4 is development validation and selects family/settings. Freeze configuration and code hashes before confirmation. After selection, refit on September 3–4 and confirm on September 5–6 plus the partial September 7 capture. Those days were inspected in earlier repository work, so they are reserved for this comparison, not a pristine external test. September 8 is the explicitly previously examined Red regression. September 9 captured after the freeze is the prospective test; sparse early-morning data cannot establish a whole-day result.

## Causality and scoring

Labels and model inputs must be separate. Use prior completed records only after their conservative availability timestamp, with route-pattern and sequence occurrence preserved. Never provide the current visit's eventual duration, next departure, or future GPS as a feature. Keep unresolved/censored records in coverage reports. A missing observation across a capture gap is not an arrival at the first subsequent GPS fix. Zero-duration passes belong in the population of future stops but cannot be sampled as the duration of a bus already known to be standing.

Select on equal-visit proper distribution score (CRPS or integrated quantile loss), with first-displayed total wait and remaining-time MAE as rider-facing checks. Report poll-weighted and equal-visit scores, signed bias, 90th-percentile absolute error, and both directions of errors greater than 120 seconds. Report route, stop occurrence, long-hold, first-lap/fallback, and forecast-horizon strata. Bootstrap paired differences by bus/day or visit; repeated polls are not independent evidence.

Promote a replacement only if it improves the held-out primary score and the matched end-to-end ETA score, improves the reported Red morning failure, and shows no material route-level regression hidden by aggregation. A route with sufficient support (at least 30 visits) worsening by more than both 10 seconds and 10% is a material regression requiring explanation and another development-only revision, not an exception. Tail changes must be reported even when means improve. Do not tune against confirmation outcomes; a revised candidate needs a new prospective test.

## Implementation and morning deliverable

Hold tracking fixed for timing-model comparisons. Separately audit whether maintaining browser-local state loses server history and whether a server-owned state model would help, without claiming an unmeasured architectural migration is better. A selected distribution must be used coherently for the total stand, its conditional remainder, and any departure hazard. Build the frontend and run relevant accuracy, collector, payload, and model tests after integration. Replay the actual rider-facing functions, not just a mathematical approximation. Preserve exact commands, input hashes, settings, predictions, and a concise recommendation in the repository report.

Local archival capture uses existing authenticated read endpoints. It does not change production tracking or submit user reports. Remote phone access is deferred at the user's request.
