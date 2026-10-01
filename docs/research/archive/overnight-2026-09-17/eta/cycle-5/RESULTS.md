# Preserve arrived pickups and separate future laps during ETA smoothing

Final proposal is the **traversal guard** in `traversal-guard/`; the broader unchanged-hop guard in this directory is rejected. Current controller base/HEAD is6220b860a69f5567557926f41de59ed1af72d2f8. Source changes are ETA index, eight substantive smoothing regression tests, and `docs/red-current-release.md`. No controller/publication or tracking change.

## Problem and fix

Occurrence0 means the next row displayed, not a permanent physical route lap. When the standing hypothesis changes, Winchester can move from future h29/occurrence0 to already-arrived h0/occurrence0; occurrence1 can move from h58 to h29. The old nonincreasing-hop guard accepts both aliases and pools unrelated visits. Ordinary stop146 is also affected while Winchester rest remains tracked.

The final guard always preserves raw zero-hop rows. Positive rows retain the old elapsed/gap/nonincreasing-hop checks and must stay within the same future traversal (`ceil(hops/ring.N)`). A traversal change uses the new forecast and seeds memory. Ordinary forward hop progress retains the existing30-second pooling. Both occurrences/distributions remain; no target, time cap, learned coefficient, tracker, planner, wire field, cache/restart setting, or outcome label changes. Existing memory serialization stays compatible.

The first implementation required exactly equal hops. Although it fixed the zero rows and passed tests, it unnecessarily removed valid smoothing on forward movement. Source65347 gained four new222–245sec rises; broader development rises over60sec increased4→19 at Division and1→16 at Rosenkranz. That implementation is **rejected**. Its source snapshot, plans, complete replay/scoring and failure logs remain here; this is not a hidden arm or a new holdout.

## Final selected full-fleet and rider results

Continuous current-code candidate replay stepped11,081 actual polls with the original overnight gap, emitted1,172 selected fleet snapshots and160,496 rows, preserving every bus/stop/hop identity and availability. Native served tracking fields agree by bus name. The baseline is preserved cycle4 current-production wire; relevant ETA/transport code is unchanged between its baseline and this controller base. Same historical preSep14 marginal calibration/preSep10 release fit; reconstructed collector clocks, no future inputs.

- All101 positive zero-hop rows become exact zero point/bounds/50 quantiles:90 at Winchester,11 at ordinary stop146. All1,734 zero-hop rows are correct.454 rows change;160,042 remain identical. Both arms retain61,142 two-arrival pairs, with no second-before-first point inversions.
- All177 already-audited selected endpoint checkpoints remain exactly equal, including both occurrences. All3,124 selected endpoint adjacent-poll jump comparisons retain their values. The14 missing forecasts and12 unconnected endpoint chains remain recorded. No selected source or genuine short/long outcome is removed.
-40 persistent hypothetical stationary rider sessions produce4,688 decisions. Full destination journeys increase4,471→4,620:149 gained, none lost,68 absent in both. All68 remaining cases are the separate raw-at-stop/no-modeled-zero-board path, not this pooling alias. Browser parity passes156 actual built-shell mobile numerical/order checks over both complete58224→48 sessions; tester identity, intercepted requests, zero page errors, no screenshots, all contexts/browser closed.
- Historical outcome matching remains strict: baseline1,420 and final1,400 matched decisions yield1,382 exact paired bus/source/target/leg identities.38 baseline-only and18 candidate-only identities stay separate; remaining alternative choices are explicitly unmatched. Access/direct walks are modeled, not observed rider behavior. All1,240 paired journeys already available at baseline retain exactly the same point estimate.
- Across all1,382 exact paired outcomes, including newly available forecasts replacing drive/planned-ride fallback, mean absolute error is316.20→319.06sec. This is **not** a complete-ETA accuracy gain. The largest new full-forecast regression is65347→65406 at recorded departure: fallback283.32sec versus forecast565sec, actual309.91sec (+228.51sec absolute error). Other retained cases58224,61907,60836 have the same fallback-to-full-forecast distinction. `decision-regression-audit.json` records five cases and exact connected leg IDs. No new raw-GPS re-audit is claimed; prior valid audits still stand.
- Rank changes48→42 in the frozen sessions; this descriptive count does not validate ranking or justify a threshold. Countdown and catchable journey buses can still differ (676→742 repeated decisions); this pre-existing semantic distinction needs UX follow-up, not relabeling alternative buses with focal truth.

## Broad current-production paired replay

Final full replay/scoring status is recorded in `traversal-guard/FINAL_STATUS.md` when complete. It uses mechanically imported current HEAD baseline and native candidate with release ON in BOTH arms, identical causal historical fit refresh at the existing13:14 afternoon boundary, all16,253 existing raw frames and exact belief-array comparisons. The afternoon is reused evaluation. Current baseline is separately checked against every archived prior-release ON row. This avoids the old release-OFF comparator and the diagnosed fresh-process checkpoint/cache divergence.

Both first-destination and second-occurrence scorers reuse the independently audited exact connection contracts and existing outcomes-complete.db in read-only mode. Missing chains, unavailable second occurrences, warmup/clock gates and all previously audited legitimate regressions remain intact. No all-route or prospective calibration claim.

## Executed commands and integrity

All heavy work acquired `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`. TS/browser cwd is this worktree's `services/shuttle-v2`; use its own local dependencies. No install was needed.

Final verification command: `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard/verify_all.sh`. Full127 files/2,755 tests, both typechecks and Vite124 modules/4.90sec passed before continuous capture, decision/browser replay and full paired replay. Exact final completion is in FINAL_STATUS; `verify-all.log` preserves every subcommand result. No complete staging/deployment was attempted; controller/CI retain that gate.

`bash .../traversal-guard/score_selected.sh` passed: paired wire/177 checkpoint/jump/both-row checks, exact connected outcomes, decision summary and strict paired-decision accounting. `python .../cycle-5/score_full.py .../traversal-guard` is the full scorer entrypoint; final counts and completion in FINAL_STATUS. Plans/source snapshots/hashes and all outputs are durable.

Retained harness failures: first wire comparator wrongly required raw lower bounds nonnegative (existing adapter clips them); second assumed bus-index ordering unaffected by ETA sorting (corrected to bus-name identity). A copied second-occurrence scorer path substitution omitted whitespace and produced SyntaxError; corrected syntax only, original log retained. These do not imply failing app assertions or passing unexecuted checks. First rejected guard's full suite had2,754 tests; do not confuse that with final2,755.

The final source matches its frozen plan and saved candidate snapshot. No new runtime import/module dependency, source/index/branch/commit/publication action, persistent process, screenshot, private feedback or original archive/DB mutation. The watcher is untouched. Request independent review of boundary semantics, future/current transitions, retained full-vs-fallback regressions and current-baseline parity; cache determinism and raw-at-stop fallback remain separate tasks.
