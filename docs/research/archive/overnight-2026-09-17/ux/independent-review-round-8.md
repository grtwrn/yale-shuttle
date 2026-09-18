# Independent review — UX06 trip bus attribution

Controller round 7; eighth UX review artifact. Reviewed September 18, 2026, 02:31–02:37 ET. **Verdict: approve. No blocking findings.**

Exact HEAD: `9d85b47fea1bdfaa7f2d2413b055eb9b83871031`.
Exact base, parent and merge-base: `2dbc060bf517225c219fba8cbc5cb343fb19312b`.

HEAD/parent/merge-base and the full five-file committed diff were independently checked. Working files match committed HEAD blobs and all five frozen builder hashes. The frozen baseline TransitMap matches the exact supplied base. Checkout/index were clean on entry and remain clean. No source fixes, source-control mutations, controller changes or publication were performed.

## Supported behavior

The live trip calculation intentionally distinguishes the approaching pickup bus from the catchable bus used for the journey. The changed expanded details consume the existing destination forecast's identity, label its ride time correctly, and use the already-computed wait point when the buses differ instead of borrowing the approaching bus's window. The short explanation names both buses. Each manual boarding action names and tracks its own vehicle while retaining the planned exit and final destination. The existing single-bus action remains available.

The extracted action component retains a stable pickup button. Its stable callback ref moves focus only when the disappearing journey button owns it; ordinary polls, external focus and fresh recovery are preserved. Unit and actual-browser checks support this behavior. Changing a normalized identity updates both the button label and the vehicle passed to ride tracking. All downstream tracked-bus lookups normalize names and constrain the route as before.

The entire live numerical options memo is byte-identical to the base, SHA256 `105a01ac51b521b5029ef37b850ea47650023a96076adbe881ccab89c59a1e1c`. Planner, journeyArrival, arrivals and etaSource files also match the base. Pickup countdown/map/approach, both ETA occurrences, route-forward position, rankings, catchability, destination arithmetic, transport, historical matching and model coefficients are untouched. No cap, exclusion, calibration/normality/coverage claim or future-data feature is introduced. Frontend-only React additions create no server runtime imports; Docker closure tests pass.

The builder's sorted two-bus fixture proves the distinct-bus presentation mismatch, and the candidate reproduces the expected corrected state. Its initial unsorted fixture is explicitly excluded from production evidence. This review did not restart the completed baseline experiment or reinterpret synthetic outcomes as new historical observations.

## Independently executed checks

Service cwd is `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2` unless specified. All heavy work held the shared lock for its complete duration. Reviewer output directories preserve builder evidence.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06-trip flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06-trip/verify.sh` — **exit 0**, `review-ux06-trip/verify.log`.
   - **131 tests / six files:** tripBusIdentity, journeyArrival, planner, accuracy-closing-bus, RideFinish, standWait.
   - Backend/frontend typechecks pass. Production Vite build passes, 127 modules, 4.76 seconds.
   - Built-SPA mobile and desktop checks pass: distinct #307/#309 identity/wait attribution, both explicit boarding choices, following arrival, pickup/exit/final walk, Back/draft, missing/stale/recovered forecasts, ordinary-poll and disappearing-button focus, external-focus ownership, same-bus recovery, 44px action bounds, Tab/Enter/Space/touch and reflow at 360/390/430/1280/640 CSS pixels.
   - Both reports have zero page errors and `resourcesClosed: true`. I visually inspected both resulting screenshots.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06-trip/extra.sh` — **exit 0**, `extra.log`.
   - Runs `npm test -- src/server/serverEta.test.ts src/server/serverEta.closure.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts`: **54 tests / four files** pass. Covers missing/malformed/empty/stale transport, both occurrences, checkpoint restart/expiry and Docker import closure.
   - Runs reviewer-authored `review-transitions.mjs` against the unmodified production bundle, reusing the builder's synthetic network/setup and adding independent assertions:
     - Distinct-to-same-bus recovery removes the focused extra action and moves focus to persistent pickup; adding it back does not steal focus.
     - Ten actual intercepted feed-request failures extend past the 45-second freshness window. The distinct-bus claim disappears and focus returns to the pickup action. Fresh recovery preserves focus and both arrivals.
     - Rename raw/wire journey bus to `#310` while its button is focused: the visible label/explanation update, focus remains, Space boards normalized `310`, and #309 is no longer offered.
     - Reload an active ride: selected bus, exit and final destination persist exactly. Removing forecast data during tracking does not switch the bus. Done retains walking directions to the exact destination, with current-location origin semantics.
   - `review-transitions.json`: ten failed requests exercised, zero page errors, completed true and resources closed. No extra screenshots were required.
3. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06-trip/verify-integrity.py` — **exit 0**, `integrity.log`/`integrity.json`.
   - Exact HEAD/base/parent/merge-base, five source hashes and committed blobs, frozen baseline, unchanged numerical memo/modules, clean checkout/index, candidate whitespace and browser-script syntax checked.
   - Also explicitly executed reviewer script `node --check`, `git diff --check <base> <head>`, `git diff --exit-code` and `git diff --cached --exit-code`, all exit 0.

**185 selected tests**, both typechecks, production build and all browser checks independently pass. No reviewer application assertion or harness run failed; the builder's disclosed earlier setup/fixture failures remain preserved. Full suite, complete backend staging/API/browser smoke, CI and deployment verification remain controller gates.

## Limits and continuation

Read current v2 CLAUDE guidance, team handoff/first-task/backlog/current progress/checkpoint/requests, previous review and current builder evidence. ETA progress/requests were read through 02:33: its raw-at-stop walking-caution correction is separate, with no overlapping numerical edit here. Current Red release and follower/identity evidence were read as context; no model research is being promoted by this review.

This is a bounded improvement for **distinct known journey bus identities**. Same-bus later pickup occurrences, and the chosen pickup when no destination forecast exists, still cannot be inferred from `journeyArrival.busName`; the builder correctly discloses these existing limitations. Coordinate an explicit chosen-pickup occurrence contract with ETA before expanding scope. Do not infer occurrence from matching numbers or change route ranking to improve labels. This approval does not cover ETA's separate ordered-join candidate or its outstanding caution correction.

Synthetic local fixtures, blocked tiles, seeded tester identity and intercepted requests support reproducible UI behavior. They are not accuracy validation, live overnight service or a fresh holdout. Native assistive technology/physical devices/native browser zoom and the full on-board alert/auto-end matrix are not certified; 640 CSS pixels exercises reflow. Whole-view focus transitions remain separate from dynamic boarding-button focus.

All owned sessions (74873, 99301) completed; every page/context/browser closed and locks released. No server/collector/persistent browser, dependency install, watcher change, production database/private feedback/credential access, other-team edit, GitHub operation or publication. Combined screenshot census: **147 files / 6,492,165 bytes**, below 100 MiB; earlier evidence preserved.

Next: controller handles integration/publication gates. Continue UX07 selected-idle/all-hidden/off-hours versus unavailable-feed recovery, retaining UX08 alerts and same-bus occurrence identity as separate work. No unfinished review experiment remains.
