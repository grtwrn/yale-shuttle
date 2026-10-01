# Previous Winchester wait: full pickup replay

**The signal survives full arrival pricing, but the rider benefit is small and it does not meaningfully tighten the window. Keep this as a research candidate; no production change was made.**

The simple history model adds the bus's prior recorded Winchester wait and time since its prior Union departure to the existing lap/elapsed/clock release model. It was fitted on 160 holds from six dates before September 14 and frozen before the later five September 18 holds were evaluated. Longer previous Winchester waits predict somewhat longer current waits, conditional on the other inputs. This is vehicle operating-history persistence, not proof of driver identity or a bathroom-break rule.

## Full pipeline, fixed inputs

Three arms use the same current application algorithms, frozen travel/dwell tables, actual causal runtime lap, and pre-September-14 fit reference: the nine-feature core; core plus Union age; and core plus Union age and previous Winchester duration. These are controlled offline comparisons, **not** a replay of every historical production refit or a live A/B experiment.

The artifact-only hook folds the fixed extra coefficients into the existing nine-feature distribution at an exact matched pin. Runtime hazard, conditional residual sampling, stop/movement mixture, arrival pooling, forward position tracking, and fallback stay on their normal code paths. Unmatched pins use the common core; unsupported laps retain the normal fallback. The immutable lookup is limited to previously constructed completed episodes, so this experiment does not establish prospective history availability or a treatment effect across every ride.

The three-day replay processed **20,531 polls and 190,157 paired forecast identities**. It matched 80 pin histories and intervened at 72 supported visits; two pin timestamps were unmatched. All three complete belief-state hashes match. Each arm passed 190 comparisons against the server wire arrival rows. The folded runtime and original component agree across 8,547 quantiles within 6.83e-13 seconds. An independent scan found no bus/pin identity collisions in these recorded frames.

Forecasts were paired by bus, target and actual occurrence within a poll, not presentation rank. Actual occurrence is preserved by a build-only transport field. First-arrival scoring excludes later occurrences before matching; a separate strict connected-leg audit scores the following loop. Scoring requires ten minutes of warm state. Source 65237's independently invalid pin/elapsed labels are quarantined; its valid departure and onward evidence remain available. No valid short or long outcome was removed because of a prediction error.

## Pickup result

The table gives visit-balanced standing-checkpoint results for supported intervened Winchester→Division journeys. Repeated checkpoints are not independent trips. Widths and errors are seconds. The core is the frozen existing model, and history includes both extra inputs.

| Sample | Visits | Core MAE → history | Core window width → history | Core WIS → history |
|---|---:|---:|---:|---:|
| September 16–18 | 68 | 79.22 → 76.90 | 473.38 → 471.19 | 58.25 → 57.14 |
| September 16 | 28 | 66.13 → 63.96 | 462.35 → 455.89 | 52.87 → 51.71 |
| September 17 | 26 | 75.66 → 75.16 | 468.04 → 465.97 | 56.78 → 56.27 |
| September 18 | 14 | 112.01 → 106.02 | 505.35 → 511.47 | 71.75 → 69.59 |
| Five later September 18 holds | 5 | 118.74 → 113.14 | 459.89 → 466.46 | 70.75 → 68.81 |

The incremental prior-Winchester comparison against Union age alone changes aggregate pickup MAE 78.46→76.90 seconds and WIS 57.87→57.14. Its width slightly **increases**, 470.64→471.19 seconds. Therefore the stronger current-wait component improvement cannot be advertised as a comparable improvement in the full pickup ETA.

For Rosenkranz, 66 intervened connected first-arrival journeys improve MAE 116.03→114.57 seconds and WIS 83.48→82.72; width 641.99→640.21 seconds changes little. `summary.json` also retains all-source/fallback cohorts, per-bus results, phases and fixed ages. Today's five additional holds remain a same-day extension rather than independent-day confirmation.

## Boarding and jumps

The continuous first-Division audit covers 77 connected visits, including 70 with recorded stops. No lower-bound arrival timestamp crosses the observed pickup departure in any arm. Among timestamps moved later versus core, the closest departure margin is about 10.1 seconds overall and 16.0 seconds for stopped targets. These finite observed margins are **not** a guarantee against stranding, and arrival/departure labels remain GPS/detector proxies.

True lower-before-arrival errors remain: candidate lower bounds sometimes lie after the recorded arrival, with a worst stopped-target excess of about 34 seconds versus 30 seconds for core. They stay scored. The extra distinct arrival-bound crossing is visit64725, just0.079seconds; the substantive existing visit64318 excess increases30.145→33.986seconds and remains about16seconds before observed departure. The already audited component early-departure regressions also remain in the component report.

Division's absolute-arrival downward jumps exceeding 60 seconds increase from 29 to 31 adjacent pairs; this net increase consists of five new threshold crossings and three avoided ones. The biggest added drop among those five is about 14 seconds (visit 70927: an existing 54-second drop becomes 68 seconds). Upward jumps exceeding 60 seconds remain five. Rosenkranz's downward count changes 46→45 and upward count remains eight. The large pre-existing jumps are unchanged. This candidate is not a general jump or route-order fix; complete position beliefs are identical.

The largest first-arrival point-error regression is visit 71451 at Rosenkranz (+41.77 seconds at the +180-second checkpoint). Visit 67062's Division +60-second error worsens 32.33 seconds. Independent raw review confirms both current holds are complete, with maximum observation gaps around five seconds and exact connected target paths. They remain scored.

The same review found an additional **history-input defect** for 67062: its prior Winchester record 66622 starts at the first reacquired fix after a 650.113-second observation gap and provider-ID change, with no inbound leg. The recorded 105.065 seconds is a partial previous wait whose start is unknown. The valid current 530.054-second wait and its regression must remain. Original coefficients and scores are preserved; no outcome deletion, convenient older-duration substitution or post-score refit was made. This weakens the interpretation of duration memory until prior-start continuity is checked systematically. A future causal extractor must mark such durations unavailable using gap/handoff provenance. See `independent-review.md` and `independent-case-audit.json` for the case and threshold-crossing audit.

## Following loop and evidence limits

The independent following-occurrence audit has 321 landmarks across 42 source holds and 83 following target visits. Checkpoint MAE changes 165.81→165.42 seconds and WIS 127.64→127.28; equal-journey MAE changes 188.69→187.78 seconds. Against the Union-age control, the history increment is slightly worse (MAE 165.31→165.42; WIS 127.26→127.28). All arms have the same six early and ten late interval misses. No raised lower bound creates an early-arrival risk row in that scored set. Some point estimates worsen, including a roughly 30-second regression at visit 67062. Strict connections cover 85 of 162 attempted paths; 18 are censored and 59 lack sufficient unambiguous evidence. The later five-hold extension contributes only two holds to this following-loop audit. These limits stay explicit in `following-occurrence.md`.

The most useful finding is a reproducible, modest prior-wait signal. It does not explain most of the remaining uncertainty, identify a departure trigger, or justify arbitrarily raising the minimum. Production integration would additionally require warm causal history transport, exact completion availability, route/day reset and fragment-quality handling, and validation of periodically refitted models. The current result does not justify that integration as a solution to the reported 1–16-minute windows.

## Reproduction and review

`PLAN.json` was written before full replay scoring. `build-provenance.json` records source and bundle hashes. The application tree was left unchanged; `build.mjs` injects artifact-only fit and occurrence hooks. `pair.py`, `score.py`, `summarize.py`, `continuous.py`, and `following-occurrence.py` reproduce the saved comparisons. All heavy work used the shared `heavy.lock`. No live database, watcher, UI, model fit, or deployment was changed.
