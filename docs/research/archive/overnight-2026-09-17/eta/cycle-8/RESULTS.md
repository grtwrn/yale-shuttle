# Preserve walking caution for shuttles already at pickup

Ready for independent rereview. Corrects the sole blocking finding in `independent-review-round-7.md`. Entry/current HEAD is `1b66a1914a92a79c0936cf65473617cf7b7695f9`; branch/index preserved. No publication action. The four-file delta is `proposal.patch`; source hashes are frozen in `source-hashes.json`.

## Behavior

The ordered pickup join can restore a destination forecast when raw GPS already reports a bus at pickup but the estimator still calls it approaching. Previously, a 100-second walk against a 150-second pickup lower bound silently lost its connection warning. An approaching estimate is not evidence that an already-present bus will wait.

`journeyArrival` now accepts explicit pickup context, defaulting to the unchanged forecast behavior. Only the shell raw-at-stop/dwell-gated branch passes `at-stop`; there, every positive remaining walk carries `catchRisk`. The existing class panel retains its conditional arrival window and displays connection caution; that risky shuttle is not recommended solely because its destination window fits. Zero walking still allows the usual recommendation. No UI copy or class deadline arithmetic was changed.

Only one argument changes in TransitMap. No pickup synthesis, countdown edits, wire row/distribution edits, tracking/model changes, walk threshold edits, bus-selection edits or horizon changes. Both occurrences, folded-route guard, missing destination and beyond-dwell-gate behavior remain as before. The optional parameter has no new imports or server/runtime dependencies.

## Meaningful before/after verification

The new unit regressions were run against the unchanged helper first: 11 passed and 4 failed for missing caution at walks below/equal to a positive lower bound (`regression-before.log`). After implementation all 15 at-stop tests pass, including zero walk, below/equal/above the bound, unmodified generic forecast behavior, identical destination timestamps/quantiles, immutable rows, wrong/repeated visits, missing/malformed data and class caution/recommendation.

The exact supplied HEAD shell AND journey helper are separately frozen in `shell-head.generated.mts` and `head-journeyArrival.generated.mts`. The eight paired cases in `risk-logic.json` prove unchanged pickup values, destination values, chosen bus, trace and ranking. Only raw-at-stop walking caution and consequent class recommendation differ. This includes no-walk, below/equal lower bound, within/beyond dwell gate, approaching-only and missing-destination states.

The actual built SPA additionally passes six mobile scenarios (`browser-risk-matrix.json`): zero walk; 100-second walk below low150; the exact measured GPS walk equal to the pickup lower bound; 119-second walk still inside dwell gate; 121-second walk outside it; and a normal approaching bus. Assertions inspect `Connection uncertain` and its visible assumption text, preserve both pickup rows, compare destination times, check raw versus ordinary countdowns and mobile overflow, and verify no wire mutation. Equality uses the first measured GPS walk, not a rounded approximation. Zero page errors; all browser resources closed. The original reviewer browser reproducer now passes too.

These are synthetic current-state boundaries, not observed walking outcomes or a claim of production incidence. The prior reviewer found the selected archive's approach pickup lower bounds only reached13sec, so the original historic decisions do not exercise the newly corrected boundary.

## Historical evidence preserved

All 4688 current-source decisions/options/trace/order states exactly equal the previously reviewed ordered prototype. Thus the existing30 restored journeys, zero lost, no selected bus/rank changes and all2344 access-offset decisions remain intact. This correction claims no new historical accuracy improvement.

The read-only evidence verifier checks13598 connected-leg uses/1400 outcomes and preserves every original case. The prior restored-journey MAE880.88→396.87sec belongs to the earlier join proposal versus its prior missing-window fallback, not to this caution correction. Source63523→63632 still worsens absolute error by442.83sec; its restored forecast arrives781.89sec later than the observed bus (prediction minus actual), and source61907 remains. Seven early/six late bound misses and the remaining38 outgoing cases remain in prior reports. No exclusion, fresh holdout, calibrated coverage or walking-success claim. All130 prior cycle6/cycle7/review7 artifact hashes match entry state.

## Exact commands and results

Working directory for app commands: `/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2`.

1. `./node_modules/.bin/vitest run web/src/atStopJourney.test.ts` (before helper change, redirected to `cycle-8/regression-before.log`) — expected regression failure:4 failed/11 passed. The enclosing inspection command printed the log afterward, so its outer exit code was0; the Vitest failure is preserved and is not counted as a passing check.
2. `./node_modules/.bin/vitest run web/src/atStopJourney.test.ts web/src/journeyArrival.test.ts web/src/arriveBy.test.ts` — exit0,28tests passed after correction.
3. `python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-8/prepare.py` — exit0; extracts current numerical shell and forwards the new optional context through tracing. Final preparation also freezes the supplied-head shell/helper for reproducible paired comparison.
4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-8/verify.sh` — exit0, `verify.log`:173tests/11files including Docker import closure and prior smoothing/transport/restart checks; backend+frontend types; Vite125modules/4.86sec;4688 exact decisions;223 actual-SPA numerical comparisons with keyboard/touch and deadline/freshness recovery; original five walk/dwell cases; corrected original reviewer boundary.
5. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-8/browser-risk-matrix.mjs` — exit0, six actual-SPA scenarios, visible class caution and exact lower-bound equality; no page errors, resources closed. `browser-risk-matrix.log/.json`.
6. `./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-8/risk-logic.mts` — exit0, eight exact HEAD/candidate scenarios. Light targeted computation; no fitting/build/browser. `risk-logic.log/.json`.
7. `python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-8/verify_evidence.py` — exit0, exact single shell argument delta,4688 decisions,1400 connected outcomes, retained443sec regression,130 prior hashes. `evidence.log/.json`.
8. `git diff --check && git diff --cached --exit-code && git rev-parse HEAD && git status --short` — final whitespace/empty-index/preserved-HEAD/four-file scope check recorded in `final-integrity.log`.

Full suite, backend staging, physical phone/screen reader, CI and deployment remain controller gates; none are claimed here. No screenshot, dependency install, production request, private-data operation, watcher action or persistent process was added. Browser requests are intercepted and use `seedTestId`. All owned sessions22923/8059/30651 were collected. Two read-only inspection retries (unavailable rg and morning filename spelling) did not affect application checks. No app source changed after the successful types/build.

## Next bounded work

Independently rereview this small correction together with the previously reviewed ordered join. Controller handles capture/full-suite/staging/integration/publication, including approved UX identity presentation. Keep the prior smoothing approval separate. After acceptance, scope the remaining38 outgoing cases or an explicit boardable pickup bus/visit contract with UX; do not infer occurrence identity from the same bus name or restart the completed model screens.
