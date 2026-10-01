# Independent review 11 — UX08 stop-alert setup

Reviewed September 18, 2026, 03:52–03:59 ET (controller round 9). **Verdict: approve. No blocking findings.**

Exact HEAD: `48651d63165bc4cddd7160a73fa6933583ecb856`.
Exact supplied base, parent and merge-base: `7e29064475315c2d621b77cdca130c05737d1ab8`.

The entire candidate diff was inspected against that exact base. It contains only `services/shuttle-v2/web/src/TransitMap.tsx` and new `services/shuttle-v2/scripts/stop-alert-controls-check.mjs`. HEAD, index and tracked checkout were clean on entry and remain unchanged. This reviewer made no application fix, Git mutation or publication action.

## Supported improvement

Explicit Cancel, lead-time selection and Escape return focus synchronously to the same stop's currently rendered bell. Escape works from the opening bell and inside the chooser. No deferred focus callback can run after leaving Map or after a notification permission response. Existing bell elements persist through arm/disarm, including automatic arrival disarm. The new group name identifies route and stop; description references the existing permission explanation; expanded, controls and pressed states agree with rendered setup and stored arms. Cancel has a specific accessible name. Opening a second stop replaces the first disclosure and restores to the correct new bell.

The route display de-duplicates its stop rows before this code runs, and IDs include list view, route-list index and stop ID. Both source inspection and browser assertions support unique IDs; this does not change the canonical repeated-stop forecast sequence. The group is a disclosure, not a modal, and normal Tab/navigation can leave it. Touch targets and reflow pass at 360/390/430 phone widths and 1280/640 desktop widths. Both independently generated chooser screenshots were visually inspected; route/stop attribution and concise lead choices remain readable.

The builder's frozen baseline source equals the supplied production base. Its recorded baseline failures and exact final source hashes were checked without restarting the completed baseline experiment. The independently built candidate sourcemap matches committed HEAD. Earlier builder selector/bundle setup failures are explicitly retained and are not counted as passing runs.

## Independently executed validation

All heavy commands held `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`. Outputs are fresh under `review-ux08/`; all 44 pre-existing UX08 experiment files remain byte-identical.

1. From the worktree root:

   `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08/browser flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08/verify.sh`

   **Exit 0**, `review-ux08/verify.log`: 126 tests across five files; backend/frontend typechecks; Vite build, 127 modules in 4.77 seconds; built-SPA mobile and desktop checks. Both browser suites pass denied, unsupported, default→denied and granted permission fixtures. Enter/Space/Tab/Escape, arm/cancel/disarm/switch-stop focus, polling/external/navigation focus ownership, group linkage, 44px choices, reflow, tab persistence and recovered delivery pass. Browser errors are empty and all resources closed.

2. From `services/shuttle-v2`:

   `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08/lifecycle.mjs`

   **Exit 0**, `lifecycle.log/json`: reviewer-authored transitions, five check groups and 13 feed requests. Verifies actual default-permission explanation, focus restored before the request begins, delayed default→granted response after navigation preserving Issues focus, arm/lead persistence through actual reload without a permission request, transient chooser removal, automatic arrival disarm focus, storage-write failure and unique IDs.

   The committed harness's original unavailable-feed checks use a 600-second forecast above the selected 3-minute threshold. To avoid relying on that alone as fail-closed evidence, this supplement puts the first occurrence at **120 seconds before making it stale**. Eligible stale/missing/failed/empty-fleet inputs emit nothing; fresh recovery emits one lead alert for #307, persists that identity, and an ordinary next poll does not duplicate it. The same bus's later occurrence remains far away, and the second bus remains present. Arrival at 20 seconds sends the final ping and clears the arm while retaining focus on its bell. No page errors; every resource closed.

3. From `services/shuttle-v2`:

   `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock npm test -- src/server/serverEta.closure.test.ts src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.release.test.ts web/src/etaSource.test.ts web/src/atStopJourney.test.ts web/src/arriveBy.test.ts web/src/arriveByMessage.test.ts web/src/ArriveBy.render.test.tsx`

   **Exit 0**, `integration.log`: 86 tests across nine files, 12.19 seconds. Covers Docker runtime dependency closure, server/browser row parity, fresh checkpoint restart, wire freshness/expiry/cache, both target occurrences in recorded Red release transitions, raw-at-stop walking caution, and unavailable/buffer/lateness class-deadline distinctions. Together with item 1, **212 distinct tests across 14 files** passed. Full-suite execution is not claimed for this review.

4. From the worktree root:

   `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08/verify-integrity.py`

   **Exit 0**, `integrity.json`: exact identities and two-file diff; clean checkout/index; committed sources equal builder-tested hashes; candidate/baseline bundle-source equality; unchanged planner/map/trip prefix, card estimator, ride/main/alert engine suffix and eleven numerical/transport/filter/runtime files including Dockerfile; script syntax and diff whitespace; 44 preserved builder evidence files. Screenshot census at capture: 215 images / 9,445,149 bytes across both teams, below 100 MiB. This review added only two small screenshots.

No test failed during this review. Read-only exploratory searches encountered one nonexistent `notify.ts` path and one shell where `rg` was unavailable; file discovery and direct reads resolved both without source/configuration changes.

## Scope, limits and continuation

No ETA arithmetic, row/visit selection, interval, ranking, route position, alert threshold/expiry, permission request/delivery implementation, historical sample, statistical coefficient or accuracy claim changes. The production comparator includes PR289 walking caution and PR290 UX07 corrections; their code is preserved. Current-release/follower context remains separate: score-dependent exploratory neighbor evidence is not promoted by this approval.

Requests were intercepted on synthetic hosts with `seedTestId`; no production/private feedback/credential/historical database access occurred. Chromium used mocked notification permission/delivery and blocked service workers. This is not native-screen-reader, physical-device, OS permission-sheet, actual background-delivery or native 200% zoom certification. 640 CSSpx is reflow evidence. Backend staging/API smoke, full CI, integration and deployment remain controller gates.

Broader on-board stale/missing-bus/get-off/finish focus, global alert-strip/banner removal focus and unrelated rapid-map stress remain separate follow-ups. Do not imply that all UX08 views are now audited. The prior UX07 review's corrections remain in the base; this is a new alert slice, not a reapproval of their old candidate.

Read current v2 CLAUDE guidance, own handoff/backlog/first task/current progress/checkpoint/requests and previous review10, ETA progress/requests through 03:49 and the 03:51 integration coordination addendum. Next, the controller may advance this exact head through publication gates. The next builder should consume `eta/cycle-11/eta-projection.patch` with the UX identity/wait/action consumer as one coordinated proposal **after** independent prototype review, preserving missing-destination unknownness, actual selected bus/visit, both arrivals, caution and single-vehicle manual actions. If that review is pending, continue on-board recovery verification.

Sessions 31586, 48901 and 6408 completed. All owned pages/contexts/browsers closed; no server, collector or lock held. Existing simulated-rider watcher untouched. No other-team/controller/protected files, source, branch, index or publication state changed.
