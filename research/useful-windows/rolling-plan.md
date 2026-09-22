# Frozen rolling-history experiment

Fixed before reading its scores, September21,2026. This is a diagnostic on
reused September17–20 outcomes, not a fresh promotion test.

Test the same seven K values (1,2,3,5,8,10,15) on every published route. Compare
each frozen-history control with a daily refreshed history, and compare both
with the deployed checkpoint overlay from baseline.ts. Hold wait locations,
topology, clock weighting, quantiles, support, source-clock release, and group
fallback rules fixed. Red paths retain the production45-minute cap; other
routes retain the previous90-minute research cap. No route-specific winner is
chosen automatically.

Each evaluation day uses only history completed before the **previous** ET
midnight: a full calendar-day embargo. For example, September18 forecasts
train on history before September17. Reconstruct training visits with the
current production reducer and retain the actual emission poll as known_at.
Require arrival, departure and known_at before the cutoff, including targets
and intermediate visits. The stored visit table backdates departures and lacks
a knowledge timestamp, so it is not used for training here. Stored visits
continue to supply the common historical evaluation labels. Reconstructed
training is applied to both frozen and rolling controls; this is not a claim
to recover the exact historical production reducer version or insertion time.
September17's rolling and frozen controls must be byte-equivalent. Completed
training paths require continuous same-route and same-provider GPS quality
checks, using only GPS fixes strictly before the fitting cutoff.
No same-day outcomes, actual future wait, or test labels enter prediction.

Persist all predictions before attaching arrival/departure labels. Report
every K, fallback, all-row and changed-row result, route/date/stop breakdowns,
independent visits/source trips, early-tail failures, coverage, error, width,
false-now, point/bound ordering, and observed handoff changes. The source-trip
count must use the candidate's actual K source, not the deployed K source.
Handoff audits include only consecutive snapshots within30seconds and report
unobserved gaps separately. Preserve exact deployed fallback, never substitute
the historical old estimator when a candidate is unsupported.

The same rider-action replay evaluates all arms. Sparse screen telemetry is
not a complete fleet census. This study's input is the existing frozen dataset;
the separate archive-coverage gate characterizes GPS availability, prediction
sampling and unknown service. No day is discarded because its outcome is poor.
All promotion gates in PLAN.md remain in force, including subsequent unseen
dates. No production parameter or UI change is made by this workflow.

Pre-score audit: production repairs some published route sequences. The
generator quarantines entire routes with any frozen/runtime sequence mismatch,
preserving the rejected rows and both sequences for investigation. This run
also keeps deployed fallback for any route with repeated stop IDs because the
inherited target lookup chooses the first occurrence. Those routes are
**untested**, not negative K results. A subsequent study must use canonical
runtime topology and occurrence identities consistently throughout the pipeline.
