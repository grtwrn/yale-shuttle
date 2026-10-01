# Completed sampled-lap comparison

**Yes: sample-wise lap scaling of the existing marginal tables merits an isolated release candidate after the corrected next-occurrence, route, and rider checks.** The evidence is materially better than the normalized-table candidate. It is a modest narrowing improvement for longer forecasts, not a solution to the standing-floor failure or proof of calibrated 80% coverage.

[sampled-result-review.py](sampled-result-review.py) independently recomputes MAE, WIS and both tail counts for all 45 groups in each of the marginal and conditional comparisons. [Checked results and hashes](sampled-result-review.json) preserve the evidence. Both use the same 1,495 checkpoints, 600-second warm cutoff, two retrospective dates, and first target occurrences below 20 stops ahead. Repeated checkpoints are not independent journeys.

For Union→Division, nominal marginal → sampled marginal:

| Checkpoint | n | Mean width | MAE | WIS | Early / late misses |
|---|---:|---:|---:|---:|---:|
| Pin +0 s | 30 | 1015.8→881.3 s | 201.4→197.1 s | 147.3→141.3 | 2/1→2/2 |
| Pin +60 s | 27 | 918.0→788.5 s | 163.2→162.0 s | 120.7→117.2 | 0/1→0/2 |
| Departure +0 s | 30 | 795.9→693.8 s | 212.5→205.7 s | 140.2→134.7 | 3/1→3/2 |
| Departure +60 s | 30 | 788.3→704.1 s | 160.9→156.9 s | 114.5→111.2 | 3/1→3/2 |

The first three widths fall approximately 13–14%. MAE and WIS improve on **each date separately** at these checkpoints, though September17 has only 4–6 Union observations. At pin +0, 18/30 forecasts improve absolute error by more than one second and six worsen; at departure +0, 21 improve and seven worsen. The extra late misses shown repeatedly above are **one #316 journey, source61538→target61866 on September16**. It exceeds the candidate upper bound by 77 s at pin +0, 109 s at +60, and 10 s at departure +0. Those are different views of one harder case, not three new failures. Given better proper scores and the user's stated tolerance for some tails, this is not by itself disqualifying.

Division upward arrival-time jumps above 60 seconds remain **16**, affecting 13 target visits; Rosenkranz remains **28**, affecting 19 visits. Counts above180 seconds also remain unchanged. These thresholds do not assert every individual value is identical. Winchester→Division standing +60/+180 and departure +0 are unchanged, so this arm leaves report115's low frozen waiting estimate unresolved.

The sampled **conditional-table** arm remains unattractive for broad rollout. It narrows more but shifts Union point predictions systematically later; at Union departure +0, MAE becomes252.8 versus212.5 seconds and WIS148.5 versus140.2. This is not merely accepting rare outliers. Some conditional standing WIS values improve despite worse point error, showing why the decision needs route/checkpoint detail rather than a single aggregate.

Before promoting the marginal-only candidate:

1. Use the corrected per-hypothesis `ownDeparture` implementation and test repeated/next occurrences. The completed replay began before that correction. Keep normalized tables and the current-only switch out of this candidate so its scope is reviewable.
2. Check every affected route and target horizon, including departures, pass outcomes, unknown laps, support boundaries, and second occurrences; explicitly restrict rollout if only Red has evidence. Check actual rider catch outcomes and availability, not only completed-journey point errors.
3. Check sampled-arm belief equality and wire `departNow`/`lowFloor` semantics. These are leave-now scenarios with joint regulation, not guaranteed lower bounds; do not enforce them as floors. Verify a separately evolving full-server path or stronger parity than the existing same-poll sampled check.
4. Keep the model version and uncalibrated interval language truthful. These are inspected development dates; freeze the final candidate for subsequent date-blocked calibration/confirmation. A marginal-only change can be assessed as a bounded algorithm improvement without claiming it has solved the broader conditional-duration problem.

The restart recovery repair is independently justified and should remain separately reviewable. Neither result requires automatically publishing new fitted coefficients.
