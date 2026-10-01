# Small historical rider batch

Completed in 148.7 seconds without a browser, one low-priority Node process, roughly 220 MB RSS observed and a 512 MB heap limit.

Input: September 10, 2026, 10–11 am ET; Red and Purple GPS. Riders open the app at 10:10 and 10:15, at eligible stops, then wait up to 30 minutes. 9,016 source rows reduced to 4,314 unique positions / 719 polls. Malformed source JSON rows were excluded before the slice. The original archive was unchanged.

80 riders generated; 24 skipped because the planner selected a different boarding stop. 56 waits simulated: 51 arrivals scored, four already at a bus, one gave up. This is a selected population, not all possible riders.

At 15-second canary cadence:

| Line | Scored waits | ETA jumps ≥3 min | Possible strand flags |
|---|---:|---:|---:|
| Red | 34 | 0 | 0 |
| Purple | 17 | 11 | 2 |

Four Purple waits also lost an approaching arrival from the estimator. The worst recorded drift was 580 seconds. One illustrative Purple stop-1 wait showed a pickup of 2 minutes at 14:17:39 UTC, then 12 minutes at 14:17:59. These are triage candidates, not confirmed production defects or regressions from the Purple fix.

Limitations: database calibration ends about 25 hours before the capture ends; an earlier fixed payload patch/model configuration supplies newer fields, so historical production estimates are not reproduced exactly. Folded-route curb detection is not independent boarding truth. The full sequence and per-rider details are in rider-sim.waits.jsonl; aggregate/configuration/provenance are in rider-sim.json. No baseline comparison or browser reproduction was performed in this inexpensive trial. No speculative app change or PR was made.

Conclusion: this is practical for finding candidate failures quickly. Next investigation should replay the flagged Purple episodes with contemporaneous calibration and validate the claimed pickup event before changing app logic. Prefer small sequential batches on the Pi.
