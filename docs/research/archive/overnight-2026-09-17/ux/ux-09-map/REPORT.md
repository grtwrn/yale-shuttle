# Prevent map errors when zooming and leaving a view

Builder candidate, September 18, 2026, 05:24–05:38 ET. Independent review is required. Preserved HEAD `da51fcb0af70f554ef0b141aa07d4a390f3c7de0` and index on `overnight/ux-20260917-011`. The already approved crash-recovery work at HEAD remains intact; controller owns its release and this follow-up's capture/integration.

## Problem and evidence

A rider can zoom the Map page then switch to Trip or change route filters, leaving a delayed Leaflet CSS-zoom completion callback trying to access a removed map pane. The preceding round proved two `_leaflet_pos` exceptions after one iteration on both the production baseline and recovery candidate. Its completed paired experiment was retained, without a new baseline build or repeat: `../ux-09/{NEXT_MAP.md,map-diagnostic.json,map-stress-current/map-stress.json,map-stress-baseline/map-stress.json}`. Source hashes show the same map code as this role's entry.

This round additionally reproduced the error in the real on-board ride view: zoom then immediately tap Done produces one identical exception on the entry build (`baseline-ride-second/map-lifecycle.json`, one cycle). The finish section still renders, so this is an asynchronous map error rather than a React crash-boundary transition. Normal browser time, a synthetic two-bus feed on the checked-in network, and the actual built SPA were used throughout.

Installed Leaflet source supports the diagnosis: `_animateZoom` schedules a 250ms `_onZoomTransitionEnd` callback; `remove()` deletes `_mapPane`; `stop()` stops pan/fly animation but does not clear that CSS-zoom completion. TripMap, CombinedTripMap and BerthInset already disable `zoomAnimation` for this lifecycle issue.

## Change

`web/src/TransitMap.tsx`: set `zoomAnimation: false` on AllRoutesMap and RideRouteMap, with short explanations. Zoom becomes immediate on these views, matching existing trip maps. The options for wheel, keyboard and touch zoom remain enabled. Pan cleanup remains unchanged. No dependency modification, private Leaflet state access or global error suppression.

`scripts/map-lifecycle-check.mjs`: reproducible actual-SPA regression on system and ride maps. It checks keyboard zoom/pan, phone reflow, touch pinch or desktop wheel zoom, six repeated rapid teardown cycles per map, container counts, filter recovery focus, Done focus and the final walking destination. Every page/context/browser closes in `finally`; all network is intercepted and `seedTestId` excludes synthetic activity from analytics. The script is a browser regression, not a unit assertion that merely mirrors the option.

NearbyStopsPicker still has animation enabled, but source search finds only its declaration and no caller in current navigation. It was not changed or represented as a verified live-view defect. Existing trip/combined/berth settings remain intact. A shared teardown helper is unnecessary for the two-option correction.

## Executed verification

Service cwd for Node commands: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`. Every test/build/browser command below held the shared lock. The original stress fixture starts port8093 inside the lock and closes it before the lock releases. All artifacts below are relative to this report.

1. `SCENARIOS=ride OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/baseline-ride-second flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/map-lifecycle-check.mjs`

   **Exit 1, expected defect reproduction** (`baseline-ride-second.log`). Settled zoom/pan and Done/final-destination checks run; one delayed `_leaflet_pos` exception after the first rapid zoom/Done cycle fails the error assertion. Resources closed. Earlier `baseline-ride.log` is a setup failure: wrong script-write relative path left the file absent; no browser ran. An attempted recovery from the already-ended shell's `/proc` path also failed. The script was then written correctly before this successful reproduction. The earlier progress note's premature recovery claim is corrected in its next entry.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/verify.sh`

   **77 tests in seven files passed**, backend/frontend typechecks passed, Vite production build passed (129 modules). Files: mapFilter, rideMapFocus, rideEnd, rideArrival, rideAlert, mapLabels and etaSource. Wrapper **exited 1** on a new browser-fixture expectation that Show all routes restores Hide all focus. Existing behavior correctly restores Running now/Every route. Corrected the assertion only; preserved `verify.log` and `verified/mobile/map-lifecycle.json`. No runtime-source change followed the successful typecheck/build.

3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/browser.sh`

   **Exit 0**, `browser-second.log`: mobile and desktop each pass six system-map and six ride-map cycles with real timers. The unchanged original stress script now passes all three iterations with zero exceptions. Existing empty-service browser passes pending, empty, failed, malformed, stale, hidden/selected-idle and recovered states, including both upcoming bus slots. Existing fullscreen browser passes trip overview, walking and pickup-location keyboard/touch/Back/Escape and focus behavior. All five reports in `browser-second/` complete with zero page errors and closed resources.

4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/gestures.sh`

   **Exit 0**, `gestures.log`: final script additionally exercises browser touch-pinch input through CDP on mobile, mouse-wheel zoom on desktop and reflow at 320/360/390/430 and 640/1280px. Both gesture paths change projected route geometry. All 24 lifecycle cycles pass again with zero page errors; focus and final destination preserved. This is emulated mobile behavior, not a physical-device claim. Phone screenshots were visually inspected; map tiles are intentionally intercepted, so screenshots assess controls, overlays, layout and route/bus identity rather than basemap availability.

5. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/verify-integrity.py` — **exit 0**, `integrity.json`/`integrity.log`: exact HEAD/index preserved; only TransitMap tracked content changed, plus the new regression script; undoing the two options/comments exactly recovers entry source. Current sourcemap equals final source. Old system-map baseline provenance and all seven passing browser reports checked. Combined team screenshot census: **321 images / 15,179,028 bytes**, below 100MiB. Existing evidence retained.

6. `node --check services/shuttle-v2/scripts/map-lifecycle-check.mjs` and `git diff --check` from repo root — **exit 0**.

`verify.sh` is the single checked reproduction wrapper for a reviewer; supply a fresh `OUT` when rerunning. Integrity pins this role's pre-capture HEAD/index, so a reviewer should adapt capture assumptions, not modify application code to satisfy obsolete hashes. `proposal.patch` holds the runtime diff; the new regression script is separately untracked for controller capture.

## Scope, handoff and remaining work

All estimator, planner, live-arrival, route geometry, route-forward tracking, repeated-stop selection, ride notification/end logic, filtering rules, focus logic, server transport, recorded data and recovery behavior are byte-identical to entry. No numerical or live-service improvement is claimed. This addresses the two demonstrated reachable map lifecycles; physical iOS/Android, external assistive technology and OS/background behavior remain unverified. Full suite, complete staging smoke, CI and deployment checks remain controller work.

Sessions 98156, 60843, 90634, 73072 and 61987 finished. No owned server/browser/heavy lock remains. The existing watcher was untouched. No dependencies, Git mutations, production data, feedback, credentials, controller files or other-team files were changed.

Next: independent review of this two-file follow-up on the preserved recovery head, then controller release gates. Afterward resume UX10 saved places/recents/location/weather with real keyboard/mobile fixtures, retaining all existing evidence. No need to repeat completed recovery/offline or ETA experiments. Latest ETA05:32 research review requests no UX shared-interface change.
