# Keep minimap times attributable to their route and shuttle

Builder round5,2026-09-18. Base/HEAD6220b860a69f5567557926f41de59ed1af72d2f8, branchovernight/ux-20260917-005. Controller owns commits, review routing, CI/staging, PR/merge/deploy. No builder publication or HEAD/index changes.

## Problem and supported change

The actual CombinedTripMap browser fixture reproduced Blue Day and Brown sharing(B) at both endpoints, leaving color as the only distinction. Its co-located current Red#307 and just-passed#309 markers had no route/bus accessible names; the permanent wait label displayed `Red 3:21/~5m` without the bus number. Marker focus could show the existing tooltip, but the closed marker's identity was only the bus emoji.

The candidate uses the full displayed route name only when another displayed route shares its initial. Distinct initials retain compact tags such as(R). Both pickup and alight tags use the same helper. Wait labels keep exactly the same elapsed/typical-total values and compact format, adding the existing bus number. Current and passed markers receive explicit route/bus names; waiting markers also retain the existing observed-elapsed/historical-total explanation. Names update in place on each poll.

`TransitMap.tsx`, `mapLabels.ts` and `mapLabels.test.ts` are the only application/helper changes. `scripts/minimap-label-check.mjs` is the new bounded browser regression. Layout/clustering, marker coordinates, route selection/order, wire, forecasts, both occurrences, historical sampling and wait calculations are unchanged. No on-time/calibration/normality/driver-behavior claim, cap or exclusion is introduced. No external information or production data was needed.

## Baseline and verification

The baseline actual-component harness bundles the frozen base TransitMap with only a test export and map reference. Props are synthetic and all network/tiles are intercepted; imported runtime helpers are real. Snapshot SHA256:765df568de65e18d54ce7dbff9a014c9b0e090bf8f5f7a306e932140bdaf6424. `before-browser.json`, `baseline.log` and screenshots preserve the original reproduction. No baseline application test failed; these are explicit before-state measurements.

Executed from v2 unless noted:

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/minimap-check.mjs --baseline` — exit0. This first invocation used the original artifact harness's default evidence directory; later replay uses explicit OUT/BASELINE_SOURCE in the repository script. Baseline co-location/width/edge/missing/empty captures and zero page errors.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/verify.sh` — exit0; `first-verify.log`.
   - `npm test -- web/src/mapLabels.test.ts web/src/chipCluster.test.ts web/src/routes.test.ts web/src/mapFilter.test.ts`:65 tests in4files passed.
   - `npm run typecheck`: backend and frontend passed.
   - `(cd web && npx vite build)`:124modules,4.92seconds, passed.
   - Separate mobile and desktop actual-component runs: correct current/passed identity, Blue/Brown endpoint labels, compact wait,360/390/430/1280/640px, edge pan, missing timing/empty options, keyboard passed-bus tooltip, wait-label bounds and no label/bus overlap, no page errors. `after-browser.json` and `desktop/after-browser.json`.
3. `node --check services/shuttle-v2/scripts/minimap-label-check.mjs` from repo root and `node --check .../ux-05/shell-map.mjs` — exit0. Expanded repository browser harness and full-SPA results are recorded below.

Candidate360px screenshot visually inspected: full route names fit the grouped chip, wait labels remain a single line with# identity. Baseline and candidate use the same positions/values. The first baseline experiment was queued behind ETA work; its map-ref hook was corrected before execution (replaceAll covers the actual component). An early read of its JSON failed because it had not yet run; that was inspection of a pending artifact, not an app/browser failure. No dependency installation.

## Limits and next work

The fixture's same-route pair is the actual map contract: current/catchable bus plus a just-passed bus. CombinedTripMap does not draw a separate permanent waiting label for every upcoming arrival. The full app retains the following-arrival slot in cards/details; this patch does not change or validate ETA numerical accuracy. Missing timing props are presentation fixtures and the full-SPA check additionally confirms that stale server input removes map timing.

Long pickup ranges are stress inputs; alight range strings in the component fixture are deliberately wider than today's single-clock caller. These tests do not claim such synthetic forecasts were observed in service. Basemap tiles are blocked; this is a label/interaction check, not new geography evidence. Panning an endpoint out of view can also move its pinned time chip out of view; no repositioning or false-location clamping was added. Existing timing chips can approach attribution/legend at dense endpoints; this patch does not claim every map annotation is collision-free.

Native assistive technology, physical phones and browser-native200%zoom are not tested.640CSSpx is desktop reflow. Fullscreen Back drops focus to BODY in both baseline and candidate. It is a reproduced pre-existing UX06 follow-up, not fixed here; Escape while the toggle is focused preserves it. No focus-trap/whole-map keyboard completeness claim. Shared route colors remain sourced from routes.ts in the final browser harness. No need to change MinimapReview.tsx: that is a static style-preview surface, not the production combined Leaflet map.

After independent review, controller retains full-suite/complete staging/publication gates. Next builder UX06: expanded-trip pickup/correct-bus/get-off/final-walk flow, including long stop names and fullscreen Back focus if reproduced. UX07/09 missing-feed copy and UX10 editor/saved-place follow-ups remain open. ETA's occurrence-pooling work is separate; no shared numerical change is requested.

## Final results — 2026-09-18 01:05 ET

**Candidate ready for independent review.** All required checks for this scoped proposal completed. There is no pending builder process or experiment.

4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/browser-supplement.sh` — **exit 0**, `supplement.log`. Uses the final repository browser harness for candidate mobile, candidate desktop and the frozen baseline. Each completed 10 checks / 12 captured states, no page errors. Results in `supplemental/after-browser.json`, `supplemental-desktop/after-browser.json`, `baseline-expanded/before-browser.json`. Checks stable marker/focus and updated accessible wait through a poll; 44px fullscreen by Enter/tap/click, Escape, Back; keyboard zoom/reclustering; Blue/Brown attribution; missing times/empty options; Orange Night/East with untrimmed 2–119/8–125 minute stress windows; page reflow and wait-label bounds/separation including the long-name case. Baseline explicitly reproduces the attribution failures. Both arms record Back focus on BODY. Candidate Orange screenshot visually inspected.
5. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/shell-map.mjs` — final **exit 0**, `shell-final.log` / `shell-map.json`. Unmodified production build, real planner/transport on checked-in network with fabricated live rows: minimap selects Red #307; keyboard exposes identity; actual arrival dialog retains following #309; touch fullscreen/Escape retain toggle focus; reflow at 360/390/430/1280/640 CSSpx; fresh pickup chip exists and subsequent stale wire removes timing. No page errors; resourcesClosed true.
   - The first run exited 1 because it asserted DOM removal before Leaflet's mocked 200ms fade-removal timer completed. `shell-first.log` and `shell-first.json` preserve the failure. Final diagnostic explicitly records both obsolete timing nodes at **opacity 0** before advancing the mock clock; they are removed afterwards. No app change, value change or stale-data assertion was waived. `shell-map-390.png` is the full-app candidate screenshot.
6. Repo-root `git diff --check`, `git diff --cached --exit-code`, `git rev-parse HEAD`, `git branch --show-current`, `node --check services/shuttle-v2/scripts/minimap-label-check.mjs` — exit 0. HEAD and controller branch unchanged; index empty. Only the four scoped files differ. Full suite, complete backend staging/CI and deployment remain controller gates, not claimed run.

For a reviewer, `OUT=<fresh directory> flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/verify.sh` now runs the repository harness (including expanded checks) and full-SPA script after tests/types/build. The earlier artifact `minimap-check.mjs` is construction history; do not treat it as the final harness. Use a fresh OUT to preserve builder evidence. Baseline replay additionally needs BASELINE_SOURCE pointing at TransitMap.baseline.tsx and --baseline.

All owned sessions collected; all pages/contexts/browsers closed, locks released. No server, collector or second watcher was launched and the existing watcher was untouched. No dependency installation, credentials/private feedback/DB access, other-team mutation, source-control action or deployment. The independent reviewer should focus on compactness under shared initials, in-place bus naming/focus, and stale/empty removal, preserving the explicit scope limits above.
