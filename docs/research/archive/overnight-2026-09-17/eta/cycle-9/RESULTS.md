# Preserve walking caution alongside trip bus identity

The controller's pending merge is resolved and ready for independent rereview. This invocation changed only the conflicting imports in `TransitMap.tsx`, retaining the ETA `atStopJourneyBoard`/`journeyArrival` import and both approved UX imports (`tripBusIdentity`, `TripBoardingActions`). The resolved file is staged as explicitly authorized; no merge commit was made.

## Exact source-control state

- Preserved HEAD: `0d0f34fa87f7d051d4c4419f04c83db13c0d4c72` (captured walking-caution correction).
- Preserved MERGE_HEAD and current local origin/master: `373505d5076f21a08de69d9587be9b2a55956642` (production PR288 trip identity).
- The controller's merge remains pending, with no unmerged index entries and no unstaged differences. Five staged files are the already-approved incoming UX change, including resolved TransitMap. Their contents are retained; this is not an instruction to discard them.
- `proposal.patch` is the full seven-file pending ETA difference against production373505d5. `incoming-ux.patch` is the five-file index difference against captured HEAD. These are different views of the same combined tree, not extra changes.
- `verify_evidence.py` proves the entire resolved TransitMap equals production's file with precisely the ETA import and HEAD's numerical block. Every other UX file equals production and every other ETA file equals HEAD. Source hashes and the frozen resolved shell are saved.

The preceding correction remains substantive: a rider walking to a shuttle already reported at pickup keeps connection caution even when the estimator's approaching pickup lower bound exceeds the walk. That context changes only catchRisk; destination windows, pickup/countdown rows, bus selection and both occurrences remain as before. UX's distinct-bus ride/wait labels and explicit boarding choices remain intact. The older smoothing/ordered-join changes remain unchanged and separately reviewable.

## Executed verification

App cwd is `/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2`. All builds and browsers ran inside one shared heavy lock, sequentially. No dependencies were installed.

1. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-9/prepare.py` — exit0. Extracts the actual resolved numerical shell. Its separate diagnostic comparator intentionally freezes pre-correction1b66a191 and its helper; it is named as that old regression comparator, not today's production.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-9/verify.sh` — exit0, `verify.log`. 221 targeted tests/15files including ETA smoothing, warm restart, parity, Docker import closure, at-stop join/caution, planner, class advice and UX identity/ride finish; backend/frontend typechecks; Vite127modules/4.77sec.
   The same wrapper also checks4688 exact historical decision/trace/ranking states;223 actual built-SPA numerical comparisons; keyboard/touch/focus, class fits/buffer/late, stale/missing/recovery states; five dwell-gate walk cases; the original reviewer walking-caution reproducer; six rendered caution boundaries. The unmodified production `scripts/trip-identity-check.mjs` passes once with `OUT=.../cycle-9/ux-mobile` and once with `DESKTOP=1 OUT=.../cycle-9/ux-desktop`, checking both pickup identities and both explicit boarding choices, final directions, Back/draft, focus removal/non-stealing, keyboard controls, mobile reflow and freshness. All browser error lists are empty and resources are closed.
3. `./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-9/risk-logic.mts` — exit0, `risk-logic.log/.json`. Eight identical-input pairs against the explicitly frozen pre-correction1b66 shell/helper preserve destination, pickup, bus and ranking values while keeping raw-at-stop walking caution. This repeats the corrected regression on the combined source; it is not a new forecast-accuracy result.
4. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-9/verify_evidence.py` — exit0, `evidence.log/.json`. Verifies exact combined sources/staged scope/unchanged HEAD+MERGE_HEAD;4688 decisions;68 classified missing cases;13598 read-only connected-leg uses/1400 matched outcomes;147 prior artifact hashes unchanged.
5. `python3 -m py_compile /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-9/verify_evidence.py` and `node --check services/shuttle-v2/scripts/trip-identity-check.mjs` — exit0.
6. `git diff --check && git diff --cached --check && git diff --exit-code && git ls-files --unmerged && git rev-parse HEAD && git rev-parse MERGE_HEAD && git status --short` — exit0, final output saved in `final-integrity.log`. Empty unmerged entries; expected staged merge and preserved commits. No empty-index claim is made.

No failed application/harness run in this invocation. Earlier failures stay in their original reports; no historical evidence was overwritten. All owned sessions8631/6741/22534 completed. No server, persistent browser, lock or watcher process was started/reconfigured/stopped. Fully intercepted browser fixtures use seedTestId. Two new screenshots total205155bytes, visually inspected; combined team census154files/6764166bytes at capture, safely below100MiB. Existing screenshots retained. Background map tiles are deliberately blocked in these local fixtures.

## Evidence and limits

The30 previously restored forecasts, zero losses, zero selected bus/rank changes, all2344 nonzero-access historical decisions and both wire occurrences remain unchanged. The earlier selected30-row mean absolute error880.88→396.87sec is the older ordered-join comparison, not an improvement from conflict resolution or the caution correction. All1400 connected outcomes remain, including source63523→63632's442.83sec absolute-error worsening and source61907. Prediction-minus-actual on63523 is+781.89sec: the restored forecast is later than the observed arrival. Seven lower/six upper misses and the remaining38 outgoing unknown cases remain documented in cycle6. No exclusion, fresh holdout, calibrated coverage, normality or observed walking-success claim.

Full suite, backend staging, Docker image build, CI, publication and production verification remain controller gates; this invocation did not run or claim them. Independent approval of the caution correction is still required. No model, tracker, wire, calibration, route-forward behavior or historical records changed.

## Next bounded action

Controller finishes its already-resolved pending merge, preserving the five staged incoming UX files, then requests independent rereview of the cycle8 caution correction in this combined tree against production373505d5. Read cycle8/REVIEW_REQUEST.md, this report and cycle9/proposal.patch. Source hashes remain usable after the merge commit; the evidence verifier deliberately pins HEAD and MERGE_HEAD and must receive an explicit reviewer provenance adaptation after capture, rather than silently accepting a new base. Keep controller full-suite/staging/CI/publication gates.

After acceptance, separately scope the38 outgoing cases or the chosen-pickup bus/visit contract requested by UX. No broad fallthrough, same-number occurrence inference, movement-cache change, model refit or completed negative-screen restart is supported by this integration round.
