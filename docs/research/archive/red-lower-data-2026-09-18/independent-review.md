# Independent review: raising Red's lower arrival bound

September 18, 2026. Read-only review of the frozen broad ablation, saved continuous forecasts, outcome records, and the rider-facing decision rules. No application edits, fitting, replay reruns, record exclusions, or deployment.

**Verdict:** the broad removal of lower-side widening is not supported across both targets. A narrower, explicitly frozen Winchester-to-first-Division policy is a defensible next candidate: its pickup intervals improve, and the audited small early-arrival errors did not put the raised bound beyond the recorded pickup departure. This is evidence of a useful tradeoff, **not a guarantee that riders cannot miss a bus**. The narrower target policy was proposed after these results, so its next integration/prospective evaluation must be described honestly as such.

## What the experiment establishes

`PLAN.json` prespecifies one ablation. `build.mjs:4` changes only the lower widening and corresponding distribution transformation while the supported current Winchester release model is active. Separate processes preserve the original global-cache chronology. `pair-validation.json` confirms all **150,020** saved forecasts match identities; the baseline reproduces overnight cycle 14 exactly; point and upper forecasts are unchanged; 8,071 lower forecasts change. Each arm has 16,253 frames and 151 full-server parity comparisons. My independent hash comparison finds the saved tracking diagnostics byte-identical.

The main scorer requires 600 seconds of warm history, uses exact connected source/leg/target chains, and reports independent visit checkpoints rather than treating every poll as an independent observation. Its interval-score formula appropriately penalizes both excessive width and missed bounds. Repeated checkpoints, visits within the same day, and related target contexts remain dependent. Two previously inspected dates do not establish calibrated coverage or statistical noninferiority.

The September 18 morning replay adds seven complete Winchester-to-Division visits. It uses pre-September-14 marginal tables and the causally prior September 17 13:14 fit, **not an exact reconstruction of that morning's received production calibration**. It is a useful new-date check of the frozen broad ablation, but too small for a reliable tail-rate estimate; it also becomes development evidence for a target policy chosen afterward.

## Pickup benefit versus destination regression

| Context | Visits | Mean width, baseline → candidate | Arrivals before lower bound |
|---|---:|---:|---:|
| Division, Winchester stopped +60 s, Sep16–17 | 60 | 522.5 → 466.4 s | 0 → 0 |
| Division, stopped +180 s, Sep16–17 | 38 | 436.7 → 364.0 s | 0 → 0 |
| Division, source departure +5 s, Sep16–17 | 61 | 256.8 → 222.9 s | 0 → 3 |
| Division, stopped +60 s, Sep18 | 7 | 735.4 → 689.9 s | 0 → 0 |
| Rosenkranz, source departure, Sep16–17 | 59 | 464.5 → 412.8 s | 4 → 17 |

Division's checkpoint interval score improves on both old dates and the small new date. Rosenkranz's departure interval score worsens on **each of the three dates**, including the stopped-target subset: on Sep16–17, stopped-target early misses rise from 3/38 to 12/38 while interval score worsens from 64.9 to 69.3. This is systematic loss of lower-tail accuracy, not merely one unusual observation. Retain those records. A narrower width is not sufficient evidence of improvement there.

For this user's **Division pickup → Rosenkranz dropoff**, an early Rosenkranz arrival is not a missed pickup. It still matters for honest destination windows. The class-deadline test uses the unchanged destination upper bound (`web/src/journeyArrival.ts:69`), so this ablation does not improve its upper-tail assurance.

## Continuous pickup and departure audit

Reproducible artifacts: `independent-continuous.py`, `.json`, `.log`. Each completed Winchester-to-Division journey contributes its worst lower-bound error over all warm polls from source pin until target arrival. Compare the absolute forecast lower timestamp against **both target arrival and target departure**. Hypothetical margins of 0/15/30 seconds mean planning to reach pickup that many seconds before the lower timestamp; these are not measured rider outcomes.

The replay omits at-stop zero-hop rows. Four saved old polls just before the detector's arrival contain only the **next lap** (`stopsAhead=29`). I explicitly count and exclude those from this physical arrival rather than score them as approximately 50-minute misses. All four are identical between arms. The original fixed-checkpoint scorer also needs this occurrence caveat when interpreting very near-arrival rows; none of the newly changed cases below depend on it.

- **Sep16–17:** 61 connected Division targets, including 53 stopped targets. Of these, 55 visits have changed lower forecasts, including 47 stopped targets. At changed rows, baseline/candidate have **zero** lower timestamps beyond detector departure at all three margins. The least spare time for a changed stopped target is **22.85 seconds**. Considering all correctly matched rows, both arms also have zero such departure misses; the smallest spare time is 11.97 seconds on an unchanged row.
- **Sep18 morning:** seven stopped targets, four with changed lower forecasts. Both arms have zero lower timestamps beyond detector departure at all margins. Changed rows retain at least **56.64 seconds** before detector departure.
- No matched target in these data has an unknown departure. The script retains an explicit unknown-departure list and does not interpret missing departures as successful catches.

The new early Division cases are real observations, not evidence to discard:

| Winchester source → Division visit | Date | Maximum arrival-before-raised-low | Observed target hold |
|---|---|---:|---:|
| 64318 → 64338, bus309 | Sep17 | 23.46 s | 50.01 s |
| 65347 → 65364, bus309 | Sep17 | 3.17 s | 29.97 s |
| 68304 → 68322, bus300 | Sep17 | 1.98 s | 24.83 s |
| 70927 → 70954, bus309 | Sep18 | 3.23 s | 59.88 s |

`independent-cases.py/.json/.log` preserve the visit clocks, exact leg IDs, source-departure GPS and target-arrival GPS. These targets come within approximately 4–16 metres of the stop and have observed stationary samples; their source-to-target raw streams have roughly five-second sampling with no long gap. The larger Rosenkranz regressions, including source visits 58061, 60375, 65347, 66730, 67957 and 68304, also have connected observed paths and continuous raw evidence. Some Rosenkranz targets are passes; the stopped-only regression above confirms the problem persists without treating passes as boarding opportunities. No new measurement error justifies deleting these cases.

Detector arrival/departure and GPS proximity are proxies, not verified door-open intervals. Remaining at the curb does not guarantee boarding remains possible. Walking-time error, reaction time, and missed notifications are also absent from this diagnostic. Known truncated source record 65237 limits elapsed-hold interpretation; that does not justify discarding its separately observed outgoing journey or target.

## The actual rider-policy implications

1. **Catch warning changes:** `web/src/journeyArrival.ts:64` compares walking time directly with `board.low`. There is no 60-second buffer. Raising the low bound can remove a warning and change the class-planner recommendation. The summary's `missWith60secBuffer` is a hypothetical diagnostic, not the current UI policy.
2. **Leave reminders do not change:** `web/src/leaveAlert.ts:19,49` uses the unchanged point ETA minus walking time minus 30 seconds. This ablation does not demonstrate improved reminder timing or fewer missed rides.
3. **Forecast interval and action deadline differ:** a lower forecast quantile may legitimately be exceeded by early arrivals. It must not be described as an earliest possible arrival or guaranteed safe leave-by time. Useful tighter intervals can coexist with conservative catch guidance that also accounts for walking uncertainty.

For a targeted next candidate, preserve all other targets/occurrences, forecasts, point estimates and tracking, and verify the distribution agrees with the displayed bounds. Freeze the scope before the next data review. Gate on equal-visit interval scores and real catch-warning behavior around pin, shuffle and departure transitions; retain valid short trips; record availability and unknown outcomes. The present evidence supports that bounded implementation and validation. It does not support deploying the broad ablation or claiming calibrated/no-stranding performance.
