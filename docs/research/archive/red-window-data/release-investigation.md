# Red departure rhythm and remaining-wait investigation

September 17, 2026. **There is useful structure: buses often repeat an hourly departure minute, and a clock-conditioned departure model predicts remaining waits substantially better in these historical experiments. A direct switch to the new predictor fails transition checks and has not been deployed.**

No application code or production service was changed. Repository `origin/master` was checked at `a5ac85abb0f47928b7dfbae0e63a31408ee22dea`. Experiments use local read-only recordings and preserve all candidate outputs. The [independent statistician's review](release-policy-review.md) covers the operating-pattern interpretation, model checks, calibration and replay limitations.

## Operating structure

The earlier 15-minute fleet pattern is compatible with individual buses following longer, differently offset cycles. Across recorded bus/day groups with at least three completed visits, median consecutive same-stop departures are 60.04 minutes at Winchester and 59.86 minutes at Union. Of these observed gaps, 195/229 and 213/247 respectively are between 55 and 65 minutes. Missing visits and service gaps remain in the data; this is not an estimate of route-wide shuttle frequency.

The minute changes between dates. For example, #316's Winchester departures cluster near minute 45 on September 14, minute 02 on September 15, and minute 46 on September 16. At Union its corresponding centers are near 15, 30 and 15. This offers an explanation for why a static bus-number effect can be weak even when there is operational structure. It does not identify a driver, dispatch instruction or fixed timetable.

!Observed departure minutes by bus and day (`release-hourly-pattern.png`; historical input/reference, see publication manifest)

A separate causal experiment predicts an hourly slot using only the same bus's two prior recorded modern departures that day passing the stated availability safeguard, with an intervening opposite regulator and fallback when history is unavailable. Exact historical receipt timestamps are not recovered. At Union, complete-hold MAE improves from 129.7 to 105.8 seconds; at Winchester, 107.4 to 100.6. The interval result is mixed: Winchester's width/WIS worsen. A single previous-departure-plus-hour rule is weaker. See [the slot experiment](release-policy-review.py) and [all results](release-policy-review.json).

## Departure likelihood rather than a fixed average wait

The main experiment fits the chance of leaving in each successive 15-second interval, conditional on still waiting. Inputs are elapsed pinned time, own-lap duration/support, and deterministic wall-clock phase. The first-harmonic version uses sine/cosine of a 15-minute clock; a second-harmonic alternative is retained, not silently selected. The fitted model does not impose a hard departure slot. A missed likely release changes the remaining distribution rather than forcing the ETA to keep decreasing.

Data split: four fit dates (September 3, 4, 8, 9), two calibration dates (10, 11), four later evaluation dates (14–17, partial 17). Those evaluation dates have already been inspected in prior research, so these are retrospective development results. There are 202 complete test holds, not thousands of independent samples. Later elapsed checkpoints include only visits still ongoing at that time. One independently proven restart-truncated label is excluded; there is no duration-based outlier deletion.

The initial five fixed arms are saved as `release-survival-screen-five-arms.*`: lap residual survival, lap plus pin-time clock residual survival, elapsed/lap departure hazard, first-harmonic clock hazard, and second-harmonic clock hazard. The separately motivated prior-two-departure residual arm was then added as a sixth arm in [release-survival-screen.py](release-survival-screen.py). Fixed settings: 15-second bins, L2 penalty 4, residual smoothing scale 45 seconds, evaluation ages 0/120/300/480. Every model and prediction is retained in [JSON](release-survival-screen.json).

Selected first-harmonic comparisons against the lap residual-survival component, with separately fitted per-age calibration:

| Stop / elapsed wait | Episodes | MAE before → after | Mean interval width before → after | WIS before → after |
|---|---:|---:|---:|---:|
| Winchester, pin time | 99 | 107.4 → 78.6 s | 336.8 → 282.6 s | 68.5 → 50.1 |
| Winchester, 5 minutes | 57 | 87.8 → 70.6 s | 250.9 → 216.5 s | 51.6 → 42.7 |
| Union, 5 minutes | 61 | 86.1 → 57.5 s | 331.3 → 201.1 s | 56.9 → 36.8 |
| Union, 8 minutes | 35 | 73.4 → 42.9 s | 272.2 → 199.8 s | 49.7 → 31.4 |

Union's 5- and 8-minute improvements occur on all four dates. The gains also exist **before** calibration: at 5 minutes, raw MAE improves 87.0→59.1 seconds; at 8 minutes, 73.4→42.3. Winchester later-age gains are less consistent; its 8-minute calibrated point-overprediction over 120 seconds increases from one to five cases among 29 visits. Missing-lap Union visits remain poorly predicted. The second harmonic and prior-two-departure arm are not universal winners across scores or coverage.

Independent reconstruction reproduces all initial five-arm quantiles and scores. No direct future-label leakage was found. Predicting a future clock time in the departure hazard is causal because the clock's progression is known; using the bus's eventual future location or hold duration would not be.

## Calibration must remain consistent as time passes

Separate calibration at each elapsed checkpoint improves some scores but does not define a single consistent duration distribution. Interpolating those separate corrections can move an absolute departure quantile earlier when the only new information is that the bus has continued waiting. The second-harmonic experiment shows this particularly clearly. Do not serve these calibration slices as a live distribution.

I tested a follow-up with **one monotone calibration of the pin-time CDF, followed by survival conditioning**: [script](release-coherent-calibration.py), [results](release-coherent-calibration.json). This removes the backward absolute-quantile steps in the tested continuations. Union retains most remaining-wait gains, but Winchester's accuracy and early-tail errors worsen relative to the raw model. It is a coherent sensitivity experiment, not a selected production calibration policy. There are only 58/61 calibration episodes across two days, so nominal interval coverage is not established under changing operating conditions.

Raw and coherent models can still increase an ETA when a likely release window passes. That can be a valid probability update; a running minimum is not a statistical solution. The eventual rider display must communicate uncertainty and react to observed departure without treating a fitted release pattern as a guaranteed schedule.

## What survives recorded-feed replay

[release-wire-shadow.py](release-wire-shadow.py) applies a deliberately simple prototype to actual causally reconstructed September 16–17 wire observations. It uses the served `at_stop_since`, current fresh position inside 75 metres, and already-available lap ages. It retains the current production-model replay forecast whenever the prototype's pinned-state conditions do not hold. It uses the **raw first-harmonic hazard**, with no per-age calibration transfer.

Gold visit/leg links are used only for evaluation. Downstream ride samples come exclusively from completed pre-September 10 journeys, linked by exact modern leg/visit endpoints: 95 Winchester→Division and 81 Winchester→130 Prospect/Rosenkranz. These independent whole-ride samples are not the existing production route-chain pricing. The production comparator uses the earlier joint-lap replay with pre-September 14 tables; this is therefore a feasibility comparison, not a one-coefficient ablation or archived actual-live response comparison.

| Winchester → Division checkpoint | Episodes | Production-model MAE → prototype | Interval width before → after |
|---|---:|---:|---:|
| 1 minute after pin | 47 | 224.2 → 66.6 s | 569.0 → 290.8 s |
| 2 minutes after pin | 43 | 195.9 → 67.7 s | 491.7 → 284.6 s |
| 5 minutes after pin | 24 | 125.5 → 71.8 s | 510.4 → 249.7 s |
| Actual departure | 47 | **34.0 → 64.4 s** | 359.1 → 168.6 s |

The last row is a regression: 30/47 recorded departure checkpoints fall **below** the prototype's interval. The recorded departure endpoint is backdated to the last poll of the final resting plateau; it is not necessarily a time when departure evidence was already visible. It must not be used as a serving-time switch. Independent raw-coordinate audit confirms that none of these 47 departure+0 frames has yet observed the final movement, while all 47 have by the departure+5 checkpoint. The collector's `stationary` field means the bus is still attributed to a stop, not that it is physically motionless. At departure+5 seconds the prototype still applies to 45/47 cases and MAE changes37.2→66.7seconds; at+15 it still applies to12/47 and MAE changes24.3→34.9. These checks motivate integrating actual movement evidence, rather than assuming that a stop attribution proves continued holding.

The switch also increases Division remaining-ETA upward jumps greater than a minute from 14 to 38, including ten over two minutes versus none in the comparator. Independent review finds all 38 happen when switching **into** the prototype; none happen while its forecast remains active. There are 96 entries and 96 exits across 47 episodes, so repeated switching matters as well as initial arrival. Rosenkranz jump counts improve overall, which does not excuse the Division regression. [Full replay scores and transition records](release-wire-shadow.json) retain both targets and all fixed checkpoints. The independent [wire audit](release-wire-review.py) reproduces counts, gating and scores from the saved forecasts.

**The direct switch is rejected for deployment.** The duration model needs integration with the existing movement/standing probabilities, a consistent episode clock, future-stop pricing, and display state. A UI-only replacement after pinning repeats the previously identified transition failure.

## The urgent reported example

Report 115 corresponds to Red #309's Winchester visit 65347 on September 17. At the first fresh frame at least a minute after pin, Division arrival is about 515 seconds away. Current production-model replay predicts 159 seconds; the prototype predicts 598. The new model avoids the large premature countdown there, but by actual departure it still predicts 221 seconds against 80 seconds of truth; production predicts 108. This is useful evidence for the wait model and direct evidence against its naive integration.

!Report 115 production-model replay and experimental switch (`release-report115.png`; historical input/reference, see publication manifest)

## Next implementation experiment

Freeze the first-harmonic departure hypothesis for a narrowly scoped model-integration replay. Preserve forward route progress and existing movement evidence. Price the ongoing pinned-hold branch with the new remaining-wait distribution, retain a credible moving/departed branch, and evaluate the same release hypothesis at simulated future arrival times so crossing the pin boundary does not introduce a new forecasting rule. Keep attributed off-marker waits and inside-marker pin duration distinct until their training/serving clocks are explicitly aligned.

The experiment must compare complete continuous trajectories, both target occurrences, pin entry, shuffles and actual departures; record unavailable/missing-lap cases; and check directional rider errors as well as typical MAE, interval score and width. Neither blanket removal of the display ceiling nor tighter arbitrary interval caps is validated here. Production remains on the previously deployed restart-recovery and joint-lap changes.
