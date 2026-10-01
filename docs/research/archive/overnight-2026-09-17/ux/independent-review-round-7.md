# Independent review — UX-06 fullscreen focus

Controller round 6; seventh UX review artifact. Reviewed September 18, 2026, 02:01–02:09 ET. **Verdict: approve. No blocking findings.**

Exact HEAD: `ae4fec5d0115314174795d30f3f91c3f7c85614f`.
Exact base, parent and merge-base: `8de0eed1c6a869606272824fd3dcac753ce32836`.

HEAD, parent and merge-base independently match the supplied values. The complete five-file diff was inspected. All five working files match their committed HEAD blobs and the builder's frozen SHA256 hashes. Both frozen baseline components match the supplied base byte-for-byte. Tracked checkout and index were clean on entry and after all checks. No source fix, branch/index/commit operation, controller mutation or publication was performed.

## Supported improvement

Back disappears when fullscreen closes. The shared hook focuses the persistent map toggle synchronously before that removal, preserving keyboard navigation. Explicit Back/close restore focus; Escape restores it only when the active element belongs to that map, leaves external focus alone, and respects already-consumed events. Its listener is scoped to fullscreen and removed on close/unmount. All three consumers attach the correct wrapper and persistent toggle refs: overview CombinedTripMap, walking TripMap, and pickup-location BerthInset. Existing map instances, resize timers, geometry, berth arm/disarm and disclosure teardown remain intact.

The original berth source-shape assertion follows the extracted hook instead of requiring inline Escape text. This does not waive the behavior: independent actual-browser execution covers the corresponding transitions. No ETA/planner/ranking/route-forward position, bus selection, historical samples, uncertainty wording, release model, transport shape or repeated-occurrence logic changes. No numerical cap, probability claim, future-data feature or historical exclusion is introduced. The new React-only helper is frontend-only; the server's Docker runtime closure remains valid.

## Independently executed verification

Service cwd: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`, unless specified otherwise. All heavy commands hold the shared lock for the entire command; separate reviewer OUT directories preserve builder evidence.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/verify.sh` — **exit 0**, `review-ux06/verify.log`.
   - **51 tests / 5 files passed**: berthMap, berthDisclosure, berths, mapLabels, arrivalDetails.
   - Backend and frontend `npm run typecheck` passed.
   - Vite production build passed: 125 modules, 5.86 seconds.
   - Actual-component mobile and desktop browser checks passed: 21 and 18 closing states, respectively. Back Enter/Space/touch, close Space, Escape from Back/zoom/toggle, consumed Escape, external focus, ordinary Tab after return, 44px close targets, viewport expansion, same Leaflet element, missing/empty props, berth inertness/disclosure and unmount were exercised.
   - Unmodified built-SPA browser passed: overview/pickup-location keyboard and touch close, published pickup directions, retained endpoint/departure draft, pickup #307/following #309, stale timing removal. Phone/desktop/reflow widths 360/390/430/1280/640 pass.
2. `npm test -- src/server/serverEta.test.ts src/server/serverEta.closure.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts` — **exit 0**, **54 tests / 4 files**, `transport-tests.log`. Covers server/browser freshness, missing/malformed data, both occurrences, checkpoint restart/expiry and Docker runtime imports. No transport changes were needed.
3. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06/lifecycle flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06/lifecycle.mjs` — **exit 0**, `lifecycle.log` and `lifecycle/review-lifecycle.json`.
   - Reviewer-authored assertions reuse only the builder's actual-component bundling/fixture setup. Instrumented window keydown registrations return exactly to zero after every close/unmount; each open has exactly one listener.
   - Three genuine keyboard open → Shift+Tab to Back → Enter/Escape cycles per map pass, retaining the same map element and returning toggle focus.
   - Unrelated keys, external focus, repeated Escape when closed, and child-owned Escape preserve the correct owner.
   - Fresh → missing → empty props while fullscreen retain Back focus and a single listener; close still returns focus.
   - Folding the berth disclosure while fullscreen removes its listener and retains disclosure focus. Whole-component unmount cleans all maps/listeners; remount begins closed, berth folded, and works again.
4. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06/shell-recovery.mjs` — **exit 0**, `shell-recovery.log` / `shell-recovery.json`.
   - Reviewer-authored full-SPA transitions use the built production bundle. Ten intercepted feed requests fail across >45 seconds; expired timing disappears while fullscreen Back retains focus, then Escape returns to the toggle.
   - Fresh feed recovery restores pickup #307 and following #309 and preserves Back behavior.
   - Reload retains endpoint/departure drafts, starts with fullscreen off and supports keyboard reopening/closing.
5. Repo-root `git diff --check 8de0eed1c6a869606272824fd3dcac753ce32836 ae4fec5d0115314174795d30f3f91c3f7c85614f`; `node --check services/shuttle-v2/scripts/fullscreen-map-check.mjs`; syntax checks for both reviewer scripts; `git diff --exit-code`; `git diff --cached --exit-code`; `git status --porcelain=v1` — **exit 0**. Exact HEAD/parent/merge-base and Python byte/hash checks passed; `integrity.json` records values.

**105 selected tests**, both typechecks, frontend build and all browser checks independently pass. Every browser report has no page errors and confirms resource closure. No application or reviewer test failed. One read-only `rg` inspection exited 127; grep fallback was used. No dependency install was needed. Builder setup/source-assertion failures remain preserved in its report; none were hidden or rerun as claimed fresh discoveries.

## Evidence boundaries and continuation

Read current v2 CLAUDE guidance, UX handoff/backlog/first task/current progress/checkpoint/requests, previous independent review and builder artifacts, plus ETA progress/requests through its 01:59 independently checked ordered-join research. Red current-release and follower/identity notes were read as context; this UI review makes no numerical-model or calibrated-coverage claim.

Browser fixtures intercept all network and seed the tester identity. Tiles are deliberately absent; component props and the full-SPA two-bus wire are synthetic. I visually inspected reviewer-generated fullscreen and actual trip/pickup screenshots. This verifies local browser behavior, not physical phones, native assistive technology, native 200% browser zoom or street-tile availability. 640 CSS pixels is equivalent reflow. Fullscreen focus trapping/modal semantics and automatic focus transfer when an entire map is asynchronously removed remain outside this change, as the builder disclosed. There is no claim that all UX-06 trip-action/final-walk work is complete.

All owned sessions completed; every page/context/browser closed and locks released. No server/collector/persistent watcher was started or changed; no production/private feedback/database/credential access, other-team edit, GitHub operation or publication. Existing evidence is preserved. Screenshot census at final integrity check: **139 files / 5,714,220 bytes across both teams**, below 100 MiB.

Controller retains full-suite, complete backend staging/API/browser smoke, CI, exact-head/base integration, merge and deployment verification. No unfinished review experiment remains.

Next builder: continue UX-06 trip-action/correct-bus/final-walk coverage. Coordinate ETA's independently reviewed ordered-existing-pickup join as a separate numerical proposal with actual dwell-gate/nonzero-walk/class-deadline transition tests. Preserve raw pickup countdown, both occurrences, the 38 deferred next-lap cases and the intentional countdown-versus-catchable-bus distinction. This approval does not implement or promote that research.
