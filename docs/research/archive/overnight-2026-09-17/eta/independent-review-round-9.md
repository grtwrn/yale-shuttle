# Independent review: selected pickup identity and visit contract

**Verdict: research_only. No blocking research findings.** The missing-destination identity defect and same-vehicle later-visit wait defect are reproducible in the unchanged production source and built SPA. The proposed separation of countdown and selected boarding evidence is supported. This is not approval of application code or new production coefficients: there is no candidate diff.

Exact independently verified head and base are both `d5a392f533e8684320259ff0d323a3b0da75cc50`. Checkout/index were clean on entry and remain unchanged. The current baseline includes the earlier ordered-join/caution integration; the previous review8 correction is present in source. This review neither republishes that correction nor claims a fresh deployment verification.

## What was independently established

The production numerical block in TransitMap retains `picked.match` for the approaching countdown and uses `picked.boardable` for wait and destination pricing. Only the destination result retains the boarding bus in the returned option. `tripBusIdentity.ts` consequently falls back to the countdown bus when `journeyArrival` disappears. TransitMap's expanded wait line switches to `waitSec` only when the two bus names differ. It cannot distinguish two visits by one vehicle. These are existing presentation defects, not estimator defects introduced by this research.

Reproducing the exact current-source extraction, including the `pickupState` argument, gives all 4,688 previously reviewed option/trace/ranking states exactly. The census, summary, boundary output, generated shell and build-provenance report are byte-identical to builder outputs. Eleven frozen input hashes and all 30 cycle10 artifact files remain intact.

I also wrote `review-round-9/direct-selector-audit.mts`, which does not import the generated shell, trace instrumentation or research metadata helper. It reconstructs live visits from each wire, applies the current production picker or raw-at-stop gate directly, and checks the saved boarding/countdown rows, occurrence hops, bounds, waits and selection times. All 9,376 historical/ablation selections pass: 6,464 forecast selections and 2,912 raw selections across 1,172 source frames. This confirms the projection is reporting the existing selection, not introducing a second selection algorithm.

The historical census remains 2,490 same-visit, 1,456 raw-current and 742 different-bus decisions. The 742 span 18 sessions and nine source visits; the whole census spans 40 selected Red sessions, ten source visits and two already-used dates. These are repeated, dependent checkpoints with fixed historical plans and hypothetical access walks, not independent riders or an all-route incidence estimate.

The destination ablation removes the target rows and their corresponding distributions, preserving pickup rows and source positions. In this selected Red cohort all 4,688 pickup selections, countdowns and waits remain equal. It causes 742 known different-bus selections to lose their displayed boarding identity. These are synthetic missing-data sensitivity cases, not 742 observed outages. Destination totals can fall back to planned ride time and need not remain equal. **Do not generalize selection invariance to every route:** the folded-route boundary deliberately demonstrates that missing destination evidence can change which pickup is positively rejected by existing rules. The future metadata must project the current picker result in either state.

## Browser and rider findings

The existing bundle is verifiably current: all 81 repository source modules in sourcemaps match this checkout, and 20 asset hashes remain unchanged after the checks. The builder's eight-state actual-SPA reproducer passes independently. I extended the same controlled fixture with explicit rendered wait-chip assertions and ran it on mobile and desktop. Neither run modifies application code or injects alternate selection results.

- With countdown #307 and selected boarding #309, the internal wait is 1,070.9468 seconds and the detail shows `17 min` for #309. Removing destination rows preserves that wait but changes the detail to `now-2 min` for #307.
- With the selected pickup on #307's later visit, the wait is 2,500.9468 seconds, but the detail also shows `now-2 min`. Removing its destination leaves that discrepancy unchanged.
- Destination/freshness recovery restores the expected distinct-bus identity. Stale forecasts remove the wait chip. When the distinct boarding action has keyboard focus and destination data disappears, focus returns to the one remaining manual action. This lifecycle passed on mobile and desktop.

All three browser invocations completed eight recorded states, with zero page errors, no horizontal overflow and closed pages/contexts/browsers. The two reviewer extensions also check seven visible wait states and the focused-action removal transition. These are local synthetic fixtures using `seedTestId`, intercepted requests and the current compiled SPA; no production requests or rider analytics writes occurred. No screenshots were added. No same-bus-later case exists in the selected historical census: its existence is established by the synthetic selector/browser fixtures only.

## Evidence retained and interpretation

All 1,400 previously connected outcomes retain exactly their current total and destination availability. The existing source63523 regression remains +442.82701916224846 seconds of added absolute error in the older ordered-join comparison. That is historical evidence retained here, not a new comparison against today's production and not a gain/loss from this metadata proposal.

The 38 raw selections without a compatible modeled pickup remain exactly the previously audited cases, with only the h29 pickup available: 24 precede and 14 follow retrospective recorded departure. They are not relabeled as current forecast visits. Synthetic destination removal also removes 30 optional approaching forecast links, yielding 68 raw-unlinked selections in that arm; this is not 30 new tracker failures. No raw physical availability guarantee follows from the current at-stop flag.

No outcome or future neighbor trajectory enters the new selection projection. No fit, tail optimization, new exclusion, arbitrary cap, nominal coverage or calibrated probability claim is made. Earlier neighbor/service-role evidence remains exploratory and score-/weighting-dependent; log-loss gains with flat/worse Brier and date-confounded identity groups do not authorize coefficients. The reused September16–17 recordings are not a fresh holdout.

The builder's first evidence-verifier failure was a transcribed precise decimal, not changed data. Its original script/log remain preserved. The final verifier checks the reported rounding; my independent final-integrity check also verifies the exact original 442.82701916224846 value.

## Executed commands and results

Commands using application dependencies ran from this checkout's `services/shuttle-v2`. Reviewer copies reroute only outputs and preserve frozen input/comparator paths. All browser/test commands below held the shared heavy lock.

1. `bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9/reproduce-light.sh` — **exit0**. Runs reviewer copies of `prepare.py`, `tsx audit.mts`, `tsx boundaries.mts` and `verify_build.py`: 4,688 exact numerical/trace/ranking comparisons, 4,688 missing-target selections, 13 boundary checks and 81 built-source matches. Individual logs retained.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9/browser-contract.mjs` — **exit0**, eight states, no page errors, resources closed.
3. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9/verify_evidence.py` — **exit0**, 11 frozen inputs, 4,688 paired selections, 1,400 retained outcomes, 38 raw-unlinked cases and retained regression.
4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9/extra.sh` — **exit0**. Executes `vitest run web/src/planner.test.ts web/src/journeyArrival.test.ts web/src/tripBusIdentity.test.ts web/src/etaSource.test.ts` (101 passing tests), then the reviewer browser assertions on mobile and desktop. Both pass, including focused manual-action removal.
5. `./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9/direct-selector-audit.mts` — **exit0**, all 9,376 direct selector/raw-gate comparisons pass without the builder's projection helper.
6. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9/final-integrity.py` — **exit0**, exact head/base, clean worktree/index, five byte-identical reproduced artifacts, 30 builder files unchanged, 1,400 retained outcomes and exact worst regression, unchanged source/assets and closed browsers. At capture, combined team screenshots were 196 files / 8,857,836 bytes; reviewer added zero.
7. `git diff --check && git diff --exit-code && git diff --cached --exit-code && git status --porcelain && git rev-parse HEAD && git rev-parse d5a392f533e8684320259ff0d323a3b0da75cc50` — **exit0**, exact identities and no changes.

No typecheck, new Vite build, full suite, staging, Docker image build, production call or deployment was needed or claimed for this artifact-only round. The built source provenance is verified; implementation must complete appropriate code gates later. Read-only inspection initially asked for nonexistent `REPORT.md` before using the actual `RESULTS.md`, and `rg` became unavailable, so later searches used grep; neither was an application/test failure.

## Next coherent slice

Have the controller coordinate one ETA/UX proposal: retain the existing selected boarding bus and snapshot-local occurrence in TripOption, independently of destination availability; consume it for expanded wait/ride attribution while preserving countdown and both arrivals. ETA owns the type/projection and two selection return sites; UX owns copy, wait and manual-action consumption. Do not ship an unused metadata-only half or copy the research trace scanner into production: projection must receive the exact current option's selected rows.

Separate different vehicle from different visit. A later visit needs its selected wait and a succinct explanation; it must not create two identical same-vehicle boarding actions. Keep missing destination windows unknown, preserve manual boarding of the physical bus and existing walking caution, and retain stale/departed/future/walk metadata clearing. `selectedAtMs` is client selection time; `stopsAhead` is snapshot-relative, never a durable visit ID or server timestamp.

Acceptance should preserve current numerical outcomes/rankings and both occurrences, add actual mobile/desktop keyboard lifecycle tests for missing/recovered target, same-bus later visit, raw and ordinary selections, no catchable arrival, future plans and folded-route missingness, and exercise both explicit manual actions. The 38 unknown raw cases and movement-cache determinism remain separate. Do not restart the completed neighbor/clock/service-role screens.

All owned sessions (60533, 83732, 79734, 60722) completed. No server, persistent watcher, browser or lock remains owned by this review. Existing watcher, prior evidence, application source, historical records, other-team files, credentials, Git state, controller files and publication remain untouched.
