# Independent review 13 — current get-off prompts and ride recovery

Reviewed September 18, 2026, 04:41–04:47 ET (controller round 10). **Verdict: approve. No blocking findings.**

Exact HEAD: `bffa61342d00ce87fca5b8f228e206357b8b93b5`.
Exact supplied base and merge-base: `8aa67bd7f3883598f9458d825d97a52cbc004e0f` (PR291).
Intermediate parent: `7f681d92a7d30331728d637216dabecf9d9e356c` (pickup selection, previously approved in review 12).

I inspected the complete 12-file combined diff against the supplied base, including the five-file new ride slice. Source hashes match the builder evidence; independently rebuilt sourcemaps match the current application source. HEAD, tree, tracked checkout and index remain unchanged and clean. No tracked files, Git state, publication or controller files were modified.

## Supported behavior

An open get-off prompt now follows current stop evidence. Two/one/zero stops still produce the existing instructions; lost/stale/missing/empty evidence produces **Live stop position unavailable**, and a newly supported farther position says how many stops remain. The prompt identifies Red #307 and its exit, provides a brief stop-sign reminder during unavailable tracking, and links its description through ARIA. The existing one-shot notification trigger remains exactly unchanged. The UI neither invents an arrival nor treats unavailable positions as arrival evidence.

Dismissing a restored-ride prompt returns focus to Done when no prior control exists. Surviving external focus remains undisturbed. Done, automatic ride endings, Dismiss and Find another shuttle retain a useful focus target and the final walking destination. The finish region remains usable when final coordinates are absent.

The earlier pickup changes remain intact: selected #309 and its 17-minute wait survive loss of destination forecasts, while a later visit by #307 uses its 41-minute wait with one physical-bus action. Explicit manual boarding persists through reload without persisting a forecast occurrence. Stale, failed, missing, departed and future states clear live selection metadata; raw-at-stop walking caution and both upcoming arrivals remain unchanged. Missing destination data still produces unknown class arrival, not a fabricated probability or certainty.

## Independently executed checks

Fresh evidence: `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/`.
Service cwd: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`.
All tests/typechecks/build/browser work acquired the shared heavy lock. No dependencies were installed.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/browser flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/verify.sh`

   **Exit 0**, `verify.log`. All 62 tests across eight files pass; both backend/frontend typechecks pass; Vite builds 128 modules. The actual rebuilt SPA passes mobile and desktop checks, each with 14 recorded states / 44 fixture requests. Tests exercise ongoing and initially unavailable evidence, failure expiry/recovery, notification count, touch dismissal, Tab/Shift+Tab/Escape, external focus, manual/automatic finish, final destination and origin-free walking directions, Map/Trip recovery and 44px controls. Reflow widths include 320/360/390/430 and 640/1280 CSSpx. No browser errors; resources closed.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/integration.sh`

   **Exit 0**, `integration.log`. The checked script executes:

   - `npm test -- web/src/livePickupSelection.test.ts web/src/planner.test.ts web/src/journeyArrival.test.ts web/src/atStopJourney.test.ts web/src/arriveBy.test.ts web/src/accuracy-closing-bus.test.ts src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts` — 156 further tests / nine files pass. Covers real selector projection, repeated pickup/destination visits, closing buses, walking caution, unknown class arrival, restart/corrupt/old checkpoint handling, server row parity and Docker runtime dependency closure. Total with step 1: **218 distinct tests in 17 files**.
   - `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/pickup node scripts/pickup-selection-check.mjs` — 17 actual-SPA states / 19 requests pass on mobile. Destination-independent identity/wait, both pickup occurrences, same-bus later visit, future/missing/stale/departed clearing, focus and physical-ride persistence remain correct. Earlier reused historical parity was not restarted or relabeled as new evidence.
   - `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/extra node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/lifecycle.mjs` — reviewer-authored additional lifecycle checks pass; five recorded states / 151 intercepted requests.
   - `DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/extra-desktop node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/lifecycle.mjs` — same supplemental checks pass on desktop.

   Supplemental cases exercise denied notification permission; dynamic accessible title/description and route/bus identity; automatic age ending while the prompt still owns focus, with prior BODY/Done/Refresh focus; programmatic finish dismissal preserving external focus; a bus-gone ending while the unavailable-position prompt remains open; and missing destination coordinates with Space/Tab keyboard replanning. The bus-gone message retains “You may still be on board.” Child prompt cleanup and parent finish focus cooperate in all tested cases. Both added browser reports have no page errors and closed resources.

3. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/verify-integrity.py`

   **Exit 0**, `integrity.log` / `integrity.json`. Independently verifies exact head/base/parent/merge-base and unchanged tree/checkout/index; all 12 changed files are within v2; source/bundle parity for five runtime modules; builder source hashes; all five browser reports complete. Both teams' image total is **256 files / 12,588,874 bytes**, well below 100 MiB. This review added eight screenshots, visually inspecting the mobile stale prompt, 320px long-destination finish and desktop stale prompt. Existing screenshots/evidence are retained.

No test failure occurred in this review. A preparatory filename search returned no matches; the test script used the actual `serverEta.closure.test.ts` path before execution. The builder's earlier corrected selector failure remains documented in its report and was not overwritten.

## Numerical, runtime and evidence audit

The complete combined options memo is byte-identical to the exact supplied base after removing only the additive pickup metadata projection/clearing. The ride slice preserves the entire already-reviewed pickup memo verbatim. Planner runtime source is exactly the base after removing its type-only import/property. The estimator, server transport, Docker source, journey/deadline arithmetic, live anchor, freshness/cache handling, ride-stop calculations, ride-end collector block, stop-alert engine and notification trigger are unchanged. The new metadata module has only type imports of planner/arrivals; Docker closure tests pass.

The pickup implementation and tests still match the reviewed intermediate commit. SelectedAtMs and snapshot-relative stopsAhead are evidence within one selection, not durable visit IDs or boarding guarantees. No arbitrary cap, discarded trip, route-position rewrite, coefficient, future-data feature or statistical claim was introduced. The current release and follower reports were read: their mixed scores/date-confounded hypotheses remain research, unrelated to this display/focus approval.

## Limits and next work

These are bounded synthetic-wire browser fixtures on the real built SPA, with tester identity helpers, intercepted network, blocked service workers and closed pages/contexts/browsers. No production analytics/feedback, credentials, private data or historical database was accessed. Native screen readers/devices, OS background notifications and native zoom were not tested; 320/640 widths are reflow checks. Off-route/repeated-stop complete ride-browser coverage is not claimed. The unchanged missing-destination duration/clock fallback remains the previously documented separate limitation.

The controller retains full-suite, staging/API smoke, CI, integration, publication and deployment verification. Review processes 51277 and 75294 ended; no owned process/server/browser/heavy lock remains. The existing watcher was untouched.

Next builder: UX09 crash/offline recovery, with actual browser reproduction. Preserve the separate UX08 global alert-strip removal/announcement and wider off-route/repeated-stop ride audit follow-ups. Do not restart the completed pickup/ride experiments or mark all reachable views complete.
