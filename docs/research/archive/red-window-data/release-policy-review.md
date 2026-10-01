# Independent review: hourly service roles and remaining-wait models

**The observed quarter-hour pattern is consistent with individual buses repeating approximately hourly cycles at different offsets. The clock-modulated departure hazard is a promising retrospective component result, but neither it nor the new causal slot predictor is ready to substitute for the live ETA model.** The causal-wire shadow confirms a strong held-stop signal and identifies concrete switch/departure regressions that block that direct replacement. No application, production, coefficient publication, or database changes were made by this reviewer.

Reproduce the independent artifacts:

```sh
python3 red-window-data/release-policy-review.py
python3 red-window-data/release-survival-review.py
```

The first script reads `operating-pattern-screen.json` and `outcomes.db` read-only, writes the slot experiment and descriptive phases to `release-policy-review.json`, and exactly reproduces the parent's lap comparator. The second reads the preserved **five-arm** survival results and independently reconstructs every saved CDF quantile and aggregate MAE/WIS; its support and sequential checks are in `release-survival-review.json`. Input hashes are recorded. The later sixth slot arm is identified separately below rather than retroactively folded into the original five-arm comparison.

## Quarter-hour alignment can be an hourly-slot alias

Using the same complete stopped-visit cohort, and requiring at least three recorded departures per bus/day:

| Stop | Bus-days / departure observations | Successive recorded gaps | Median gap | Gaps 55–65min | Gaps 50–70min |
|---|---:|---:|---:|---:|---:|
| Winchester | 28 / 257 | 229 | 60.04min | 195 / 229 (85.2%) | 212 / 229 (92.6%) |
| Union | 29 / 276 | 247 | 59.86min | 213 / 247 (86.2%) | 240 / 247 (97.2%) |

Eight Winchester and five Union gaps exceed 90 minutes. These are successive **recorded completed holds**, not proof that no intervening visit was missed. They have not all been connected through exact route legs. This limitation does not erase the dominant approximately 60-minute recurrence, but prevents calling every gap a measured physical loop.

Median within-bus/day circular concentration is about .979/.981 for 60-minute phase and .760/.761 for 15-minute phase. These R values have different angular scales and should not themselves be compared as measures of seconds of precision. Converted to circular spread in seconds, median 60-minute spreads are 119/112 seconds and median 15-minute spreads 106/106 seconds. The important evidence for an hourly interpretation is the observed recurrence interval plus stable bus/day minute-of-hour offsets, not merely the larger R60.

For example, on September 16, Winchester departures cluster near:

- #309: minute 02;
- #308: minute 33;
- #316: minute 46.

At Union the same buses cluster near 31, 00, 15 respectively. Thus a fleet-level 15-minute harmonic can appear even though an individual bus completes an approximately 60-minute cycle; it does not imply a bus every 15 minutes or that each bus is allowed to depart at every quarter-hour.

The assignment is not fixed to the vehicle number. #316's Winchester phase is near 45 minutes on September 14,02 on September 15, and 46 on September 16; its Union phase is near 15, 30, 15 on those dates. A static bus intercept is a weak proxy for a changing service role. This supports a causal service-block/history feature as a hypothesis. It does **not** establish the drivers' instructions, exact scheduled release times, or whether changes reflect dispatch, relief, lateness, or observation effects.

## A small causal slot experiment

I tested three centers against the exact lap comparator from the earlier screen:

1. Previous **modern** same-stop departure plus 3600 seconds.
2. Previous **legacy** same-stop departure plus 3600 seconds.
3. The circular hourly phase of the **two previous modern departures**, projected to the next hourly slot near latest departure+3600 seconds.

No retrospective per-bus/day phase enters these predictions. Every prior event is same-day, known before the current pin under the stated availability safeguard, with an opposite-regulator departure between the last own departure and current pin. The two-history arm also requires an opposite-regulator observation between its prior own departures and a fixed 30–90-minute spacing between them. Current prior-departure age uses the same training-derived 0.65–1.65 lap support as the existing screen; it never uses the current hold's eventual outcome for eligibility. Modern availability is observed completion/confirmation evidence plus 120 seconds of grace; legacy lacks exact receipt metadata and uses departure+120 seconds. Both assumptions are conservative proxies, not audited historical publication times.

Each slot receives a per-stop median `observed departure − predicted slot` correction from **training only**. Missing/unsupported slots fall back to the identical fitted lap baseline. Separate September 10–11 residual quantiles then supply final bounds and median; this calibration can change the displayed center, so the JSON also reports corrected-center MAE before that step. Fit dates are September 3/4/8/9, evaluation dates 14–17; all are already inspected development data.

| Stop/model, all eligible test cases with fallback | n | MAE | WIS | Width | Early / late misses |
|---|---:|---:|---:|---:|---|
| Winchester: lap | 99 | 107.4s | 68.4 | 330.1s | 12 / 7 |
| Winchester: modern last departure+hour | 99 | 109.7s | 74.1 | 310.7s | 16 / 6 |
| Winchester: legacy last departure+hour | 99 | 114.5s | 77.9 | 305.0s | 17 / 7 |
| Winchester: two modern phases | 99 | 100.6s | 70.4 | 415.0s | 9 / 1 |
| Union: lap | 103 | 129.7s | 86.0 | 375.9s | 21 / 5 |
| Union: modern last departure+hour | 103 | 122.4s | 83.4 | 284.3s | 21 / 9 |
| Union: legacy last departure+hour | 103 | 126.6s | 84.5 | 324.7s | 16 / 13 |
| Union: two modern phases | 103 | 105.8s | 71.6 | 266.2s | 20 / 6 |

The two-history center is supported on 73 Winchester and 81 Union test visits; first-history centers on 86/92. Full-cohort predictions retain fallback cases. The three-arm common-support cohorts have 72/80 visits, and retain the important conclusion: Winchester two-history MAE improves 94.5→87.5 but WIS worsens 62.3→66.9; Union improves 116.2→86.6 and 76.2→58.1. This is not merely a different test cohort.

Union's two-history all-case MAE improves on three of four dates. September 16 is slightly worse (116.1→118.2s), with point-overprediction above 120 seconds increasing 7→9 cases. Winchester's distribution score is mixed even though its point MAE improves on each date. These are useful hypotheses, not grounds to select a universal winner.

Clock definitions matter. Among current test cases supported by both last-departure arms, the modern prior departure is a median 15.0 seconds earlier than legacy at Winchester and 75.0 seconds earlier at Union (ranges approximately 10–80 and 30–130 seconds). Matching here is by the same target query and the latest supported historical reference; the records' endpoint differences are retained, rather than asserting that the clocks are interchangeable. Training center corrections differ materially: modern −4.6/−8.9 seconds versus legacy −17.2/−119.1 at Winchester/Union. The two-modern-history corrections are −24.5/−18.9 seconds. A raw legacy+hour rule therefore includes a distinct systematic clock offset, not simply random variation around a physical timetable.

The parent has added this phase-two center as a separately motivated sixth survival arm. Its later residual-survival interval result must be judged separately from the point-at-pin table above; its reported Union pin+0 coverage is worse. The improved center alone does not establish a superior full conditional distribution.

## Audit of the five-arm remaining-wait experiment

I reviewed `release-survival-screen-five-arms.py/.json` and reproduced every saved forecast quantile from its frozen coefficients, training residuals and calibration levels. All forecast truth/eligibility and MAE/WIS checks pass. I found no direct future-label leakage in the component fit:

- The positive-duration regression and logistic hazard use only the pre-September 10 fit block.
- Each completed training episode contributes one event and its prior at-risk bins. Repeated risk bins are the ordinary factorization of a discrete survival likelihood, not independent validation episodes.
- A 15-second risk bin's future wall-clock midpoint is deterministic at the forecast origin. Using that time as a hazard covariate is causal; using an eventual future bus observation would not be.
- Own lap is fixed at the historical pin; it is not allowed to grow simply because the bus waits. Unsupported lap gets an explicit indicator in the hazard.
- Evaluation at elapsed 0/120/300/480 includes only episodes with actual duration greater than elapsed. This is a valid **known-continuing-episode component** comparison. It grants correct stopped-state/clock knowledge and is not equivalent to live GPS inference.
- Calibration uses only preceding dates and their survivors, separately per elapsed checkpoint. No evaluation outcomes select fitted coefficients or calibration levels within the script. The broader choice of families still follows previously inspected data.

The 15-second binning labels departure in the bin containing it and evaluates hazard at the midpoint. It approximates event time at that resolution; it does not create an additional 15 seconds of observed survival. The logistic and residual CDFs are monotone. All scored rows have zero numerical tail mass at the 3600-second calculation horizon, so the finite cap does not explain current results. For an eventual serving implementation, an unreached requested quantile must remain unknown or use an explicit tail/fallback; `np.interp` returning the terminal grid value would otherwise silently fabricate a finite bound.

The results support further work beyond an additive pin-time clock term. Using the first-harmonic hazard, calibrated Union age 300 MAE/WIS improve 86.1/56.9→57.5/36.8, and age 480 improve 73.4/49.7→42.9/31.4. These gains occur separately on all four evaluation dates for those two checkpoints. Crucially, the **uncalibrated** gains also exist: corresponding MAE changes are 87.0→59.1 and 73.4→42.3. They are not solely an artifact of flexible calibration.

Winchester pin+0 improves 107.4→78.6s MAE and 68.5→50.1 WIS. Its later-age benefit is less uniform: age 480 MAE improves 56.9→53.1 overall, but September 14/17 worsen, and overprediction above 120 seconds rises 1→5 across the 29 surviving episodes. This directional tail result needs to stay visible under the user's accepted modest-outlier tradeoff.

Supported-lap stratification confirms a genuine within-cohort gain, while exposing limits. At Union age 300, supported cases improve MAE 87.6→57.2 (59 episodes); at480 all 35 cases have supported laps and improve 73.4→42.9. Union's 11 missing-lap pin+0 cases remain poor: MAE 252→250, WIS 151.5→168.7 for first-harmonic hazard. Treat startup/missing-lap behavior separately, rather than assuming a missingness coefficient solves it.

## Calibration and sequential behavior require another design step

Per-age PIT calibration has only 22–61 completed survivors from two dates. It is an empirical adjustment, not a finite-sample or conditional-coverage guarantee. It sometimes harms raw point/tail scores: for example, Winchester first-harmonic pin+120 early misses increase from 10 raw to 18 calibrated. Do not retrospectively cherry-pick raw or calibrated output at each checkpoint. The raw hazard is suitable for a clearly labeled feasibility shadow; a final calibration policy needs to be frozen and evaluated prospectively.

More concretely, the separate per-age mappings and their linear interpolation do **not** form one coherent survival distribution. With no new observations except continued waiting, conditioning one fixed total-duration CDF cannot move an absolute departure quantile earlier. I checked every 15-second continuation step through min(observed duration, 900 seconds): raw CDFs have no such drops, while the calibrated first-harmonic median has three drops larger than 1 second across two episodes; the second-harmonic median has 222 across 39 episodes. Lower/upper quantiles show similar inconsistencies for some arms. Checkpoint MAE/WIS remain valid descriptive scores, but these calibrated slices should not be transplanted directly into one continuously updated live CDF.

A coherent later option is to fit **one monotone calibration transform to the base total-duration CDF**, then condition that calibrated distribution on survival. Another is to calibrate the hazard itself with a prespecified modest adjustment. Neither construction guarantees per-age coverage under dependence/shift; both require fresh evaluation. Do not fix inconsistency by arbitrarily forcing ETA to decrease.

I also measured **absolute predicted departure time**, adding the 15-second elapsed step to the remaining-time change. Across 202 test episodes and 4736 transitions, the first-harmonic calibrated hazard has four upward changes above 60 seconds (maximum 101s), second harmonic three (maximum 76s), neither above 120s. Corresponding raw counts are seven and four. Absolute changes affect more episodes than the original remaining-time threshold: first harmonic IDs 48550/58510; second harmonic 48550/54002/58235. Such jumps can be legitimate posterior movement from a missed likely release to a later mode; they still matter to riders. A statement that the component is perfectly smooth would be false.

## Downstream validation and transition requirements

The downstream code constructs target labels using exact modern leg/visit endpoints, route indices, correct occurrence and no gap resolution. It fits ride samples only when target arrival+120 seconds precedes the fit cutoff and calibrates only targets completed before the test boundary. I found no use of eventual ride time as an origin feature. The training ride sample sizes are 95 for Division and 81 for Rosenkranz. The added clock-gain signal persists in this diagnostic; for example, Winchester→Division pin+0 MAE 114.5→72.2 and WIS 73.0→49.1 on 89 connected targets.

This convolution draws **independent** prior whole-ride times, rather than conditioning drive/pass/dwell on the future departure phase, current traffic or joint fleet state. It also treats physical passes as arrival labels. Its separate target-level PIT calibration, connected-case selection, and correct pinned-state assumption distinguish it from production performance or a boarding simulation. It is useful downstream evidence and must be described at that level.

The planned causal-wire shadow should therefore report:

- exact source pin identity and first-known time; agreement between `at_stop_since`, live stop attribution and the fitted pin definition;
- current-feature provenance and availability, especially legacy versus modern departure clocks and whether two-history phase is actually served;
- predictions and fallback availability on the same frames, including the first supported frame at pin entry and the first departure/unsupported frame;
- individual visit/checkpoint errors, both interval tails, proper scores, and absolute arrival-time jumps across those transitions;
- long survivors, missing lap, service entry/role changes, passes and recording gaps separately;
- future-stop application under simulated arrival phase with preserved stop/pass mass, rather than adding this correction only after arrival at the hold.

A pin-entry switch can produce an artificial step even when the held-stop component is excellent. Prior current-only experiments already demonstrated that failure. Retain the present forecast outside the exploratory contract, record the transition cost, and avoid interpreting a supported-state shadow win as a complete deployed model win.

**Decision:** proceed with the bounded causal-wire/full-path experiment. The hourly-role evidence is strong enough to replace the vague “no structure found” narrative, and the clock-hazard gain is substantially larger than the earlier weak additive tests. Preserve all arms and clock definitions, keep the four inspected test dates labeled retrospective, and do not publish new calibrated probabilities or coefficients from these component results alone.

## Completed causal-wire shadow audit: reject the direct switch

I reviewed `release-wire-shadow.py/.json` and independently checked its selected gate rows, checkpoint counts/MAE/WIS, and every scored transition with [release-wire-review.py](release-wire-review.py). [The JSON audit](release-wire-review.json) preserves gate-failure categories, physical-coordinate evidence and actual new positive jumps. This prototype is **causal as a shadow but unsuitable for deployment**.

Forecast construction uses the current raw-reconstructed wire, not the eventual gold visit: `at_stop_since` supplies the pin clock, current served lap ages supply previous legacy departures, and past fit/ride samples precede the evaluation days. The matched gold source/target IDs enter scoring afterward. Each CDF is frozen when that bus/pin is first accepted; subsequent conditioning advances its known pin age. There are 50 accepted bus/pin origins, 44 with supported lap and six using the fitted missing-lap indicator. Thus the gate is not strictly “lap-supported cases only.” The radius, freshness, warmup, hop count and pin predicates are all satisfied for every inspected hazard row. All 12654 frame timestamps are exact integer milliseconds in this capture; float-key mismatching is not affecting these results.

The underlying held-stop signal survives causal inputs. Winchester→Division pin+60 has 47 episodes, 44 changed: MAE 224.2→66.6s, WIS 113.7→44.0 and width 569.0→290.8s. At pin+120, 43 episodes / 38 changed improve MAE 195.9→67.7 and WIS 98.2→44.5. These large differences compare a whole raw hazard+historical-ride predictor against the recorded joint estimator, with different fit cutoffs and its existing state/ceiling behavior. They are not the isolated effect of adding one clock coefficient.

The transition harm is concrete:

| Division transition | Count | Shadow remaining-ETA increases >60s | >120s |
|---|---:|---:|---:|
| Fallback → hazard | 96 | 38 | 10 |
| Hazard → hazard | 3011 | 0 | 0 |
| Hazard → fallback | 96 | 0 | 0 |
| Fallback → fallback | 1815 | 0 | 0 |

**All 38 Division jumps above 60 seconds, across 29 visits, are entries/re-entries into the alternative predictor.** Including elapsed time gives 41 absolute-arrival jumps above 60 seconds. The largest remaining-time jump is 195.7 seconds. There are 96 entries/exits over 47 source visits, so this is not just one initial pin transition per visit. Before those entries, 33 frames have a different lead hop count; 65 lack the current Winchester pin flag/clock, and 61 are outside 75m (categories overlap). The gate toggles with position/attribution uncertainty that the full estimator represents more richly. While the hazard remains active, its maximum upward remaining-time step is only 6.5 seconds in this trace.

For urgent source 65347 (#309), the shadow re-enters at pin+5.061 and +19.905 seconds because the previous lead hop count differed, adding 183.7 and 195.7 seconds; it re-enters again at +460.050 seconds after the collector pin/radius gate returns, adding 145.3 seconds. The wire pin itself agrees with the gold pin in these cases. The issue is switching predictors, not an invented elapsed-clock reset. All 38 newly large Division entry jumps have that pin agreement.

Rosenkranz's aggregate point-jump counts improve, but it still has six entry increases above 60 seconds and seven exit increases (one exit is newly above 60 versus production). That aggregate cannot cancel the clear Division regression. The parent corrected `largestNewJumps` to require an actual positive shadow jump; the earlier sort by shadow change minus production change also ranked avoided large negative baseline steps as “new jumps.”

### Departure evidence and the meaning of `stationary`

At Division departure+0, all 47 records still take the hazard: MAE 34.0→64.4s, WIS 35.3→40.8, and early lower-bound misses 0→30. At +5, 45/47 still use it and 30 early misses remain; at +15, 12 still use it and 10 early misses remain. At +30 the prototype has returned to production for every case.

These clocks need careful interpretation. `departed_at` is the final unchanged-coordinate poll, identified retrospectively when a departing run is confirmed. `first_moved_at` can be a much earlier shuffle in the same visit and is not a final-departure availability timestamp. In source 56968, the gold departure is 11:32:48, still at the resting coordinate; the first changed coordinate is 11:32:53, while `first_moved_at` is an old 11:23:58 shuffle. Raw coordinate comparison confirms **none** of the 47 Division departure+0 checkpoints has yet observed the final run's first changed coordinate, while **all 47** have by +5. A switch exactly at gold departure would use hindsight. The prototype nevertheless continues adding residual stand time after observable movement at +5/+15 because the collector's `stationary` boolean means stop-pinned, not physically motionless. The live model's moving/standing hypotheses contain information lost by that boolean override.

The new early misses are not demonstrated missed rides, and some excesses are only a few seconds; nevertheless 30/47 early misses after movement begins and the recurrent large entry steps are systematic integration defects. They exceed the accepted notion of a modest isolated-tail tradeoff.

The next implementation hypothesis should put the conditional wait distribution inside the existing causal state mixture, preserving the departure/moving hypotheses and consistent approach pricing. It should not fix these results by suppressing upward changes, resetting a true waiting clock, or using gold departures. Any such integration requires a new continuous paired replay; the present component/shadow work does not establish that it will succeed.

## Coherent calibration follow-up

I also inspected `release-coherent-calibration.py` and its saved output. It fits one monotone pin-time PIT map on the two calibration dates, applies it to the total-duration CDF, then conditions that transformed CDF on survival. This is the intended coherent construction; both raw and transformed versions record zero backward absolute-quantile updates in the inspected traces. The change is explicitly post-result sensitivity work.

Coherence alone does not make the forecast more accurate. Winchester pin+120 MAE/WIS worsen 70.1/46.2→81.0/51.2 and early misses 10→16 against raw hazard. Union's later-wait benefit is mostly retained (age 300 MAE 59.1→58.5, age 480 42.3→42.8), but pin+0 worsens slightly and its tail imbalance remains. Those facts support retaining the corrected architecture for future calibration work, not promoting this fitted map now.

**Final disposition:** operational structure is a productive lead, the hazard has substantial retrospective predictive signal, and the direct pinned-forecast replacement is rejected. Continue only through a coherent integration with real movement/state evidence and fresh confirmation data. No production changes are justified by this exploration alone.
