# Accuracy: approach review, 2026-09-08

**Archived preliminary investigation.** The route-specific prototype described below was preserved as an undeployed experiment and removed from the live implementation. The completed [general algorithm evaluation](general-eta-evaluation.md) supersedes this report, including its implementation status, library comparison, and historical-label interpretation. Source links below describe the archived prototype and may no longer exist in the current tree. The deployed model applies the same learned rules to every route.

**Focus: Red Line's expected total standing time at 344 Winchester, and the resulting ETA at Division / Prospect.** The operator clarified that the five-minute figure was the expected total stand shown this morning, rather than a five-minute arrival countdown.

**Approach decision: retain the route-constrained probabilistic tracker, and test a departure-time model for terminal waits.** The current independent stop-duration model cannot distinguish a bus returning early for its next departure from one returning late. Reuse the existing server departure records. No replacement library has yet demonstrated better accuracy on Yale's data.

**Result: implemented a narrowly scoped Red / 344 Winchester departure-phase model after paired replay improved both the displayed total stand and the downstream ETA.** The change is local and has not been deployed. The earlier broad estimator corrections remain withheld.

## Red Line: the displayed total and this morning's observations

The pause chip's denominator comes from `shownStandSec().typicalSec`, the unconditional median of a pooled stop-duration distribution. It does not use the vehicle's previous departure or its current arrival time. The evening payload's stop 11 quantiles yield 4:46 before shrinkage and 4:48 afterward, explaining a generic figure close to five minutes; this evening table is a diagnostic, not the exact table served to every morning browser.

Morning GPS and completed stop visits confirm several much longer holds by #307: 08:25:02–08:34:47 (9:45), 09:21:22–09:32:23 (11:01), and 11:24:10–11:33:45 (9:35), all Eastern time. This morning's labels include these waits correctly: missing terminal logging is not their explanation. Across all 15 completed morning holds, the median was about six minutes; other buses often held for less time. A universal ten-minute replacement would therefore be unjustified.

The bus's departure phase is a promising explanatory variable. Today's #304 departures stayed near the hour, #306 near :46, and #307 near :33. Across their successive completed visits, median departure-to-departure intervals were 59.30, 60.09, and 60.22 minutes respectively. This is an observed operating pattern, not a verified published timetable. It must be learned from earlier completed loops and tested chronologically; an hour cannot simply be assumed from seeing today's outcomes.

For a terminal arrival at time A, previous same-bus departure P, and learned cycle distribution C, the proposed total is the distribution of `P + C − A`, conditioned on departure still being in the future. During the stand, the remaining wait conditions on the current time instead. The total predicted at arrival can stay stable as the operator requested, while the live remaining wait updates with evidence. Missing history, service changes, and first laps need the existing duration model as fallback. Any bus-specific timing must also reach ETA pricing; merely changing the chip would repeat an earlier display/arithmetic mismatch.

In 15 morning episodes, departure from 344 Winchester to first GPS entry within 50 metres of Division / Prospect took 60–97 seconds, median 76 seconds. Thus the terminal release, rather than that short road segment, accounts for most uncertainty here.

A separate downstream issue remains: the standing display clamp can preserve a transient underestimate after the belief correctly recognizes a stand. A replay of #306 at 09:39:59, using prior-night tables and reconstructed collector clocks, gives 119 seconds displayed versus 267 seconds before the clamp. The exact morning build and current source reproduce this mechanism. This is not the cause of the literal five-minute expected-total figure and is not grounds for silently changing the global clamp.

Today's complete visit archive was captured from the existing server via `scripts/archive-day.mjs` at 23:46 UTC. Morning raw positions were already saved locally; raw positions are retained on the server for only six hours. The noon GPS gap must not be treated as an observed arrival. The archive and working analyses are preserved under `services/shuttle-v2/scripts/.eta-replay/` and `/tmp/yale-red-*`.

## Validated departure model and implementation

Simply predicting the previous departure plus one learned cycle inherited the previous lap's delay. For example, #304 left at 13:02:16, then recovered to 13:59:12; carrying the late departure forward overpredicted the next wait. The selected model instead estimates the bus's recurring departure phase from all of its earlier confirmed departures that day.

Let P be the median cycle period learned from completed prior days, and D_i this bus's earlier departures. Its next departure slot is:

```
slot = median_i(D_i + (round((D_latest - D_i) / P) + 1) * P)
departure = slot + learned prediction error
remaining wait = departure - now, conditional on departure > now
```

The rounding unwraps missing laps: an unobserved terminal visit must not shift the bus's inferred phase by an hour. The prediction-error distribution is fitted on earlier days using each historical visit's earlier confirmed departures. No hourly constant or individual bus adjustment is configured. September 8's fit learned P = 3,593.0525 seconds, with 50 prediction-error samples.

[terminalDeparture.ts](../services/shuttle-v2/src/calibrator/terminalDeparture.ts) fits once per Eastern calendar day. The collector refreshes confirmed visit history as it writes visits and serves an optional per-bus departure prior through `/api/buses`. The client uses that prior for its current terminal hold, its departure-versus-shuffle hazard, and the existing pause chip's total forecast at arrival. The old display ceiling is bypassed only while this contextual model prices the current hold. This permits recovery from an early moving hypothesis without imposing a global countdown change. Shared route tables remain unchanged.

The implementation applies to the measured Red stop 11 case. First visits, insufficient history, stale context, a mismatched route/stop occurrence, and duplicate live vehicle names use the existing estimator. A newly confirmed departure cannot be charged to the old rest still lingering in the client filter. Later visits in a forecast chain retain ordinary stop tables; prediction of future terminal holds before the bus arrives is outside this change. The chip also reads the actual quantile sample count (`qn`) rather than suppressing a valid model when the legacy hourly count is zero.

The final paired replay processed **20,157 GPS polls** through the actual client, with the same prior-night calibration and dawn model parameters in both arms. The new server fit used only days before September 8; each bus's phase used only departures confirmed before that prediction. The displayed total uses the UI's actual belief/rest clock. Metrics and per-visit results are in [red-terminal-accuracy-2026-09-08.json](data/red-terminal-accuracy-2026-09-08.json).

| Metric | Previous implementation | Departure phase |
|---|---:|---:|
| Displayed total stand MAE, 27 first-shown visits | 141.9 s | **65.4 s** |
| Displayed total stand MAE before noon, 14 visits | 142.6 s | **50.8 s** |
| Stop 48 ETA MAE while waiting at Winchester, 1,657 forecasts / 26 waits | 148.0 s | **64.3 s** |
| Same ETA, giving each wait equal weight | 118.1 s | **63.7 s** |
| ETA more than 120 s too short | 44.78% | **6.70%** |
| ETA more than 120 s too long | 1.75% | **3.74%** |
| All future stop 48 forecasts within 30 minutes, 9,506 forecasts | 147.2 s | **132.5 s** |

Nineteen of the 26 terminal waits improve, three first visits are unchanged, and four worsen. A separate component replay on September 4 and 8, including first-visit and pass-through fallbacks, reduces initial stand MAE from 160 to 87 seconds across 60 visits. The actual client replay above is the authoritative integration result; its absolute-departure distribution and UI rest clock differ slightly from the component study's arrival-relative quantile construction.

At #306's 09:42 poll, actual remaining time to Division / Prospect was about 305 seconds. The old client showed 119 seconds; the updated client predicts 330 seconds. Its total-stand forecast is about eight minutes instead of five, against a measured 7:20 stand. For #307's 11:24 visit, the updated total forecast is about ten minutes, close to the measured 9:35.

These are **causal retrospective comparisons, not an untouched prospective test**: today's failure helped select the model. The increase in overprediction is a real tradeoff, concentrated in a few visits. In particular, #304 left unexpectedly early at 17:57 after a 135-second stand; the model expected roughly 348 seconds. A late 10:57 visit also remains poorly predicted. Phase is useful evidence, not a published departure commitment. Future-day accuracy still needs measurement.

Total-stand truth is independently recorded departure minus the stop's pinned arrival. The UI can retain an earlier approach/rest origin, so a forecast covering that earlier hold is conservatively scored against a shorter pin-clock total. ETA truth uses stored stop 48 kerb arrivals; it does not substitute the first GPS point after the noon capture gap. An additional availability audit of 76 visits found that waiting for the subsequent stop's database row to complete, rather than its earlier anchor timestamp, changes none of the phase histories at the next terminal visit; the smallest margin was 44.5 minutes.

Reproduction scripts, daily-fit studies, and the final client harness are preserved under `services/shuttle-v2/scripts/.eta-replay/approach-review-2026-09-08/red-cycle/`. The simple minimum-service-floor experiment is preserved there too, but is not part of the change.

Validation completed: targeted model, collector, payload, distribution, pricing, and display tests pass, together with the existing layover/approach/departure accuracy and planner regressions. Backend and frontend typechecks and the production frontend build pass. The dependency installation also replaced a tracked, self-referencing `web/node_modules` symlink with the ordinary ignored dependency directory; package manifests and lockfiles did not change.

## General approach and library review

This review began at `e6673a0`. The initial broad experimental corrections were set aside after the operator asked for an approach/library decision first. That paired experiment also failed to improve overall arrival accuracy. Those corrections remain restored to the baseline; the later, validated Red-specific change is described above. Nothing was committed or deployed.

The question a rider needs answered is the distribution of the **next boardable arrival**, given the observations available now. A useful decomposition is:

```
remaining wait = remaining current activity
               + future driving and traffic holds
               + future stops that the bus actually makes
```

Location includes the occurrence of a stop in the route sequence. The same coordinates can represent an outbound or inbound visit; snapping to a nearby road or stop cannot always decide which. A bus's current activity includes moving, stopping for passengers, and taking a layover. If its standing duration is S and it has already stood for r seconds, the remaining stand has survival probability `P(S > r + x) / P(S > r)`. Subtracting elapsed time from an unconditional average does not answer that question. A future intermediate stop instead needs both its chance of being skipped and its duration when served. The target stop itself needs arrival time, without adding the dwell after boarding.

The estimator should retain uncertainty about those activities and route occurrences, then derive the displayed number and interval from the resulting arrival distribution. Independent hop sampling is an approximation: whether traffic or operating patterns create useful dependence must be measured. The median minimizes symmetric absolute error; protecting a rider from missing a bus is a different loss. Smooth countdowns alone cannot establish accuracy.

The existing ring estimator already implements much of this decomposition. It is therefore a credible baseline, rather than something that should be replaced merely because another implementation uses a familiar algorithm name. The available observations do not directly reveal a driver's intended departure time, but repeated departure phases provide a useful proxy in the measured Red case. Unannounced departures still limit individual-visit accuracy.

**The server already tracks the buses.** `Collector` keeps per-vehicle `states` and `visitStates`, calls `stepManyWithVisits` on every poll, and persists raw positions, arrivals, segments, stop visits, and legs. Its detector retains `nearestIndex` in the route sequence; its departure reducer retains the active stop pass and transit between stops. `updateLivePositions` and `buildBusesPayload` publish stop, stationary, and movement clocks. See [collector.ts](../services/shuttle-v2/src/collector/collector.ts), [detector.ts](../services/shuttle-v2/src/collector/detector.ts), and [departure.ts](../services/shuttle-v2/src/collector/departure.ts).

The additional ETA belief is browser-local: [eta/index.ts](../services/shuttle-v2/web/src/eta/index.ts) creates `liveAnchorStore` as a new map and updates the ring belief from the polls that browser sees. The public payload does not expose the collector's full sequence/pass state; its `last_stop_id` remains the upstream field. A new page thus has less trajectory history than the server. The architectural question is how to reuse the server's existing evidence and reconcile the two interpretations of position. It is **not** whether to introduce server-side route logging. Nor should `nearestIndex` simply be declared ground truth: a nearest-stop index and the road leg currently being traversed have different meanings.

I reviewed the following open-source options through their upstream documentation and repositories. Capabilities below are documented; judgments about suitability are this review's inference. None was installed or scored against Yale's captures.

| Option | What it supplies | Decision for this project |
|---|---|---|
| [OneBusAway/trip-updates](https://github.com/OneBusAway/trip-updates), a TransitClock fork | An actual GPS-to-arrival-prediction engine, including matching, travel-time learning, and GTFS-RT TripUpdates | The strongest complete external challenger found. Its [setup](https://github.com/OneBusAway/trip-updates/blob/develop/docs/setup.md) needs static GTFS and vehicle-position integration, Java, PostgreSQL, and an API runtime. Yale's route occurrences and vehicle identities would need a faithful adapter. Benchmark before migration. |
| [Valhalla Meili](https://valhalla.github.io/valhalla/meili/) | HMM/Viterbi matching of GPS trajectories to roads | Useful independent check when route matching is the measured problem. It does not supply conditional layover departure or the whole arrival forecast. A road match still needs the correct occurrence on a shuttle loop. |
| [Stone Soup](https://stonesoup.readthedocs.io/en/latest/) | A framework for tracking and comparing estimators | Useful for an independent tracker experiment. Shuttle-specific reporting deadbands, route loops, and elapsed-duration behavior still need modeling. Swapping inference machinery alone does not establish an accuracy gain. |
| [LightGBM](https://lightgbm.readthedocs.io/en/stable/Parameters.html#objective) | Learned regression, including quantile objectives | A practical independent travel-time or remaining-time challenger using causal route/progress/rest features. It can test whether hand-built timing assumptions miss learnable patterns. It still needs correct labels, chronological validation, and a way to handle uncertain route position. |
| [lifelines](https://lifelines.readthedocs.io/en/latest/fitters/univariate/KaplanMeierFitter.html) | Established survival estimation, including right-censored durations | Useful for checking or replacing parts of dwell calibration, particularly visits whose departure was never observed. It is a component, not a complete shuttle ETA engine. |

The TransitClock family is more relevant than adopting OpenTripPlanner as an ETA replacement: OTP primarily plans journeys and consumes realtime updates. The newer OneBusAway fork also means the maintenance state of the original TransitClock repository is not enough to dismiss the family. Its documented runtime is larger than this app's Node/SQLite service; that is an integration cost, not evidence about forecast quality or a reason to reject a demonstrably better engine.

My preferred evaluation order is: establish trustworthy historical scoring; measure how much the existing server sequence/pass information helps; compare a simple empirical forecast, the current model, and a library-based timing challenger; then consider a complete TransitClock migration if it earns the added integration. Preserve the current UI throughout. A claim that any one is *best* requires the same unseen days, arrivals, and rider countdowns in each arm.

The preliminary experiment illustrates why that order matters. It combined two proposed corrections: future-stop durations used the measured all-visit stopping probability, and conditional rest calculations avoided numerical collapse of an exponential tail. The component-level tests supported the mechanisms, but the whole-arrival comparison did not show a general improvement.

For September 4, both arms processed all 173,555 GPS observations. Every sixth poll was scored, giving 137,296 identical prediction keys. Calibration used the real production calibrator and payload serializer, bounded at the beginning of each hour. Because exact insertion/confirmation times are not stored, split outcomes were conservatively withheld until a subsequent recorded stop anchor after their physical end. The replay used production's stationary and movement clocks. It scored the same future physical visits in both arms, retaining 123,561 pairs with proximity truth between zero and 30 minutes; 9,137 lacked proximity truth, 1,689 were already arrived, and 2,909 exceeded that horizon.

| Metric | Current estimator | Experimental corrections |
|---|---:|---:|
| Mean absolute error | 144.12 s | 144.39 s |
| Median absolute error | 59.7 s | 60.6 s |
| 90th-percentile absolute error | 378.5 s | 381.9 s |
| Bus arrives over 120 s earlier than predicted | 14.12% | 13.00% |
| Bus arrives over 120 s later than predicted | 17.34% | 18.93% |
| Actual arrival inside the nominal 80% interval | 76.38% | 76.27% |

Giving each of the 5,671 observed approaches equal weight reduces mean absolute error from 114.72 to 113.80 seconds. That small improvement coexists with worse prediction-weighted error and worse results on several routes, including Red. It does not establish the improvement requested, and these two corrections were not isolated in the full replay. They are withheld.

This is one day, not evidence of generalization across service patterns. The snapshot does not version historical route topology, its derived physical arrivals are GPS-based rather than independently observed boarding events, and the replay's continuous filter history is not every real browser's starting history. It is a paired estimator comparison, not a claim that riders missed a measured number of buses. The experimental calibration and replay fixes passed their targeted tests; they are preserved for a follow-up benchmark rather than silently adopted with the estimator changes.

Local experiment files, source copies, patch, and manifest are preserved under `services/shuttle-v2/scripts/.eta-replay/approach-review-2026-09-08/` (ignored working artifacts). The compact results of the rejected broad comparison are [accuracy-approach-review-2026-09-08.json](data/accuracy-approach-review-2026-09-08.json). Those broad corrections remain withheld; only the validated Red terminal change is implemented.
