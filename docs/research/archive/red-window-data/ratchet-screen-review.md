# No-ratchet replay: statistical review

**Do not deploy this change from the present screen.** Removing the running minimum improves some early hold forecasts, but adds large upward jumps and worsens forecasts immediately after departure. It does not consistently narrow the intervals. Same-day table leakage, cold restarts, and only one service date prevent any calibrated or out-of-sample claim.

## Arm verification

[ratchet-screen-review.mts](ratchet-screen-review.mts) independently reproduces all **2,163 paired forecasts from 1,236 watcher frames**, and asserts that the two arms' beliefs are identical after every frame. It also asserts `ceilingArmsOnStanding() === false` before and after replay. With that switch disabled, clearing floors before each poll removes the accumulated running minimum without repeatedly selecting standing-only mixture components. An initial concern about repeated arming was checked and ruled out.

The [provenance artifact](ratchet-screen-review-provenance.json) records exact equality, code/input hashes, model version, and the nine state resets. The branch's ranking/UI work does not alter the pricing files hashed here.

## Outcome matching and effective sample

[ratchet-screen-review.py](ratchet-screen-review.py) matches each Winchester visit to the next Division/Prospect and Rosenkranz/130 Prospect occurrence through exact legs and intermediate arrival/departure links. There are **nine physical source visits, three buses, one date, and eighteen source/target journeys**. Both targets and multiple forecasts share those source visits; they are not eighteen independent rides or 2,163 independent trials.

The preselected checkpoints are 60, 180, 300, 420, and 600 seconds after the source pinned clock. The first paired forecast within fifteen seconds is used, only while the source visit still survives. This yields forty target/checkpoint records. No visit survives to the 600-second checkpoint. One source barely survives the 180-second boundary but has no forecast before departure, so that checkpoint is explicitly unavailable for both targets.

All nine pickup targets are stopped visits. Three dropoff targets are pass-throughs with observed proximity, so the primary dropoff table measures physical passage as well as stops. The JSON provides a stopped-only sensitivity analysis. Neither endpoint class independently proves boarding or alighting. Historical visits also contain yard repositioning; elapsed visit time is not a claim of continuous stillness.

## Component accuracy and uncertainty

The 60-second checkpoint uses one forecast per source journey per target. Later checkpoints are separate survivor cohorts, not additional independent rides. WIS scores the point and nominal central interval; lower is better.

| Target; elapsed | Journeys | Point MAE, current→no ratchet | Width, current→no ratchet | WIS, current→no ratchet |
|---|---:|---:|---:|---:|
| Division; 60 s | 9 | 143.7→135.4 s | 709.4→716.5 s | 95.2→92.9 |
| Division; 180 s | 5 | 110.3→92.4 s | 639.1→675.6 s | 79.4→75.8 |
| Division; 300 s | 3 | 58.7→51.1 s | 634.2→642.3 s | 61.9→59.9 |
| Dropoff; 60 s | 9 | 113.4→105.7 s | 771.3→767.8 s | 89.2→86.4 |
| Dropoff; 180 s | 5 | 52.3→100.8 s | 716.8→697.0 s | 65.2→80.1 |
| Dropoff; 300 s | 3 | 97.6→100.0 s | 661.3→657.2 s | 76.6→77.2 |

At 420 seconds both arms are identical for the three surviving source visits. All forty standing checkpoints fall inside both intervals: zero early and zero late interval misses in each arm. The intervals are broad and the sample is tiny and dependent; this is not evidence of calibrated coverage. The existing widening coefficients were retained and were not refitted for the no-ratchet candidate.

The dropoff result is sensitive to endpoint definition. On its six stopped targets at 60 seconds, MAE **worsens 72.4→76.4 seconds**; on its three stopped targets at 180 seconds, it worsens **54.2→135.8 seconds**. The apparent all-target improvement at 60 seconds is therefore not a reliable stopped-arrival benefit.

## Departure behavior and jumps

At the first forecast within fifteen seconds after the recorded departure:

- Pickup MAE worsens **72.8→119.7 seconds**. Point overprediction by more than 120 seconds rises from **0 to 3 of 9**. WIS worsens **54.8→73.0**; all nine intervals still cover.
- Dropoff MAE worsens **146.0→187.1 seconds**. WIS worsens **93.3→108.1**. Both arms have one early interval miss and no late miss.
- By 30 seconds after departure, the arms are nearly identical. Pickup has one late interval miss in each arm; dropoff has one early miss in each. This screen detects transient departure optimism/pessimism differences, not a measured persistent delay in every departure.

Adjacent forecasts are compared only within the same watcher run and at most twenty seconds apart, from source pin until sixty seconds after departure. Jumps refer to the **predicted absolute arrival time**, accounting for elapsed clock time. There are 302 adjacent comparisons per target, but the journey count is the meaningful denominator.

- Pickup positive jumps over sixty seconds: **0→8 events**, affecting **0→4 of 9 source visits**. The largest is **273.6 seconds**, including a 263.6-second increase in the displayed remainder.
- Dropoff positive jumps over sixty seconds: **0→7 events**, also affecting **0→4 of 9 source visits**; maximum **259.4 seconds**.
- Pickup negative jumps below minus sixty seconds increase **14→17**; dropoff **16→18**. Thus the candidate does not simply trade frozen forecasts for a smooth recovery.

The largest pickup reversal is journey **3:58224:58260**, Red #309, September 16 at **10:02:23.377 ET**, still inside its recorded Winchester visit. Current absolute-arrival revision is +10.0 seconds; no-ratchet is +273.6 seconds. It is not a watcher-reset transition. Full departure pairs and jump records are preserved in the JSON.

These findings are consistent with the earlier rejected reversal/departure-collapse experiments documented in `docs/eta-ring-posterior.md`. The current screen does not meet those regressions with contrary evidence.

## Provenance blocks a release inference

The model parameters were published September 16 at 04:21:41 ET, before the 07:14–10:27 forecast window. However, the **payload tables were captured around 10:26 ET**. A parameter version is not the version of the empirical tables.

The Winchester payload has `qn=230`. Reconstructing its ten rounded quantiles from the read-only DB reproduces the payload **exactly**: `[9,120,145,191,300,355,440,505,584,710]`. This pool comprises 221 records completed before the first forecast plus **all nine same-morning source visits being scored**. Their IDs are 56968, 57100, 57226, 57463, 57581, 57789, 57965, 58061, and 58224. Future test outcomes are therefore part of the supplied empirical table. Other tables and lap-fit provenance have not been certified as causal either.

The replay also starts empty and resets on **nine watcher run IDs**. Two of the nine source visits span such a reset during the hold. Equal resetting makes this a useful paired mechanism diagnostic, but does not reproduce the continuously warm production service or the complete lifetime of its ceiling. The forty checkpoints have fresh recorded feed ages (maximum about five seconds), so staleness at those chosen checkpoints does not explain away the observed tradeoff.

## Recommendation

The running-minimum translation remains statistically suspect as a predictive-distribution operation; this screen does not make that operation correct. It shows that simply removing it exposes instability and departure errors in the current mixture, so a mathematical concern alone is insufficient to ship its deletion.

Continue with a causal, continuously warm replay using tables built only from previously available outcomes, repeated over independent later dates. Freeze the candidate before final evaluation and recalibrate its actual outputs on separate calibration dates. Keep the known departure and reversal fixtures, compare both interval tails/WIS and missed-connection outcomes, and count whole source journeys and service dates rather than frames. A conditional hold/state model should be evaluated alongside any presentation change. Do not narrow intervals cosmetically or relabel this screen's 40/40 coverage as confidence calibration.

Reproduce the arm checks by running `node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/red-window-data/ratchet-screen-review.mts` from the service directory, then `python3 red-window-data/ratchet-screen-review.py` from the workspace root. Only analysis artifacts are written. No app code, production state, coefficients, or recorded data were changed.
