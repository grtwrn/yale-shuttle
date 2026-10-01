# Independent review — UX-05 minimap attribution

Controller round 5; sixth UX review artifact. Reviewed September 18, 2026, 01:25–01:32 ET. **Verdict: approve. No blocking findings.**

Exact candidate HEAD: `ed6bc1ce06b78d79898599e3dcb6ad021dcab47a`.
Exact base/parent/merge-base: `6220b860a69f5567557926f41de59ed1af72d2f8`.

HEAD, parent and merge-base independently match the supplied values. The tracked checkout and index were clean before and after execution. All four candidate files match their committed HEAD blobs byte-for-byte. The builder's frozen baseline TransitMap also matches the supplied base byte-for-byte. No application fix, source-control operation, controller mutation or publication action was performed.

## Supported behavior

The diff contains only `web/src/TransitMap.tsx`, `web/src/mapLabels.ts`, its tests, and `scripts/minimap-label-check.mjs` under current v2. No existing test is weakened. The helper uses full canonical route names when two displayed routes share an initial; otherwise the short initial remains. Both endpoint chips use it. The canonical options originate from ROUTE_LISTS, so these are known route labels rather than newly interpolated free-form input. Wait labels include the existing bus number, and active/passed bus markers expose current route/bus identity through aria-label and title. Historical typical-total wait remains explicitly distinguished from remaining time in the accessible detail.

No ETA, prediction distribution, current/historical wait arithmetic, stop occurrence, bus matching, route position, planner selection, ranking, route colors, transport, history selection or forecast availability semantics change. Clustering/placeWaitLabel code is unchanged, although the longer measured text naturally affects clustering. There is no arbitrary numerical cap, historical exclusion, new calibrated percentage or accuracy/driver-behavior claim.

Independently executed candidate browser checks cover shared Blue Day/Brown initials at pickup and alight, Orange Night/East with 2–119/8–125-minute windows, current and just-passed buses, stable names/focus through a poll, missing timing, empty options, edge pan, keyboard zoom, fullscreen, and mobile/desktop reflow at 360/390/430/1280/640 CSS pixels. The timing values remain complete. I visually inspected this review's three-route phone, Orange long-window and full-app phone screenshots: names and bus numbers are readable in the existing compact format, and the tested wait labels avoid other chips/buses and stay inside the map.

Reviewer-authored transition checks reuse only the actual-component bundling/network fixture setup and add these assertions:

- Waiting→moving→41:07 nearby wait retains the same focused marker, removes obsolete title/text and preserves the full elapsed time and historical-total explanation.
- Switching the lead bus from #307 to #309 moves the permanent waiting identity to #309 and identifies #307 as passed, without stale markers or stealing external focus.
- Missing bus numbers retain route identity without inventing an identifier.
- Adding/removing Brown beside Blue Day expands/restores both endpoint tags, with old route/bus names removed.
- A mobile tap opens the moving-bus tooltip; ordinary Tab traversal reaches the explicitly named marker. Clearing routes removes tooltip/identity layers.

The unmodified production build also passes the builder's full-SPA fixture and this review's additional full-SPA transitions: real planner/transport selects minimap #307 and the actual arrival dialog retains following #309; fresh recovery restores both after stale data; aborted network requests beyond the 45-second freshness limit remove map timing; polling recovery restores it; empty fleet removes prior markers and wait labels. The existing watcher parser reads the captured real page as one Red shuttle card plus walking, preserving the 2–9-minute window and avoiding map labels as extra cards. Captured text and parser result are saved. No watcher process was invoked or changed.

The original Leaflet stale-removal timing concern was independently checked: obsolete nodes are opacity zero before mocked fade cleanup and absent afterward. This is not a waived stale-data assertion. Every browser run has zero page errors. No candidate test or reviewer browser assertion failed.

## Executed checks

Service cwd: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`, unless stated otherwise.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux05 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/verify.sh` — **exit 0**, `review-ux05/verify.log`.
   - `npm test -- web/src/mapLabels.test.ts web/src/chipCluster.test.ts web/src/routes.test.ts web/src/mapFilter.test.ts`: **65 tests / 4 files passed**.
   - `npm run typecheck`: backend and frontend passed.
   - `(cd web && npx vite build)`: **124 modules / 4.93 seconds**, passed.
   - Actual-component mobile/desktop suites each pass 10 checks / 12 states; full-SPA shell-map passes. The shared lock covers the entire checked script. Separate reviewer OUT preserves builder evidence.
2. `npm test -- src/server/serverEta.test.ts src/server/serverEta.closure.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts` — **exit 0**, **54 tests / 4 files passed**, `transport-tests.log`. These light targeted checks exercise repeated occurrences, malformed/stale/missing wire input, checkpoint restoration/expiry/write failure and browser-free Docker runtime closure. No full suite or fit was run.
3. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux05/transitions flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux05/transitions.mjs` — **exit 0**, `transitions.log` and `transitions/review-browser.json`: six additional state-transition checks, no page errors.
4. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux05/shell-transitions flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux05/shell-transitions.mjs` — **exit 0**, `shell-transitions.log` and `shell-transitions/shell-map.json`: eight checks, including parser/failure/recovery/empty fleet, no page errors, resourcesClosed true.
5. From repo root: `git diff --check 6220b860a69f5567557926f41de59ed1af72d2f8 ed6bc1ce06b78d79898599e3dcb6ad021dcab47a`; `node --check services/shuttle-v2/scripts/minimap-label-check.mjs`; syntax checks for both reviewer scripts — **exit 0**.
6. `git rev-parse HEAD`, `git rev-parse HEAD^`, `git merge-base 6220b860a69f5567557926f41de59ed1af72d2f8 HEAD`, `git diff --exit-code`, `git diff --cached --exit-code`, `git status --porcelain=v1` — **exit 0**, expected exact values and clean checkout/index. Python byte comparisons to committed blobs and the frozen baseline pass; final hashes are in `integrity.json`.

**119 selected tests**, backend/frontend typechecks, build, and all component/full-SPA browser checks pass independently. One read-only inspection command exited 127 because `rg` is unavailable; grep was used for subsequent searches. This was not an application/test failure. No dependencies were installed.

## Scope limits and continuation

Read current v2 CLAUDE guidance, UX handoff/backlog/first task/progress/checkpoint/requests/current review and prior UX-04 review, plus builder evidence and ETA progress/requests through 01:23. The Red release and follower research notes remain context only; no numerical claim is promoted by this review. ETA's independently approved traversal guard is separate and has no overlapping application files or new wire shape. Its remaining countdown/catchable-journey identity distinction merits coordinated follow-up; this patch preserves the existing map bus selection and does not claim to solve that broader question.

All browser data are local fixtures with intercepted network and the tester identity helper. Basemap tiles are blocked. Real historical/live fleet validity, native screen-reader announcements, physical phones and browser-native zoom are not certified. 640 CSS pixels is equivalent reflow. Marker geometry remains the existing 28px map pin; actual single-pin touch and keyboard access are tested, not a claim that all co-located pins can be tapped separately. Endpoint time chips may move out of view with their real geographic anchors; no false-location clamping is introduced. No whole-map accessibility or universal collision-free layout claim.

Fullscreen Back still drops focus to BODY in the builder's frozen baseline and the independently executed candidate. It is unchanged by this diff and remains the documented UX-06 task; Escape from the focused toggle preserves focus. Existing map endpoints and some Leaflet focusables remain unnamed, outside the bus attribution scope.

Full suite, complete backend staging/API/browser smoke, CI, merge and deployment verification remain controller gates. All owned command sessions completed; every launched browser/context/page closed and heavy locks released. No server/collector/persistent watcher, production/private-feedback/DB/credential access, other-team edits, branch/commit/PR operation or controller files were touched. Existing evidence is preserved. Both-team screenshot total: **118 files / 5,080,504 bytes**, below 100MiB.

Controller can advance this exact candidate through publication gates. Next builder: **UX-06 expanded trip actions, pickup/correct-bus/exit/final walk, and fullscreen Back focus restoration**, coordinating the countdown-versus-catchable-journey identity question with ETA. No unfinished review experiment remains.
