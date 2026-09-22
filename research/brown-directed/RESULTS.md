# Brown directed-leg experiment: completed development result

The existing directed-leg rule, restricted to Brown, fixes the observed remote-anchor phase errors without changing physical visits, source clocks or model fits. Both frozen K8 and rolling K5 remain unselected research leads. The result does not authorize a production change or a claim about full app route selection.

Final hosted run: [35691411464](https://github.com/grtwrn/yale-shuttle/actions/runs/35691411464), code `f840e7226e0abd495e0215c8a4f96b10be036c7b`. The exact spec was committed first as `73194e8`. Full artifacts, including every event, difference, forecast and action record, are in artifact 10679160904 and locally at `/home/gwarren/projects/yale-shuttle-watcher/brown-directed-results-35691411464/`.

No September 21 or later outcomes were used. All replay, fitting, tests, model scoring and action simulation ran on GitHub. Local work after download summarized existing artifacts only. No production files changed.

## Every pre-score gate passed

- Baseline reproduces all 51,581 canonical semantic visit records. Brown has 722 physical visits in both arms, with exact bus/provider/route/stop-occurrence arrival, departure and actual-emission knownAt multisets. No physical or metadata discrepancy.
- There are 120 physical anchor-only shifts: 76 at Humphrey/Whitney(index 7), 44 at Union(index 5). The largest is an earlier anchor by 204.894s; physical arrival/departure/knownAt stay identical. Total Brown records 849→728 because 121 remote unpinned null/null bookkeeping passes disappear; the unpinned ledger 127→6 is retained, not silently discarded.
- All 243,123 non-Brown detector/visit/leg events match line-for-line. All 42,193 non-Brown features and 2,032 original Brown evaluation features reproduce their controls.
- All 343 causal Brown source departure/knownAt emissions and every exported origin map match. Brown feature differences are restricted to nearest/index/began/release-latch bookkeeping. Four full-reducer prefixes and four feature/source prefixes pass.
- Brown physical training-path multisets match at all original frozen/daily cutoffs: 1,447, 1,901, 2,428, 2,921 paths. All 1,352 numerical fit/support comparisons for the two Ks across target groups match, including unsupported fits.
- All 4,064 original lead forecast/evidence/reason/hybrid controls match. Original raw, canonical labels/features/visits/topology, deployed baseline projections and prior window/action artifact hashes remain identical. Unscored forecasts were persisted before joining fixed labels.
- Deployed point changes 0; later lower bounds versus deployed 0; unsupported changes 0. Original deployed/control action records 1,440 match, point-action checks 640 match. Existing window and reminder tests and production reminder-rendering parity pass.

Runs 35689458971(attempts 1/2) and 35690278294 ended in runner cancellation without an assertion result or artifacts. Instrumentation located the first comparison after both replays. The workflow had omitted canonical's Eastern timezone for visit day/hour fields. Restoring the exact original TZ and bounding diagnostics to individual records produced clean controls; no scientific gate was relaxed. Stage 1 passed 35690562531 and stage 2 passed 35691066135 before final scoring was enabled.

## Same cohorts, not changed-subset winner selection

Fixed evaluation has 2,032 generated Brown rows, 1,555 labeled rows, 35 physical pickups, and 477 unlabeled rows. All are from reused September 17–18 development dates. The shared four-arm union has 709 rows/19 pickups. The original two-lead union remains 511 rows/18 pickups. The union expanded, so its baseline coverage differs from the earlier union; that is not degradation of the unchanged controls.

The following is visit-balanced on the SAME709-row / 19-visit union. Current deployed raw width is 1,102.93s and printed width 1,157.70s. Every arm has exactly the deployed point MAE 187.16s.

| Arm | Source journeys | Raw narrowing vs deployed | Printed narrowing | Raw coverage | Printed coverage |
|---|---:|---:|---:|---:|---:|
| Frozen K8 original |9|68.13s|69.14s|96.366%|96.900%|
| Frozen K8 Brown guard |9|69.17s|70.17s|96.366%|96.900%|
| Rolling K5 original |13|78.63s|79.47s|96.366%|96.900%|
| Rolling K5 Brown guard |15|116.66s|118.23s|97.275%|98.740%|

The guard adds 1.04s raw narrowing for K8 and 38.03s for K5 on that shared union. K5 raw coverage improves 0.909 percentage points. No late-window misses occur on the union; no new early >60s visits, false-now forecasts or point/low/high ordering reversals occur. Ordering support is 70 labeled adjacent pairs / 129 generated pairs. The guard reduces K5 severe-early visits 3→1.

Consistency matters: guarded K8 raw windows are narrower on 41.8% of visit-balanced union exposure and wider on 12.9%; guarded K5 narrower 67.1% and wider25.2%. Printed counterparts are 39.7%/7.1% and 60.1%/21.0%. Neither arm narrows every view. Production aging checks at 0/5/15/30s retain narrowing and produce no unavailable bands.

On the fixed original 511-row/18-visit union, guarded K8 is numerically unchanged; guarded K5 adds 6.21s narrowing, with coverage 99.185% unchanged. On ALL 1,555 rows/35 pickups, guarded K8 narrows 36.64s with coverage 93.022% unchanged; guarded K5 narrows 54.84s with coverage 93.330%(+0.308points). Full-route late rate 3.164% is unchanged and all late overruns are<=30s. These full denominators remain visible even though the common changed union meets the>=60s mean-width gate.

All observed Brown deployed comparators are live fallback; this is additional Brown checkpoint scope, not proof of improvement to an already deployed Brown checkpoint section. September 17 union has 8 visits and September 18 has 11. GuardedK8 widens September 17 by 44.63s and narrows September 18 by 151.94s. GuardedK5 narrows those days by 68.08s and 151.99s, respectively. Two reused dates remain inadequate for generalization or winner selection.

## Phase and handoff behavior

The named #304 September 18 10:14:45ET state now remains drive-from-Phelps(index 4), not the remote State St(index 6) bookkeeping origin. At 10:17:15 it reaches the same actual Union hold(index 5), at the same time. Origins and their knowledge times are identical. No second physical lap or invented source departure is introduced.

K8 matched handoffs decrease 9→7: both spurious phase-return edges disappear. Three 45-minute source-expiry and four 15-second freshness edges remain unchanged. K5 has 18 matched handoffs in each arm: five phase-only edges disappear, confirmed-departure edges increase 1→5, and one 45-minute source-expiry edge appears. Five source-origin switches, six freshness edges and one group-countdown expiry remain. All retained handoffs have same-provider continuous GPS both between forecasts and through physical target departure. K8 excludes 15 unobserved/different-visit/unlabeled transitions; K5 excludes 13 originally and 14 with the guard. These are not counted as observed handoffs.

A large contraction after a directly observed major-wait departure can be the live handoff the rider requested. The five guarded K5 confirmed departures all have actual reducer emission before the forecast, exact original physical labels and continuous same-provider GPS:

| Forecast ET | Bus / pickup | Absolute point jump | Absolute low jump | Absolute high jump | High jump beyond deployed | Immediate upper margin above actual pickup |
|---|---|---:|---:|---:|---:|---:|
| Sep17 08:30:45 |#126 / Divinity|-54s|+114s|-22s|+60s|108.7s|
| Sep17 13:33:00 |#126 / Divinity|-18s|-5s|-252s|-244s|297.9s|
| Sep17 15:33:15 |#126 / Divinity|-15s|-4s|-372s|-361s|243.9s|
| Sep17 16:31:00 |#126 / Divinity|-7s|-5s|-570s|-565s|337.5s|
| Sep18 10:30:15 |#304 / Divinity|-46s|-11s|-10s|+98s|267.8s|

Every point jump is exactly deployed. Four lower-bound jumps are exactly deployed; the 08:30:45 lower bound moves 114s later(129s beyond deployed's update) when the wait ends, still 445.3s before actual pickup. It causes no later reminder or added hypothetical missed boarding in the common action replay.

The largest contraction at 16:31 follows Union departure 16:30:26.344, actually known 16:30:46.300. Point and low move only−7/−5s, while the upper bound sheds unresolved-wait uncertainty. This is an evidence-supported handoff, not a phantom phase cliff. It remains an individual review item rather than an automatic failure or automatic acceptance of all future contractions.

Across 171 subsequent logged forecasts for those same five physical visits, every forecast equals deployed fallback exactly. There are 3 existing live upper-tail misses(max15.543s, none>30s) and one 0.845s early miss; one printed upper bound misses by 1.138s. The guard adds none. The first two visits' forecast logs end 16.2/8.7minutes before pickup despite continuous raw GPS, so this is sampled calibration evidence, not complete journey coverage.

Keep source expiry separate: at Sep17 11:52, #126/Union remains physically held at Science Park(wait 0), with no departure emission. The 45-minute source 4 clock expires and absolute high increases 210s(207s beyond deployed); low+15s and point+1s equal deployed. K8's largest existing 45-minute expiry still contracts high 468s(470s beyond deployed) while a real wait continues. Freshness/age policy experiments are not silently folded into this phase guard.

## Rider action and waiting costs

These are fixed-bus/stop-occurrence proxies, not actual rider misses or a full journey selector simulation. Arming remains deployed-point 5–20 minutes, walks 1/3/5/10 minutes, 30-second buffer, response 0/30 seconds, with point/raw-lower/production-rendered-lower policies. No added paired hypothetical misses or later reminders appear versus deployed or the corresponding original lead in any fixed cell.

There are 20 armed physical visits. Rendered-lower common scored pairs for walks 1/3/5/10 minutes are 10/13/14/16. Deployed censoring is 10/7/6/1 visits respectively; 10-minute also has 3 already-too-late-at-arm visits, outside prospective success comparisons. Some K5-only triggers lack a scored deployed comparator and are not claimed as rescues.

GuardedK8 action decisions and waiting are unchanged from originalK8. GuardedK5 versus originalK5 adds mean waiting 13.40/0.846/0/0.875 seconds for 1/3/5/10-minute common walks; maxima 134/11/0/14 seconds. The 1-minute maximum is #304 Winchester/Sachem on Sep18: reminder 07:46:44→07:44:30, total hypothetical wait 907.591→1041.591s. For a 3-minute walk at that same pickup, the change is only 11 seconds; the 10-minute difference is #304 Divinity reminder 10:29:28→10:29:14. A 30-second response yields the same paired waiting differences. These waiting costs remain relevant even when no simulated boarding is lost.

## Constraints and next decision

Both original leads and this fixed Brown-only guard remain research results. Fixed numerical development gates pass on the shared union; no model is promoted. The fresh-date gate still requires >=30 pickups, >=12 source journeys and >=3 unopened service dates in proposed scope, plus satisfactory handoff and whole-app selection/ranking checks. K8 has only 9 source journeys here; both have only 19 union pickups on 2 reused dates. Mean gains do not replace those gates.

Keep the complete frozen parameters: Brown route 19 only; waits 0/5 and all canonical target groups; frozen K8 versus daily-rolling K5 with full prior-calendar-day embargo and actual knownAt; 90-minute training paths, 120-minute time-of-day weighting, q10/q90, 12 effective paths / 3 material dates; 10-minute warmup, source <=45 minutes, observation <=15 seconds; whole-group support/countdown fallback; exact deployed point and protected early bound. The hybrid is not a coherent 50-quantile distribution. Do not export new probabilities or infer unchanged planner rankings from unchanged pickup point timing.

Option A remains a proposal only. The separate clock-factor findings are not combined here; no new constants, smoothing, changed Ks, later dates or production behavior were chosen from these outcomes. The evidence supports the causal phase-provenance correction while leaving selection, prospective support and remaining validity-expiry behavior for explicitly pinned follow-up work.
