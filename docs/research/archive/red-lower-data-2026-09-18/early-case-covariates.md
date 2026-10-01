# Independent audit of the genuine early Division pickup cases

**Conclusion:** retain all four journeys. Only64318 is a short total Winchester hold; the other three are moderate or long holds whose raised Division lower bound misses by about2–3seconds around the departure transition. Lap compensation is consistent with the observations, but does not explain away the early tail. Own elapsed time since Union is a useful additional research lead. Existing predecessor/follower measurements are imperfect enough that inconsistent feature gains do not disprove an operational relationship.

This is a read-only, selected-case audit, with no fitting, replay rerun, application change, or record exclusion. Reproduce with `python3 red-lower-data-2026-09-18/early-case-covariates.py`. The accompanying JSON preserves source/target clocks, exact leg links, causal reconstructed wire snapshots, confirmed neighbor identities, and existing component forecasts. Old databases were opened read-only. Subsequent legacy evidence comes from the manager's immutable `red-early-covariates-2026-09-18/legacy-followup.json` export.

## What actually happened

All times below are seconds. “Lap at pin” is current modern Winchester pin minus the previous **legacy** Winchester departure, matching the served feature contract. Union age likewise uses the previous legacy Union departure. These are information available before the current departure. Hold, subsequent ride, and lower-bound error are retrospective labels.

| Source / bus / pin ET | Lap at pin | Union age at pin | Winchester hold | Departure→Division arrival | Worst raised-low error past arrival | Raised low still before observed Division departure |
|---|---:|---:|---:|---:|---:|---:|
|64318 / #309 / Sep17 08:56|3281.7|1488.3|160.1|79.8|23.5|26.6|
|65347 / #309 / Sep17 10:50|2964.2|1148.2|500.1|79.9|3.2|26.8|
|68304 / #300 / Sep17 17:25|3210.5|1665.2|285.1|75.2|2.0|22.9|
|70927 / #309 / Sep18 08:48|2789.6|1040.3|749.9|60.1|3.2|56.6|

The four whole-cycle durations, from previous legacy Winchester departure to current modern departure, are3441.8,3464.3,3495.6,3539.5seconds. Shorter travel back to Winchester is accompanied by more holding in these examples. That is consistent with compensating toward an approximately hourly cycle; it is **not evidence of an exact timetable or a known dispatch rule**. These cases were chosen because of forecast errors and cannot establish a causal coefficient.

64318 is a valid short hold after a longer lap, not an obvious recording failure. The already-saved current component at pin had q10/median/q90=175.2/317.6/428.2seconds, versus actual160.1. At elapsed60 it had q10=124.9 versus100.1remaining. Thus the model already used lap and still understated the chance of this early release. The overnight ahead-plus-follower component reduced the median at elapsed60 from259.3 to204.4seconds, but its q10=103.35 still missed the100.09remaining. Neighbor features did not make the early tail disappear.

65347 is the original long-wait report, not a short Winchester visit: it waited500.1seconds. At elapsed480 the saved current component gave q10=44.3seconds with only20.1seconds actually left. The overnight peer component gave q10=44.2, similarly late. This is an unexpectedly early release **conditional on having already waited**, which is a different modeling problem from predicting a short total hold at entry.

68304's285.1second hold is moderate.70927 waited749.9seconds after the shortest lap of these four. Its60.1second onward ride is quick but observed: the53 stopped-target journeys with scored forecasts on Sep16–17 have a90.1second median and60.0second minimum; Sep18's seven have an80.0second median and60.1second minimum. There is no evidence to remove this fast journey as impossible.

The worst changed lower-bound forecasts occur at source `departed_at`, or4.95–10.01seconds afterward. Raw polls are continuous, with maximum gaps5.19–5.42seconds. The source `departed_at` labels the last resting poll; sustained final movement starts about5seconds later. The small2–3second target-arrival misses are below one polling interval and cannot identify a distinct driver-behavior failure by themselves.64318's23.5second miss is more substantial. All have exact connected outgoing legs and close stopped target visits (closest4.0–15.9m); no gap, repositioning, wrong-lap, or impossible-speed reason for quarantine was found in the saved GPS audit. Keep the errors in scoring.

None of these raised lows falls beyond the **observed target departure**, but that does not prove a rider could board: GPS cannot establish the doors-open interval, and a rider also has walking/notification delay. Preserve arrival and departure diagnostics separately rather than claiming “no stranding.”

## What was knowable about the other Red buses

Identity uses the audited overnight contract: at focal pin, latch the latest confirmed preceding Winchester departure and the first confirmed other departure after the focal bus's previous one. Departure availability is conservatively delayed at least120seconds. Progress uses an unconditional stop-zone anchor plus15seconds, including passed visits; latest all-route assignment must remain Red and the anchor must be fresh within600seconds. The following table shows pin-time progress, not actual future peer travel.

| Source | Latched predecessor | Predecessor latest anchor | Latched follower | Follower latest anchor |
|---|---|---|---|---|
|64318|#316, left Winchester612s earlier|College/Wall,100s old;7 stops forward from Winchester|#300|Amistad/Church St South,15s old;15 stops until Winchester|
|65347|#316, left Winchester292s earlier|SCL,20s old;5 stops forward|#300|Gilbert/Cedar,72s old;17 stops until Winchester|
|68304|#309, left Winchester1280s earlier|Gilbert/Cedar,70s old;12 stops forward|#316|Chapel/Church,105s old;10 stops until Winchester|
|70927|#306, left Winchester835s earlier|Rosenkranz/130 Prospect,40s old;6 stops forward|#306, same identity|Same anchor; this does not mean only two buses were operating|

**Concrete proxy failure in70927:** the reconstructed causal wire already places #316 at Division with Winchester lap age60seconds. It has just left Winchester, but the120second confirmation proxy excludes that departure when identities are latched. The extractor therefore assigns #306 to both roles even though three Red buses are visible. That assignment is internally causal but does not capture actual immediate predecessor/follower order. A real-time rule based on “the bus that just left” could contain information this feature contract discards.

65347's predecessor source65237 has a previously demonstrated truncated pin after restart. Its observed final departure remains valid evidence; the truncation of its **hold duration** does not justify deleting its independently observed outgoing departure from neighbor history. I rechecked the raw records: #316 holds exactly41.324284,-72.928466 from30seconds before modern departure through that departure poll, moves31.0m at+4.924seconds, and continues forward at+9.926,+14.977,+20.088seconds. Exact reached leg60470 connects that departure1789656360839 to nextstop146 at1789656380927. Legacy event716638 places the same departure14.977seconds later. The conservative120second known-time1789656480839 precedes65347's pin by172.017seconds. These records are exported in `predecessor65237Audit` in the new JSON.

All four source anchor→pin delays are about15seconds and provide little separation here. Time since one's own Union departure varies substantially and is already reconstructible on the wire through lap121. Coarse stop-index gaps are not minutes to Winchester. Any “time to anchor” predictor must use a prior-only travel model or live peer forecast, including possible peer holds; actual eventual peer arrival time is hindsight. No future peer arrival/departure was used as an explanatory feature in this audit.

## Independent check of the new focused screen

Reviewed `red-early-covariates-2026-09-18/{PLAN.json,screen.py,results.json,features-predictions.jsonl}` after the correction that zeros peer features when their snapshots are unusable. The script has160 complete training holds known before Sep14 and113 later Sep14–17 holds plus12 Sep18 holds. All listed model arms are retained. Feature scaling and L2 fitting use training only; outcome labels use completed holds; peer identities are chosen at pin and snapshots are cut at forecast time. Training-only edge medians are explicitly typical travel proxies. No future event appears in the own lap/Union-age feature construction. The legacy lists used for binary search were independently checked to be sorted; the subsequently saved `capture-legacy.py` records the exact `route_id=3` and `ORDER BY departed_at` export predicates, resolving the provenance question created by omitting `route_id` from the JSON.

The stronger result is own Union age, not a particular neighboring bus:

- Adding lap to elapsed/clock improves visit-weighted Brier0.1464→0.1346 on reused Sep14–17 and0.1232→0.0879 on Sep18.
- Adding own Union age then improves0.1346→0.1323 and0.0879→0.0737. Aggregate scores improve on every evaluated date. Its fitted sign is consistent with higher near-term release chance after more elapsed time since Union, conditional on the other modeled variables.
- My independent **unweighted, fixed-elapsed** check of saved predictions finds improvement at all five Sep14–17 checkpoints. On Sep18 it improves at0/60/180seconds, but worsens slightly at300seconds (0.09164→0.09266,n11) and480seconds (0.10117→0.10333,n8). There is no universal long-wait improvement.
- It does not specifically solve64318: at elapsed60, predicted departure-within120seconds changes0.136→0.132, while the bus really leaves within100.1seconds. The combined peer arm gives0.225. On70927, both lap and own Union age correctly reduce the initially excessive short-release probability; follower terms worsen it. Case selection cannot decide which model to promote.

Important interpretation limits: `weight=1/number_of_eligible_landmarks` depends on eventual hold duration. This gives each visit equal aggregate importance and is acceptable for an explicitly visit-balanced exploratory comparison. It changes the sampled-landmark population, however; these logistic outputs are **not calibrated live probabilities** that can be converted into an arrival confidence bound. Repeated checkpoints share visits, buses, and dates. Most dates were already explored, Sep18 is only12holds, and the small additive gain has no independent uncertainty estimate. Completed-stop selection also excludes passed/unpinned service behavior. This is not validation of a complete ETA distribution or boarding policy.

## Recommendation

Keep all four cases and distinguish short total holds, early conditional releases after a long wait, departure-state lag, and fast onward rides. The narrow next research candidate is own Union departure age alongside existing own lap and clock, evaluated on all eligible visits at fixed waiting checkpoints and then in a continuous full-path replay. The replay must measure departure responsiveness and lower-bound misses against both target arrival and departure, not only average conditional-hold error.

Before interpreting neighbor effects further, make the operational identity contract closer to live knowledge: use already-confirmed causal movement/stop-exit events when available, preserve an unknown/ambiguous state, and report recently departed peers omitted by a conservative proxy. Do not supply eventual peer arrival times, silently collapse coincident identities into a two-bus assumption, remove real early departures, or raise the pickup lower bound again based on this selected-case evidence.
