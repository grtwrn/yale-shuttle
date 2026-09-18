# Independent review: joint marginal pricing, second upcoming Red arrivals

**Recommendation: the next-occurrence evidence supports the isolated Red-only joint marginal candidate, subject to the parent's full tests, non-Red parity, and deployment checks. I found no next-occurrence statistical release blocker.** Typical error and weighted interval score improve while intervals narrow. There are real individual regressions and more movement in some lower bounds; this is a measured tradeoff, not a claim of uniformly better or calibrated forecasts. The two already-inspected dates support a retrospective development decision, not an independent calibration or guarantee against missed rides.

This review made no application, coefficient, database, or production changes. Reproduce with:

```sh
python3 conditional-replay-data/joint-next-occurrence-review.py
python3 conditional-replay-data/joint-next-occurrence-tails.py
```

The scripts read `joint-release-pairs.jsonl`, `raw-frames.jsonl`, and `outcomes.db` read-only. Their JSON outputs preserve selected journeys, exact leg IDs, checkpoints, exclusions, paired scores, tails, and exploratory boarding-policy/jump diagnostics. The main JSON includes the forecast capture's SHA-256.

## Correct physical occurrence and censoring

The replay's `occurrence` field is hard-coded to zero, so it cannot label the second arrival. Red has 29 distinct route stops. I select forecasts with `stopsAhead > 29`, exclude ambiguous `stopsAhead == 29` rows, and score only before the first upcoming physical target arrival. Each label requires an exact connected source-departure→first-target path followed by a complete **29-hop first-target→second-target path**, preserving bus, route indices, leg departure/arrival clocks, and intermediate visit endpoints. The connected second target must also be the earliest recorded later target visit that day. Missing or ambiguous links, gap-resolved visits, and absent next targets are excluded; a later convenient temporal match is never substituted.

Sources are completed stopped visits to Winchester (11) and Union (121); targets are Division/Prospect (48) and Rosenkranz (4). Checkpoints are source pin−120/−60 seconds, surviving pin+0/60/180/300/420/600, and departure+0/5/15/30/60. I select the first raw recording frame within 15 seconds after the checkpoint, independently of which arm emitted an ETA, require 600 seconds of uninterrupted observed-bus warmup and a served observation younger than 45 seconds, and keep absent predictions as a separate outcome. Pin-relative checkpoints describe recorded pin timing; they are not an assertion that pin equals the filter's broad rest origin.

Of 102 eligible source visits (204 source/target combinations), 84 have a complete, usable second-target path. The audit retains 833 forecast checkpoints: **574 paired, 30 candidate-only, 229 both absent, zero baseline-only**. Paired observations cover 40 source visits and 49 distinct later target visits: 42 target visits on September 16 and seven on September 17. Repeated checkpoints, different sources pointing to the same target, and adjacent targets on the same bus lap are correlated. They are not 574 independent validation cases. Only 445 paired checkpoints terminate in a recorded stopped target; the others are physical passes and cannot establish boarding availability.

The archive ends partway through September 17, and service/gaps leave other journeys without complete later outcomes. These are censored/unsupported, not successful or failed forecasts. Exact-chain selection favors well-observed uninterrupted journeys. No unconditional all-service coverage claim follows from this cohort. The four previously audited duration-origin examples (59602, 59805, 66278, 65237) contribute no paired checkpoints here; this does not repair their label issues elsewhere.

## Paired performance

All times and scores below are seconds; lower MAE/WIS is better. WIS uses the displayed median and nominal central 80% interval: `[0.5*absolute_error + 0.1*width + lower_miss + upper_miss] / 1.5`. Scoring displayed forecasts is useful even though their interval coverage has not been independently calibrated. The unchanged ceiling and subsequent transforms can make the displayed point differ from an unconstrained distribution's median.

| Source → second target, checkpoint | n | MAE before → after | Width before → after | WIS before → after | Early / late misses before → after |
|---|---:|---:|---:|---:|---|
| Winchester → Division, pin+0 | 25 | 206 → 190 | 1545 → 1172 | 174 → 147 | 2 / 0 → 2 / 1 |
| Winchester → Division, pin+60 | 25 | 188 → 180 | 1283 → 970 | 148 → 127 | 1 / 0 → 1 / 1 |
| Winchester → Division, departure+0 | 25 | 279 → 246 | 1195 → 918 | 176 → 149 | 1 / 0 → 2 / 1 |
| Winchester → Division, departure+60 | 24 | 227 → 196 | 1199 → 922 | 158 → 131 | 1 / 0 → 1 / 1 |
| Winchester → Rosenkranz, pin+0 | 24 | 270 → 232 | 1545 → 1199 | 195 → 163 | 2 / 0 → 2 / 1 |
| Winchester → Rosenkranz, departure+0 | 24 | 345 → 300 | 1275 → 1012 | 204 → 175 | 1 / 0 → 2 / 1 |
| Union → Division, departure+0 | 5 | 283 → 218 | 1950 → 1424 | 224 → 168 | 0 / 0 → 0 / 0 |
| Union → Division, departure+30 | 15 | 256 → 220 | 2016 → 1504 | 220 → 174 | 0 / 0 → 0 / 0 |

Winchester's pin+0 and departure+0 MAE and WIS improve separately on both dates, although September 17 has only four Division and three Rosenkranz observations. Restricting to stopped targets preserves the main improvement: Winchester→Division departure+0 has 22 trips, MAE290→255, WIS181→153; Winchester→Rosenkranz has15 trips, MAE347→296, WIS200→167.

This is not uniformly better in the tails. For example, Winchester→Division stopped-target departure+0 p90 absolute error rises419→438 seconds, while its median absolute error falls281→259. Narrower intervals need not retain the previous overcoverage to be useful; WIS and concrete error direction matter alongside coverage.

**Availability limits:** Union→Division is mostly outside the emitted horizon until source departure, so paired early-standing metrics are unavailable. Union→Rosenkranz has no paired second-occurrence scores at these source checkpoints; both arms omit those forecasts. Do not describe this as validated second-occurrence performance for every source/target combination.

The 30 candidate-only checkpoints span15 source visits/15 target visits on September16. Their MAE is254 seconds, average width1486 seconds, and all30 intervals contain the observed target time. There is no numeric baseline comparator, and the15 trips are not a fresh test. More available forecasts should be reported separately from paired accuracy gains.

The code's90-minute cutoff applies to the **uncorrected lead-chain median**, before route scaling/horizon bias and the displayed mixture. It is not a strict90-minute bound on shown ETA or realized time. Paired realized remaining times here range2995–5976 seconds; candidate-only cases range5057–6191. Applying a second filter `truth <= 5400` would selectively discard difficult long outcomes and bias this comparison.

## Catch direction and stability

A bus arriving before the lower bound is the concerning direction for a rider who delays walking. Four newly early checkpoint misses refer to two targets on one #309 lap, source58224:

- **Division visit58745, stopped:** at source departure, actual arrival is48.96 seconds before the candidate lower bound; at departure+5,18.58 seconds before. The target then remains stopped94.91 seconds. Arriving at the candidate lower bound would still precede its recorded departure in these two observations. The displayed point already predicts substantially too late in both arms; the candidate moves that point28 seconds earlier.
- **Rosenkranz visit58780, passed:** newly early by118.49 and55.07 seconds. This is a physical passage, not a verified door-open boarding opportunity. The candidate point moves35 seconds earlier.

The16 newly late misses are repeated checkpoints on one different slow #309 lap (source57226, targets57815/57852), rather than16 independent bad journeys. They are primarily a narrowed upper tail. Both target intervals miss by at most153 seconds among those new misses. Across paired checkpoints, no already-more-than120-second-too-late point forecast becomes another more-than30 seconds later.

As an **exploratory static commitment diagnostic**, I evaluated arriving at the stop at `point−120s` and at `low−60s`, then compared that planned arrival with a recorded stopped target's departure. Across445 matched checkpoints/37 physical stopped targets, neither policy introduces a new after-departure commitment. The point-buffer policy's repeated-checkpoint counts improve283→224; the low-buffer policy remains4→4. At Winchester→Division departure+0 the corresponding counts are17→16 of22 and1→1 of22. These figures are not rider catches or probabilities: there is no updated walking decision, notification timing, route alternative, capacity model, or guaranteed door-open clock. They also show why committing to a distant point ETA minus two minutes is unreliable under either arm.

For adjacent recorded frames at most15 seconds apart, with the same correctly linked future physical target and both forecasts available, I compare absolute predicted arrival time (`at + eta`) to avoid counting ordinary elapsed time as a jump:

| Second target | Paired transitions | Point increases >60s | Point increases >180s | Lower-bound increases >60s |
|---|---:|---:|---:|---:|
| Division | 7936 | 7 → 7 | 0 → 0 | 32 → 48 |
| Rosenkranz | 8131 | 9 → 6 | 0 → 0 | 40 → 43 |

Aggregate point-jump counts do not worsen, but individual new point jumps occur (largest93 seconds); four are on the same #309 lap discussed above. Lower bounds cross the60-second jump threshold more often, especially Division. Do not promise a universally smoother interval graphic. These transition counts are highly dependent and should be monitored alongside their affected bus/lap, not treated as thousands of independent trials.

## Model and replay scope

I rechecked the isolated implementation: marginal stand draws and pass mass remain unchanged, future lap is computed per simulated path from causal served ages or that path's earlier simulated departure, and the own-departure bridge is now obtained **per chain**. This addresses the previously identified next-lap mixed-hypothesis bug. The change is limited to Red route_id3. It preserves the existing current-rest distribution, filter, and ceiling; it does not resolve report115's separate waiting/shuffle ratchet failure or the historic duration-origin mismatch.

Metadata report12654 raw frames,117149 emitted rows,924 target/full-server parity checks and36516 baseline/candidate belief-equality checks. The replay reuses the same prior-September14 marginal table and published `fit-2026-09-15` parameters in both arms. This comparison introduces no later labels into either forecast arm. The replay does not establish that the older published fitter's own calibration was valid; the methodological repairs and promotion gates remain relevant.

The periodic parity check clones already-stepped state and compares one poll, rather than running an independent full-server trajectory. Morning collector state lacks prior-day seeds, though scoring waits600 seconds and requires completed exact outcome chains. Forecast rows do not evaluate every route/target or the `departNow` scenario. The latter remains a counterfactual, not a mathematical lower bound when later holds regulate earlier departures. Reused stop draw ranks across successive laps are inherited model dependence, not independently validated behavior.

The sensible release claim is **less unnecessarily broad Red forecasts with better typical performance in these recorded runs, while retaining explicit uncertainty and monitoring tails**. Keep coefficient/calibration changes separate, preserve unknown/censored outcomes, and use subsequent untouched dates for the next confirmation. Do not label this evidence “80% calibrated,” “no missed buses,” or a solution to every source of ETA jumps.
