# Historical warmup and Blue K10 backtest — September 21, 2026

Red historical warmup is deployed. Blue is unchanged. Blue West is the strongest candidate for further validation, but the direct Red configuration did not transfer, and fallback transitions still need attention.

## Historical warmup: live

[PR 314](https://github.com/grtwrn/yale-shuttle/pull/314), production commit `50df98022461ad0b6b014c280cfb6fb8120e0c0c`.

On the first live observation of a Red bus, replay up to one hour / 1,500 preceding GPS samples for that fleet name, then continue those same isolated reducers. This recovers the observed Chapel/Church departure and Winchester release state. Older average durations cannot supply those clocks. Ten minutes of continuous observations, a confirmed source departure and the existing freshness/phase rules remain required; historical observations can now satisfy startup warmup. Gaps over 60 seconds, route changes, ambiguous identities and missing history retain the usual fallback. Historical replay never inserts arrivals or finalized visits.

Validation: 2,846 tests, backend/frontend typechecks, build, staging and production API/browser smoke passed. The [hosted replay](https://github.com/grtwrn/yale-shuttle/actions/runs/35652102773) matched 5,232 causal reference snapshots and all 150 sampled eligible restarts; these were eligible checkpoints, not a claim of 100% recovery for arbitrary buses. Maximum replay cost was 11 ms on the hosted runner.

The [production deployment](https://github.com/grtwrn/yale-shuttle/actions/runs/35652357810) replayed 2,118 GPS samples across three Red buses, immediately recovered two clocks, and left the third on the ordinary fallback. Maximum production recovery cost was 101 ms, with zero errors or skipped polls. At 20:43:17 UTC, the default/previous API comparison had 696 rows: 14 Red rows changed; all 553 other-route rows, including 166 Blue rows and their distributions, matched exactly at the same observation timestamp.

## Blue experiment

[Final hosted run](https://github.com/grtwrn/yale-shuttle/actions/runs/35653327666), code `05e3983`. [Plan](PLAN.md), [follow-up plan and corrections](DIAGNOSTIC-PLAN.md), [durable numerical results](FINAL-RESULTS.json).

Public fleet observations were frozen for September 3–20. Fit only journeys completed before September 16; evaluate September 17–20. September 16 was reserved. Day has two evaluation dates, Weekend two, Night and West four. Earlier Red research used some of these dates: this is a transfer study on reused dates, not an untouched global holdout. The 90-minute cap is explicitly a follow-up after inspecting the primary result.

Training-only wait detection found Cedar on all four lines, Stop & Shop on Weekend, and Union Station on Night. Historical stop indices matched the frozen topology. Weekday/weekend service is fitted separately. The estimator uses a clock-weighted mean from K stops before the relevant wait, then reverts to the entire logged live forecast after that wait releases. Targets and source occurrences are unwrapped through the loop. All targets in a group must have at least 12 effective paths and three materially weighted dates; a countdown of 60 seconds or less switches the whole group to live.

The paired final evaluation includes 8,626 logged forecasts across 310 physical target arrivals. Forecasts a full lap or more ahead are excluded from next-arrival labels. The current forecast's route position is inferred from its logged target and stops-ahead count, not from the nearest GPS stop. The initial nearest-stop proxy results are retained in the hosted artifact as `legacy-nearest`, and their original changed-subset comparisons reproduce exactly.

## Primary result: the Red 45-minute journey limit does not transfer directly

The broad K10 and K5 groups made **zero replacements on all four Blue services**. Complete checkpoint-to-target history under the 45-minute limit was insufficient, or the shared expiry guard selected live estimates. Identical fallback scores are not evidence that K10 predicts Blue well.

The prespecified first-ten-pickup variant did activate on Blue Day. K10 changed 255 readings across 31 target visits / 16 source departures. Its error increased from 5:35 to 6:24, width narrowed from 15:04 to 12:03, and band coverage fell from 72.6% to 38.7%. A September 18 bus held at Cedar for 20:10, producing several of the largest misses. Restricting the target group changes which trips qualify; it is not a harmless presentation change.

## Follow-up: allow training paths up to 90 minutes

The 45-minute cap excluded real longer journeys on Blue, especially West's eleven-stop loop, where K10 starts almost a lap before Cedar. Changing only that training limit and using the corrected logged-anchor guard gives these **paired changed-subset** results. Each physical target arrival receives equal weight; multiple targets from one source trip remain correlated.

| Service | Target visits / source departures | Mean absolute error, usual → K10 | Mean band width, usual → K10 | Band coverage, usual → K10 |
| --- | ---: | ---: | ---: | ---: |
| Blue Day | 30 / 21 | 3:35 → 2:55 | 14:49 → 11:26 | 88.6% → 86.7% |
| Blue West | 22 / 12 | 3:19 → 1:33 | 27:17 → 5:38 | 99.4% → 90.9% |
| Blue Night | 0 supported replacements | — | — | — |
| Blue Weekend | 0 supported replacements | — | — | — |

K10 replaced 1,037 of 5,620 scored Day readings and 582 of 920 West readings. Including all fallback periods, Day's error improves only 2:46 → 2:42 and width 10:40 → 10:14. West improves 2:50 → 1:28 and width 21:23 → 6:40; coverage changes 96.1% → 92.6%. These are historical comparisons against actually logged forecasts, not a new live accuracy measurement.

K5 also improved supported subsets but had lower band coverage: 82.6% on Day and 83.3% on West. Those subsets differ, so its point-error numbers are not a head-to-head K5/K10 ranking. The shorter first-ten-pickup Day variant remained poor even with longer training paths: 48.4% coverage versus 72.6% for its paired baseline. The broad group's stronger support gate excludes some of those difficult periods; do not generalize its favorable subset result to all Day pickups and times.

## Handoffs and limits

Six decision tests cover wraparound, multiple wait stops, nearest-stop shuffles versus the logged anchor, wrong-lap rejection, shared support/expiry fallback, future departure rejection and exact live handoff. Chronological prefix replay and deletion of future finalized training visits leave earlier results unchanged. A 15-second delayed-feed replay preserves the main direction of the findings.

No pickup-order reversal over 30 seconds appeared in 1,222 paired adjacent-target readings. There were no new false-now readings among K10 replacements; existing live-fallback false-now readings remain. Neither result guarantees future absence.

Switching still changes the estimate. Across the two supported services there were 13 observed departure handoffs, with a largest countdown-adjusted jump of 2:09. Expiring the checkpoint model caused jumps up to 5:27. Using the actual logged anchor removed artificial nearest-stop-driven oscillation, but it did not eliminate model disagreement at genuine fallback boundaries.

Blue West is promising, with only 12 source trips supporting its changed-subset result and substantial dependence across pickup stops. Day is mixed, and Night/Weekend do not meet the existing support rule. A future Blue trial should preserve the longer-path history, assess more dates and the fallback transitions, and calibrate interval coverage. This backtest does not change Blue production behavior. Red's deployed prior and September 28 expiry remain unchanged.
