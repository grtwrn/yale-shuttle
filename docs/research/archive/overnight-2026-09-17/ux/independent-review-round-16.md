# Independent review 16 — crash recovery and safe map teardown

Reviewed September 18, 2026, 06:17–06:26 ET, controller round 11. **Verdict: approve. No blocking findings.**

Exact HEAD: `a5966b1e87a9f4fbecf3888456fbd272f186fcb8`.
Exact supplied base and independently checked merge-base: `98e535b99649e74ca599d2e33bcfdc46df83d30d` (PR292).

I inspected the full seven-file candidate against the supplied base, checked the correction against prior review15 and intermediate `e7e9063df1fb15a364529075a702789e2bf348c7`, and independently ran the relevant tests. Prior crash-recovery files remain byte-identical to approved `da51fcb0af70f554ef0b141aa07d4a390f3c7de0`. The checkout and index remained clean and unchanged. Evidence is in `review-ux09-pinch/`.

## Prior blocking finding resolved

The previous review's two unchanged built-SPA reproductions now pass: a held pinch spanning manual Done, and a held pinch spanning natural two-hour ride expiry on the next real poll. Release and a subsequent ordinary touch produce no page errors. The original rapid button-zoom/removal reproduction also passes, so the correction preserves the useful immediate-zoom fix.

Installed Leaflet1.9.4 confirms the mechanism: TouchZoom.removeHooks removes touchstart, but an active gesture retains document move/end/cancel listeners and a queued animation frame. A no-movement gesture can also leave these listeners behind. The new helper disables that map's touch handler, marks its gesture inactive, cancels its frame and removes handlers using the matching function and context. Both AllRoutesMap and RideRouteMap call it before stop/remove. The adapter's use of private Leaflet fields is deliberate and confined to one small file; the real-browser regression should remain a dependency-upgrade gate. No errors are suppressed and mounted maps retain touch zoom.

Eight candidate gesture cases independently pass: manual ride end, natural expiry, route filtering, navigation, unmoved ride/system gestures, a queued final move in the same DOM task as Done, and touchcancel. For every case, actual document listener counts go from zero to one to zero **before** finger release. Replacement maps work, final walking destinations remain correct, and no asynchronous error appears.

A separate reviewer-authored integration fixture bundles the actual helper with installed Leaflet and creates two maps. After an unmoved gesture leaves map A's callbacks, map B starts pinching. Removing A reduces each document listener count from two to one; B continues and completes native browser pinch, then accepts a normal zoom-button tap. Idle and touch-disabled map cleanup also passes. This verifies context isolation without editing candidate code or Leaflet internals. It is an adapter fixture, not a claim that riders normally pinch two maps at once.

## Rider behavior and scope

The recovery page leads with Reload, preserves keyboard focus, and puts reset consequences and technical details in separate native disclosures. Explicit reset retains the existing localStorage.clear/sessionStorage behavior; submitted reports remain on the server while their browser identity is lost. Ordinary reload retains saved data and the current tab's trip. Actual-app fault injection confirms both endpoints survive recovery/reset, and intentional header Refresh still clears the planned trip. Blocked storage access/clear remains recoverable.

Mobile and desktop tests exercise keyboard, touch, settled pinch/wheel/pan, 24 rapid map lifecycle cycles, focus, 44px recovery controls and reflow at 320/360/390/430/640/1280px. The actual-app recovery fixture also checks 200% CSS zoom. Independently viewed fresh mobile system/ride and initial/expanded crash screenshots: route/bus identity and Done remain clear; reset's consequences appear before its button; long technical text wraps. The maps were intentionally panned/zoomed and tiles intercepted, so these images do not establish basemap availability or original framing.

Full diff scope is three scripts plus main, CrashRecovery, TransitMap and mapLifecycle. Removing the helper import/two calls, two zoom options and explanatory comments restores **exact supplied-base TransitMap**. Thus ETA arithmetic, both occurrences, selected bus/visit identity, route-forward tracking, class advice, ride-end rules, filters, positions, historical samples, wire data and notification behavior are unchanged. No new statistical, probability, normality, calibration or accuracy claim is made. Current-release/follower research and the other team's current progress/requests were read; no shared-interface change is needed.

## Independently executed checks

All Node commands use cwd `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`. The shared heavy lock covered complete test/build/browser commands, including the local port8093 server's entire start/test/cleanup. No dependencies were installed. Fresh outputs preserve all builder and previous reviewer evidence.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch/verified flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-pinch/verify.sh`

   **Exit0**, `verify.log`. 77 tests/seven files, backend/frontend typechecks, Vite production build (130 modules), and eight browser reports pass. Reports cover the eight held-touch cases, both unchanged reviewer reproductions, mobile/desktop lifecycle interactions, original button-zoom reproduction, feed states and fullscreen focus. Feed fixtures include pending, empty, failed, malformed, stale and recovered data plus both #307/#309 arrival slots. Fullscreen checks retain trip/walk/pickup Back/Escape focus. Every report has no page errors and closed resources.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch/additional.sh`

   **Exit0**, `additional.log`. 90 tests/nine files cover draft, pull-to-refresh, anonymous identity, recents, live updates, server checkpoint recovery, wire parity, Docker runtime dependency closure and class-deadline states. Combined distinct tests: **167 across16files**. Four additional browser reports pass: mobile/desktop real-boundary recovery, actual-app trip/reset/header-refresh lifecycle, and the real service worker with an actual local server. Offline estimates become unavailable; a cached shell reload opens without cached live bus data; no API response enters Cache Storage; restored networking recovers automatically. The actual-app lifecycle fault build is artifact-only and does not change application sources.

3. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch/isolation flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch/isolation.mjs`

   **Exit1**, `isolation.log`. Reviewer-fixture failure after the substantive listener-isolation/pinch checks passed: the final assertion expected Leaflet to remove the host div's CSS class. Leaflet correctly removes its map panes but leaves host classes. Initial script preserved as `isolation-initial.mjs`; failed report and bundle preserved in `isolation/`, with zero page errors and all resources closed. This is not a candidate defect or a passing test claim.

4. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch/isolation-corrected flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch/isolation.mjs`

   **Exit0**, `isolation-corrected.log`. The only fixture correction checks removed map panes instead of persistent host classes. All isolation/pinch/later-touch/touch-disabled checks pass. No application change. Together with the above gates there are **13 final successful browser reports**.

5. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch/verify-integrity.py`

   **Exit0**, `integrity.log/json`. Verifies exact head/base/merge-base; unchanged index tree, clean checkout and all910tracked hashes; all197builder evidence files preserved; exact source scope and recovery preservation; candidate source-map parity; frozen entry and supplied-base bundle provenance; every passing browser report and eight gesture cases. Shared screenshot census391images/17,950,262bytes, below100MiB. Completed baseline experiments were not rerun.

6. `git diff --check 98e535b99649e74ca599d2e33bcfdc46df83d30d..HEAD` and `node --check` on each of the three new committed browser scripts — **each exit0**. One read-only log-summary command could not find `rg` (exit127); the fallback `grep` succeeded. This did not affect a gate.

## Handoff and limits

Controller can proceed with normal remaining full-suite/staging/CI/publication/deployment verification for the exact reviewed head. Next builder task is UX10 saved-place keyboard selection/rename/delete and focus, using `ux-09-pinch/NEXT_UX10.md`; those leads are not browser-verified findings. Potential pre-existing held-pinch behavior on other trip/berth maps is outside this two-map correction and has not been claimed fixed.

No physical iOS/Android, Safari, native assistive technology, OS/background behavior or service-worker deployment-version race is certified. Synthetic fixtures establish state transitions, not production incidence. No new estimator fitting or forecast evaluation was necessary for this UI-only diff.

Owned sessions57387,47615,4539,42829,65612 ended; every browser/context/page and local server closed; no heavy lock remains. Existing watcher untouched. No tracked files, branches, commits, index entries, controller files, other-team artifacts, private data, DB records, GitHub or deployment state changed. No pending experiment.
