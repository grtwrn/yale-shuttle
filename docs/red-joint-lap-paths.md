# Red: carry travel uncertainty into future regulated waits

Red's previous calculation evaluated each future lap using one nominal
travel time, then independently added that stop's scaled wait distribution.
An early trip and a long regulated wait were independent in the calculation,
although the fitted lap relationship says early returns usually wait longer.
This unnecessarily widens forecasts spanning a future regulating stop.

The Red calculation now carries each of the existing 256 fixed sample paths
forward. Each future wait's existing lap factor uses that path's arrival and
previous departure time. Departure clocks update on each simulated visit,
including the bus's observed departure before the collector clock catches
up. That bridge is computed separately for standing and moving hypotheses.
Zero-duration draws remain zero. Current-rest survival, historical tables,
lap coefficients, movement tracking, and display clamps are unchanged.

The change is restricted to route 3, where it was measured. Other routes,
missing lap clocks, and tables with no lap fit keep the previous calculation.
The existing `departNow` diagnostic is a leave-now scenario, not a guaranteed
lower bound: leaving earlier can cause a longer regulated wait later.

## Historical comparison

The final replay used 12,654 recorded polls from September 16 and partial
September 17, a prior-table cutoff of September 14, and parameter version
`fit-2026-09-15`. It reconstructed served observations causally using the real
collector reducers, including legacy departure clocks. Both arms used the
same GPS, filter, tables, parameters, and display floors. There were 36,516
identical tracking-belief comparisons and 924 sampled full-server output
parity checks. No short trips were deleted and no interval-width cap added.

Seconds, baseline → joint paths; first target occurrence, at least 10 minutes
of recorded warm-up. Repeated checkpoints are not independent journeys.

| Context | n | Mean absolute error | Mean window width | Weighted interval score |
|---|---:|---:|---:|---:|
| Union → Division, stop entry | 30 | 201 → 197 | 1016 → 881 | 147 → 141 |
| Union → Division, departure | 30 | 213 → 206 | 796 → 694 | 140 → 135 |
| Union → Rosenkranz, stop entry | 29 | 252 → 249 | 1018 → 878 | 166 → 159 |
| Union → Rosenkranz, departure | 29 | 266 → 258 | 846 → 727 | 165 → 158 |
| Winchester → Division, waiting +60 s | 47 | 224 → 224 | 569 → 569 | 114 → 114 |

The primary longer-trip windows narrow about 13–14%, with small point-error
improvements on both dates. Upward point jumps above 60 seconds remain
unchanged in the original first-occurrence comparison. This does not resolve
the separate long-Winchester-wait display ratchet from report 115.

An independent review also matched a complete 29-hop lap between first and
second physical target arrivals. It found 574 paired checkpoints over 49
distinct next arrivals. Winchester → Division at source departure improved
mean absolute error 279 → 246 seconds and weighted interval score 176 → 149.
There are new tail misses, concentrated in a few trips. Lower-bound upward
jumps increased even though aggregate point-jump counts did not. More
predictions fit inside the 90-minute serving limit; availability gains were
counted separately, not treated as paired accuracy improvements.

Static boarding commitments at point ETA minus 120 seconds or lower bound
minus 60 seconds produced no new after-departure commitments in 445 paired
stopped-target checkpoints. This is a diagnostic, not a simulation proving
that actual riders will miss fewer buses. Passed targets were not counted
as verified boarding opportunities.

## Checks and limits

- All 2,721 tests on this branch's base and both TypeScript checks pass.
- New tests isolate travel/wait compensation, verify unchanged other routes
  and fallbacks, and check ordered finite distributions through departure
  and both later occurrences.
- A bounded full-server benchmark, 100 warm-up and 200 scored polls per arm,
  measured mean computation 12.7 → 16.9 ms and p95 16.4 → 22.2 ms, with zero
  failures. This is a local benchmark, not a production latency guarantee.
- These two dates have already been inspected during development. They are
  retrospective evidence, not an untouched confirmation set or proof of
  calibrated 80% coverage. The replay lacks prior-day collector seeds.
- Conditional replacement dwell tables were rejected separately because
  they systematically made longer forecasts late. They are not part of
  this change. The existing pin-time versus broad-rest definition mismatch
  is also unchanged.

The reproducible working artifacts are in the operator workspace's
`conditional-replay-data`: `replay-joint-release.mts`, `joint-release-pairs.jsonl`,
`joint-release-meta.json`, `joint-release-score.json`, independent
`joint-next-occurrence-review.py` and `joint-next-occurrence-tails.py`, and
`benchmark-joint.mts`. Inputs are `raw-frames.jsonl`, `baseline-patch.json`,
`params.json`, and the read-only `outcomes.db`. The paired control is
`setSampledFutureLap(false)`; the production default enables it for Red.
