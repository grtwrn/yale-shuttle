# Union arrival errors have different downstream causes

No application change is proposed. The current production implementation reproduces the selected historical release-ON forecasts exactly. Large Union errors are not explained by a common source pin-clock offset: two late trips accumulate substantial intermediate residence and within-leg holds before Winchester; one fast trip is mainly overestimated before Winchester, while another is mainly overestimated at the future Winchester wait. These findings do not justify resetting a clock, capping an ETA, changing the tracker, or excluding a trip.

## Comparator and provenance

The code is unchanged HEAD `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`, including PR281. `TRACE_PLAN.json` was written before the trace. The ten sources were already frozen by `PLAN.json`/`case-manifest.json` independently of cycle1: five largest archived release-ON full-arrival errors per regulator. This deliberately difficult sample is **not a population accuracy estimate or a fresh holdout**. September16–17 observations were previously inspected. No new model was fitted.

`trace_current.mts` imports the current app, enables current release pricing and sampled future laps, uses the archived pre-September14 marginal tables/pre-September10 Winchester fit, and keeps the belief continuously warm through actual frames. There are 11,107 input frames, one preserved overnight gap, 4,116 saved bus frames and 163 exact rounded full-ServerEta parity checks. All 242 previously saved selected release-ON checkpoint ETA/bounds match to **zero difference**. The additional Winchester target and optional quantile output do not change those endpoint estimates.

Recorded GPS coordinates are actual observations; collector pin/lap fields in these raw frames are reconstructed. This is current-code replay with causal historical calibration, not a replay of exact originally served HTTP receipts or every live calibration refresh. Retrospective outcomes select capture windows/checkpoints and score predictions; they never enter forecasting.

## Where the error exists at Union departure +60 seconds

All values below are seconds. Errors are **predicted minus actual**: a negative number means the bus arrived later than predicted. Winchester uses its connected `arrived_at`, not its pin. Division and Rosenkranz preserve their own exact arrived-at labels.

| Union visit | Actual remaining to Winchester | Winchester error | Division error | Rosenkranz error |
|---|---:|---:|---:|---:|
|57454|2356|-844|-658|-697|
|61538|2170|-680|-398|-345|
|63523|1100|+388|+405|+411|
|57990|1340|+150|+475|+498|
|58510|1291|+206|+349|+386|

The two largest pre-Winchester underestimates diminish as real intermediate delays become observed. At stop115 departure+5, their Winchester errors are −454/−490 seconds; at stop75 departure+5, −104/−214; at stop30 departure+5, −44/−5. Those are observed milestone comparisons, not a claim that the error would have been predictable earlier. Forecast movement when new evidence arrives can be legitimate.

The exact retrospective source-departure→Winchester-pin identity separates nonoverlapping recorded intervals:

| Source | Total to pin | Within-leg elapsed | Of that, recorded hold | Between-leg residence | Winchester pin→departure |
|---|---:|---:|---:|---:|---:|
|57454|2411|1356|540|1060|180|
|61538|2225|1271|560|960|100|
|63523|1155|800|130|360|375|
|57990|1395|1041|235|360|150|
|58510|1351|985|175|370|170|

An explicit approximately −5-second final arrival-to-pin adjustment completes each identity. Within-leg elapsed includes holds; between-leg residence includes stopped/passed detector intervals. Neither is labeled pure drive or passenger boarding. No legacy `arrivals.dwell_sec` subtraction was used. Full leg/visit IDs, recorded drive/hold fields and all identities are in `trace-outcomes.json`.

The late cases have long residences at stop115 (215/220 seconds) and stop75 (335/220 seconds). A new recorded-coordinate audit of all ten selected visits at those two stops found continuous coverage (maximum observed gap 5.12–6.249 seconds), repeated-coordinate plateaus and changed coordinates 4.851–5.089 seconds after stored departures. Long visits include multiple coordinate runs; identical GPS is deadband-censored movement, not proof of exact physical stillness or open doors. There is no positive measurement-error evidence supporting an exclusion. See `intermediate-raw-audit.json`; prior source/Winchester audits were not repeated.

## Internal sampled components, checked against untouched code

An artifact-only observer copy of `arrival.ts` records the existing lead-cluster samples at the five fixed Union departure+60 checkpoints. It uses identical saved warm beliefs, causal tables and lap ages. The observer makes **no changes to forecast samples**. Every output row and all quantiles equal untouched `priceRoute` and the original served trace: 25 row checks and 5,120 per-sample additive identities pass. `prepare_component_probe.py` reproduces the copy from a hashed app source; no application file is edited.

These are weighted sample **means before display corrections**, not the served median or a new ETA. Means add; subtracting displayed medians would not isolate a wait.

| Source | Before Winchester: modeled / actual | Future Winchester wait: modeled / actual | Winchester departure→Division: modeled / actual |
|---|---:|---:|---:|
|57454|1391 / 2356|294 / 175|78 / 85|
|61538|1371 / 2170|298 / 95|78 / 75|
|63523|1368 / 1100|339 / 370|78 / 90|
|57990|1371 / 1340|407 / 145|78 / 95|
|58510|1377 / 1291|250 / 165|78 / 95|

For the late cases, overestimated later waiting partly offsets underestimated time before Winchester; it does not cause their overall early predictions. For57990, pre-Winchester modeled mean is close while the future wait is 262 seconds too long. Source63523 instead has a 268-second pre-Winchester mean overestimate and a slightly short future wait. One uniform correction cannot be justified from this contrast. Mean component discrepancies and served median errors need not sum to the same number because the display applies quantiles and learned corrections. Rosenkranz component details are retained in `component-probe.json`.

The probe also explains a second-occurrence availability limit: at all five source+60 snapshots the raw lead-chain second Rosenkranz median is 5451–5588 seconds, beyond the existing5400-second horizon in current `priceRoute`. That row is omitted by existing code. No new cap or deletion was introduced. Two of these cases have connected second-Rosenkranz labels, and their missing predictions remain explicitly counted. This observation is not evidence to change that horizon without a separate rider/availability study.

## Both occurrences, tails and stability

Exact chains recover20 first destination endpoints, eight second destination endpoints (first target plus exactly29 connected hops), and five Winchester endpoints. Twelve second chains fail existing connectivity requirements and are retained with reasons; no outcome is silently repaired. All33 connected elapsed-time identities pass. In particular Union57990 and Winchester58224 share downstream evidence. Scored source contexts are not independent journeys.

At predeclared source standing0/60/180/300 and departure0/15/60 checkpoints,177 rows are scored and14 forecast absences retained. This includes29 Winchester diagnostic rows,116 first destination rows and32 second destination rows. `trace-scores.json` preserves MAE, median/p90 absolute error, WIS, width, directional misses, stopped endpoints, source/target counts, and every missing row. These selected-case metrics describe the chosen bad cases, not population performance. There is no candidate arm, catchability claim or calibrated-coverage claim.

Across continuously observed selected source-pin→first-target windows, deduplicated by bus/actual target/time, first destination occurrences have5,812 adjacent pairs,25 downward absolute-arrival changes beyond60 seconds (16 bus/time events), and zero upward changes beyond60. Second occurrences have2,229 pairs,three downward changes beyond60 (two bus/time events), and zero upward changes beyond60. The largest first-occurrence destination decrease is about251 seconds after Union63523 begins departing. These are current-production transitions, not regressions introduced by this work or demonstrated missed rides. The zero upward count is scoped to these windows and cannot contradict earlier broader replay counts. Missing forecast transitions are excluded from jump arithmetic and kept in availability records.

## Commands and harness corrections

All paths below are relative to `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-2` unless written fully. TS commands run from the assigned `services/shuttle-v2`. Heavy commands use `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`.

1. Locked `./node_modules/.bin/tsx <cycle-2>/trace_current.mts` — exit0,73.68s; `current-trace.log`/`current-trace-meta.json`.
2. `python <cycle-2>/trace_outcomes.py` — final exit0,33 connected endpoints and12 missing chains. Initial harness assumed the compact manifest had stop_index; fixed only the harness to retrieve the full existing visit by ID and assert matching compact fields.
3. `python <cycle-2>/score_trace.py` — exit0,242 exact archive comparisons,21,429 ordered50-quantile vectors,177 scored/14 absent checkpoints; `trace-scores.log`.
4. `python <cycle-2>/prepare_component_probe.py` — exit0, generated observer and snapshot replay, recorded source hash/observer contract. Re-run only when extending diagnostics; no data/model fitting.
5. Locked `./node_modules/.bin/tsx <cycle-2>/capture_components.generated.mts` — exit0,8,478 frames to capture five exact warm snapshots,119 additional full-server checks,54.61s; `component-snapshot.log`. This extra pass captured belief arrays unavailable in the first trace; it did not replace/restart the completed scoring experiment.
6. Locked `./node_modules/.bin/tsx <cycle-2>/probe_components.mts` — final exit0,25 exact row checks,5,120 sample identities, all five existing horizon omissions verified. The first observer used a `.ts` file outside the ESM package, creating a separate module state and failing parity; changed the research observer to `.mts`. The failure log is retained as `component-probe.cjs-harness-failure.log`, and the old generated `.ts` is superseded. No app bug/fix is inferred from that harness failure. Final extension reran only the five saved snapshots.
7. `python <cycle-2>/audit_intermediate_raw.py` — exit0,ten new intermediate visits covered; `intermediate-raw-audit.log`.

No application changes required another typecheck, frontend build, full test suite, browser or staging run; none is claimed for this round. No dependencies installed, screenshots created, daemon launched, watcher touched, database modified, branch changed, commit or publication action taken.

## Next bounded work

Independent review should check the observer module identity/parity, exact chain/occurrence matching, frozen calibration, chronological inputs and missing-case accounting. Reuse completed traces and the saved five warm snapshots rather than rerunning them without a concrete need.

The selected downstream-clock slice is complete with no supported clock repair. Actual first-publication provenance remains unavailable from reconstructed frames. Advance backlog4 to a genuinely distinct service-role state experiment: first compare the existing two-prior-departure phase/survival arms in `red-window-data/release-policy-review.md` and their data, then predeclare one shrunken same-day history state with explicit reset/support/fallback. Do not rediscover previous-departure+3600 or refit cycle1. Require gains beyond lap/elapsed/15-minute clock, and retain full rider replay as the promotion gate. The present pre-Winchester delay evidence is a separate research lead; earlier naive recent-hop pace shortcuts failed and should not be silently reinstated.
