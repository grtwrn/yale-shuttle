# Response to the September 2026 statistical review

This release makes the historical comparison describe observed journeys from
the shuttle's source stop to the rider's selected stop, and repairs the nightly
research validation. It does not publish new ETA coefficients or establish
nominal coverage for the displayed distribution.

## Rider display and historical sample

The primary pickup graph now contains recorded trips rather than model
quantiles. Each hollow dot is one connected journey reconstructed from
`stop_visits` and `legs`, with route occurrence and exact endpoint timestamp
checks. Historical ETA values do not select these observations.

For a bus confirmed standing at its source stop, examples must still have been
standing after the same elapsed time on the collector's pinned clock. The
graphed duration includes the remaining stop wait and travel. Approach rests,
ambiguous route occurrences, later laps and stale observations do not produce a
comparison. For a moving bus, the graph is explicitly the full travel time
after departure from its source stop; it is context, not an estimate of time
remaining from the bus's exact current position.

The sample uses the same weekday/weekend category and local time within two
hours, up to 24 recent completed journeys in 30 days. Source and target must
both have recorded stops. Missing paths, gaps and skipped endpoints are
excluded. These selection limits mean the examples are not a population
distribution or independent validation trials. The display provides sample and
service-date counts, an observed median when at least five trips exist, dated
records, the capture time and a manual refresh control. Recent arrivals remain
available when the source context cannot be matched.

The model graph is separately labeled and initially collapsed in pickup
details. Its dots remain modeled outcomes; no exact on-time probability or
nominal confidence claim is added. The class planner says a shuttle **may fit
your buffer** and makes the catch-the-bus assumption explicit.

## Calibration and evaluation

Historical calibration now excludes known outcomes that had not completed by
the cutoff. Legitimate unpinned passed visits remain in stop-probability
denominators. Legacy records still cannot establish exact ingestion and
confirmation availability.

The nightly fitter separates scalar training, correction fitting, correction
selection, final-candidate interval calibration and untouched testing into
successive date blocks. Cache receipts verify source/input/parameter identity
and artifact completeness. Diagnostics include route/horizon coverage, both
tails, matching rate, MAE and weighted interval score.

Automatic parameter promotion currently refuses to proceed because exact
outcome availability, per-trip evaluation identity and a verified historical
champion vintage are missing. The existing served model, warm state and
ordinary calibration-table refreshes continue. See
[calibration-validation.md](calibration-validation.md) for the actual gates and
limitations. A dry run against the available archive also correctly refused:
14 complete dates were available, while the chronological design needs 15.

## Release evidence

- All 2,690 tests across 117 files passed, along with backend and frontend
  typechecks and the production frontend build.
- Historical-journey tests cover actual SQLite paths, residual wait survival,
  repeated stop occurrences, gaps, wrong directions, future outcomes and sparse
  or missing source contexts.
- Existing server/browser ETA parity remained within its 0.5-second tolerance
  over the 40-poll replay. Live estimator pricing was not rewritten.
- Recorded Red mobile browser checks passed at 390 and 320 pixels, including
  dated dots, explicit moving/departure context after refresh, optional model
  expansion, history-service failure, feed failure, deadline editing and focus.
- A read-only query of production recordings returned 24 matching pickup trips
  across four dates and 24 destination trips across five dates for the frozen
  September 16 Red case. Query costs were approximately 8 and 15 milliseconds.
  These are descriptive query and UI checks, not accuracy estimates.
- The statistician reviewed the revised source-clock matching, survival
  condition and display labels and found no release-blocking issue.

## Further accuracy work

Before promoting a new model, export stable bus/visit identities and exact
availability timestamps, freeze model vintages, and evaluate by independent
service dates and bus runs. Validate the final displayed interval after all
clamps and widening, including late-class and missed-connection outcomes.
Standing-clamp changes and additional lap/headway covariates need this replay
evidence before release; this patch does not infer improvements from smoother
curves or narrower intervals alone.
