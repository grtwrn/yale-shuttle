# Red decision audit finds a current-stop smoothing defect

**Research; no application change or release candidate.** Current baseline `cff3b2a6b7ad6cdd2f899bb4d564a4c03dae2d37` can overwrite an already-arrived, zero-hop pickup row with a long future-lap ETA. This is a concrete estimator invariant failure worth fixing next. This audit does not support a new ranking threshold, walking suppression rule, or learned coefficient.

## Scope and reproducible baseline

PLAN.json was written before scoring. Ten deliberately selected difficult source visits from cycle2 each generate four sessions: destinations48/4, with explicit stationary origins at the source stop and150m geometrically west. There are40 sessions, not40 observed riders. Offset origins do not establish a walkable street path. Sessions begin on the first actual poll at/after source pin−60sec and end at departure+180sec. The planner chooses its own boarding/alighting stops; several choices differ from the endpoint stop IDs.

The archive contains Red only. Current release ON and sampled future laps use the same historical causal calibration as prior development: preSep14 marginal tables, preSep10 hazard fit. This is current code with that historical calibration, not today's freshly fitted production tables. Actual GPS is recorded; collector clocks are reconstructed, not original receipt evidence. The selected dates are reused evaluation, not a fresh holdout.

`capture_fleet.mts` stepped11,081 actual polls continuously, preserving the overnight gap, and saved1,172 full Red-fleet snapshots containing160,496 wire rows. Every observed Red bus is warm, including alternatives to the focal bus. On overlap,6,025 focal11/48/4 rows AND their50-point distributions match cycle2 exactly after transport rounding. Both occurrences are retained; no new horizon or exclusion is introduced. Frozen input hashes remain unchanged.

`extract_shell.py` mechanically copies TransitMap's exact live-map body (lines2189–2301 at this HEAD), with real imports and observer wrappers; only analytics recording is suppressed. `decision_replay.mts` uses actual planTrip, live-arrival transport, journeyArrival, stableTripOrder and visibility helpers. It preserves initial boarding/alighting, plannedRideSec, and original pinned bus between polls. The empty-plan roster recovery is implemented; it was not triggered in these40 sessions. It records both countdown and catchable identities and their exact stopsAhead rows. No future labels enter this forecast/decision path.

The built actual React shell, intercepted local payloads, tester identity, mobile context and stationary endpoint drafts reproduced both entire58224→48 sessions (zero and150m offsets):156 poll comparisons of live numerical option arrays and ordered option arrays. Absolute numeric tolerance0.001 covers JavaScript distance arithmetic across Node/Chromium; timestamps/identities/keys/order are otherwise required. No page errors. This checks shell numerical behavior on these two sessions, not every UI view, screen reader, physical phone or all40 sessions. No screenshots were taken. All browsers/contexts closed.

## Decision findings

Across4,688 repeated poll decisions:

| Diagnostic | Polls/events |
|---|---:|
| Red option exists |4,688|
| Destination journey available |4,471|
| Destination journey unavailable |217|
| Countdown bus differs from journey bus |676|
| Nonzero access walk |2,344|
| Conditional journey catch risk |866|
| Red point total exceeds modeled direct walk |2,395|
| Destination window spans modeled direct-walk arrival |1,663|
| Walk ranked first |1,662|
| Rank change pending |338|
| Order changes |48 (41 Red→Walk;7 Walk→Red)|

All48 changes respect the existing30sec persistence rule. None requires inventing a new hysteresis threshold. Counts are correlated polls from selected cases. A slower median or a switch is not automatically poor advice: the current ranking deliberately considers destination windows and planned walking/riding burden.

The217 missing journeys break down into180 raw-at-stop overrides with no modeled **zero-time** boarding row, and37 cases where the destination median precedes the selected pickup median or required access walk. Some of the180 are affected by the smoothing defect below; other raw/model disagreements remain distinct. Do not call all217 the same bug.

## Established defect: pooling aliases a future lap to the current stop

`priceRoute` explicitly emits eta/low/high and all distribution points equal to0 when `stopsAhead === 0`: the bus has arrived at that stop. In eta/index.ts, releaseSmoothing instead keys memory by `stopId * 2 + occurrence`. The first occurrence changes meaning when the lead standing hypothesis toggles: a future lap at h=29 can become the already-arrived row at h=0. The guard `row.stopsAhead <= old.row.stopsAhead` admits that whole-lap identity change. Ordinary stops affected while a Winchester rest remains tracked also appear in the evidence; scope is not just the numerical stop11 row.

In the complete saved fleet windows,1,734 zero-hop rows include101 with positive ETA. Of those,84 put the pickup after a downstream row. `pooling-audit.json` records all of them, without trimming. Six observed h=29→0 aliases match the existing30sec pooling equation within1sec of transport rounding. Other hop/occurrence transitions are retained, not claimed to share one cause.

Example: source58224, bus309, timestamp1789567342286. Winchester pickup row is `[2,11,1804,1528,2063,0,0,0,0]`: zero hops, zero depart-now/floor, yet30min median. Division row is215sec at h=3. The150m session therefore rejects a destination earlier than pickup and falls back to a1,907.7sec total, while the modeled direct walk is527.7sec. Earlier transitions at1789567312286 and1789567327355 mix the prior future-lap row into a raw zero, yielding2,975/2,986sec. These are explanatory examples, not a new selection arm.

An instrumented copy of eta/index.ts, `pool-observer.generated.mts`, observes rows immediately before pooling without changing its arithmetic. On the78-poll58224 fixture it matches423 same-process wire rows and finds33 raw zero rows,19 of which become positive after pooling. This isolates the overwrite. It does not validate a repair.

**Important fixture limit:** `export_regression.mts` saved all three warm bus beliefs and78 inputs/expected full wires; restoring in that same warmed process matches78/78 exactly. A separate fresh process reproduces tracking and occurrence availability but differs in1,828 numeric rows, up to3,768sec. A separate run WITHOUT the observer has the identical discrepancy, so the observer is not its cause. The first difference is only1sec, but it grows; do not label the checkpoint a portable exact forecast fixture. Saved V8 checkpoints omit process-global caches. The precise divergence mechanism remains unresolved. Use the full continuous prefix for paired candidate scoring until this is understood. The archived wire/browser fixture remains exact and portable for UI numerical-path checks.

## Connected outcomes and limitations

`outcome_audit.py` imports only the already-reviewed exact chain function from cycle2, reads SQLite mode=ro, and labels1,420 decisions across20 distinct source/target contexts where boarding is the selected actual current source visit. Of these,1,382 modeled access walks reach the recorded bus departure;38 do not and stay explicitly flagged.175 labeled rows lack a full destination distribution. The other3,268 rows remain unmatched:1,892 different boarding stops,1,104 different buses,144 outside the selected current visit and128 noncurrent modeled boarding occurrences. No focal outcome is assigned to these alternatives.

Among reachable matched rows,481 rank Red above Walk although the eventual connected bus arrival is slower than the **modeled** direct walk. Zero matched reachable rows rank Walk first when that bus is faster. These selected conditional counts are not population regret, observed rider outcomes, or proof of a ranking defect; much of the downstream delay is already documented in cycle2. Walking time is not observed. Error sign here is predicted−actual: negative means the bus arrived later than the point promise. The largest negative examples (about−2,151sec) are raw-at-stop fallback totals at Union57454/61538, not new exclusions or repaired labels.

## Executed checks and failure history

Commands below run from the ETA worktree's `services/shuttle-v2` unless Python-only. `O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-4`; `L=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`. These are explanatory abbreviations, not environment changes.

- `python $O/freeze_plan.py` — exit0,40 sessions/15 hashes; one-time freeze.
- `flock -w 900 $L ./node_modules/.bin/tsx $O/capture_fleet.mts` — exit0,179.93sec; above full-fleet and6,025 parity checks.
- `python $O/extract_shell.py`; `flock -w 900 $L ./node_modules/.bin/tsx $O/decision_replay.mts` — final exit0,4,688 decisions/4,471 destination checks. First strict float assertion failed and was replaced with1e−6sec arithmetic tolerance; original log/incomplete rows preserved.
- `python $O/summarize_decisions.py`; `python $O/outcome_audit.py`; `python $O/pooling_audit.py`; `python $O/verify_decisions.py` — all exit0. Final verifier checks15 input hashes,160,496 ordered distributions/unique row identities,40 stable plans,all48 persistence transitions, complete outcome/missing accounting and156 browser checks.
- `flock -w 900 $L bash $O/verify_browser.sh` — Vite passed124 modules/4.90sec, then strict browser equality failed on~1e−13sec Node/Chromium distance differences. Preserved first log/JSON. `flock -w 900 $L node $O/browser_parity.mjs` — final exit0,156 checks/two sessions/no page errors; explicit0.001 numeric tolerance. Vite was not unnecessarily rebuilt after this harness-only correction.
- `flock -w 900 $L ./node_modules/.bin/tsx $O/export_regression.mts` — exit0,2,178 prefix frames;78 same-process restoration matches;168,932-byte checkpoint.
- `python $O/generate_pool_observer.py`; `flock -w 900 $L ./node_modules/.bin/tsx $O/observe_pooling.mts` — final exit0 with the above423 internal parity/raw-zero checks and **reported cross-process fixture nonparity**. Three earlier strict fixture failures are preserved; enabling already-default feature flags did not resolve them.
- `flock -w 900 $L ./node_modules/.bin/tsx $O/verify_fresh_fixture.mts` — exit0 as a diagnostic, explicitly reports `exactForecastMatch:false`; this is not a forecast parity pass. First output had inherited observer description text, preserved as `first-label`; final script/output correct that label.
- Git whitespace, worktree and index checks passed clean at cff3b2a6. No application typecheck, full suite, staging or deployment was run or claimed. No app code changed.

## Next bounded work

Independent review should establish the occurrence alias and evaluate the fixture caveat first. Then implement a narrowly scoped pooling identity repair in ETA-owned code: preserve raw already-arrived zero rows and prevent mixing different physical laps for both first and following occurrences when a standing hypothesis changes. A zero-row special case alone may leave the future row's occurrence alias unresolved. Keep route-forward tracking and legitimate ETA increases. Do not use a time cap or discard cases.

Use the saved wire/decisions for comparison and full continuous prefix for estimator state if checkpoint parity remains unresolved. Compare identical current baseline/candidate inputs, both occurrences, departure behavior, availability, raw/served distributions and the prior audited regressions. Add a substantive regression test, run targeted tests and both typechecks, and obtain independent review before a candidate. The raw-at-stop fallback without a full destination forecast is a separate coordinated ETA/UX follow-up after this numerical source defect.
