# Independent review 15 — combined crash recovery and map lifecycle

Reviewed September 18, 2026, 05:39–05:58 ET. **Verdict: changes_requested. One P2 blocking finding.**

Exact HEAD: `e7e9063df1fb15a364529075a702789e2bf348c7`.
Exact supplied base and merge-base: `98e535b99649e74ca599d2e33bcfdc46df83d30d`.

The complete five-file candidate was inspected and independently tested. The normal zoom-button teardown improvement is supported, and the prior crash-recovery changes remain sound. However, a new mobile gesture teardown exception needs correction before approving this combined head. No candidate file was changed during review.

## Blocking finding — finish active touch zoom before removing the map

**P2, `services/shuttle-v2/web/src/TransitMap.tsx:6288`**, with the existing RideRouteMap cleanup around6380. Setting `zoomAnimation:false` changes Leaflet's active-pinch completion path to `_resetView`. Leaflet's TouchZoom `removeHooks` removes the container's touchstart handler but does not finish an ongoing gesture or remove its document touchmove/touchend listeners. Those listeners normally clean themselves up at `_onTouchEnd`.

Reproduction against the real built SPA, normal browser time and intercepted synthetic bus feed:

1. Start a tracked ride. For the automatic case, its valid saved start is four seconds short of the existing two-hour expiry.
2. Begin a two-finger pinch and move from25px to50px half-separation; hold both fingers down.
3. Allow the real next bus poll to trigger natural ride-age expiry and remove the map. The manual comparison invokes the existing Done button while the gesture remains held.
4. Release the fingers, then tap Dismiss on the finish view.

On the candidate, both manual and automatic cases throw **`Cannot set properties of undefined (setting '_leaflet_pos')`** from `_onTouchEnd → _resetView → DomUtil.setPosition` on the subsequent normal touch. Both cases pass with zero page errors against the already-frozen exact supplied-base bundle. The automatic case does not invoke Done programmatically and needs no fake clock, private Leaflet access, changed app source or forced unmount.

Evidence: `review-ux09-map/{pinch-current,pinch-auto-current}/interrupt-pinch.json` (one exception each); paired `pinch-baseline` and `pinch-auto-baseline` reports (zero exceptions); four complete logs and `pinch.log`. Every browser/context/page closed. The finish section still appears; this is an asynchronous exception, **not evidence of a blank page or React fallback crash**.

The old animated touch-completion path checks for a missing map pane and returns. The new immediate path writes to the deleted pane. This is distinct from the old delayed button-zoom failure that this candidate fixes. Source and rebuilt-bundle parity, plus direct baseline-source comparison, establish the comparison's provenance.

**Required correction:** safely finish or cancel an active touch gesture and its queued/document callbacks before removing the map, while preserving pinch/wheel/keyboard zoom and the button-zoom teardown fix. Extend the browser regression so a gesture spans removal and a later ordinary touch. The current script releases pinch and waits350ms before lifecycle teardown, so it cannot detect this case. Audit the analogous AllRoutesMap cleanup, but only the ride path is independently reproduced here. Do not silence page errors or disable touch zoom to make the test pass. Keep prior recovery behavior intact.

## Supported behavior and source audit

Full diff: main, CrashRecovery, TransitMap and the two browser scripts. Prior recovery files are byte-identical to approved intermediate `da51fcb0af70f554ef0b141aa07d4a390f3c7de0`. Recovery still leads with Reload, describes reset's local-data/report-identity consequences before the action, preserves the session trip draft, guards blocked storage and restores keyboard focus appropriately. Native disclosures and44px targets passed; initial and expanded screenshots were visually inspected.

TransitMap differs from supplied base only by the two `zoomAnimation:false` options and explanatory comments. All ETA arithmetic, route-forward tracking, both occurrences, filter rules, route/bus identity, ride-end conditions, focus logic, server transport and historical data are unchanged. No new probability, normality, calibration or numerical improvement claim was made. Current-release and follower research documents and the other team's current progress/requests were read; no shared-interface action is needed.

Installed Leaflet source supports the original diagnosis: `_animateZoom` schedules a delayed completion that stop/remove do not cancel. The normal-clock original reproduction now passes. The old completed baseline button-zoom experiments were preserved rather than repeated. Frozen baseline main/TransitMap source was independently compared with the exact base. The first reviewer audit used a basename matcher that also selected stop-data/main.tsx; full source paths corrected that reviewer-only selector. Final audit is `review-ux09-map/audit-source.py` / `scope-audit.json`.

## Independently executed verification

Node commands use cwd `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`. Fresh outputs: `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-map`. Shared heavy.lock covered all test/build/browser work, including entire port8093 start/test/cleanup. The lock was occupied by ETA research until05:53:39; source inspection and audit proceeded meanwhile. No dependency installation.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-map/verified flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/verify.sh`

   **Exit0**, `verify.log`:77tests/sevenfiles, backend/frontend typechecks, Vite129modules. Mobile/desktop each pass six system-map and six ride-map cycles (24total), settled keyboard zoom/pan, real browser pinch/wheel, reflow at320/360/390/430/640/1280px, recovery focus and final walking destination. Original three-cycle normal-clock reproduction passes. Feed checks cover pending/empty/failed/malformed/stale/recovered states, hidden/selected-idle modes and both#307/#309slots. Trip/walk/pickup fullscreen Back/Escape and focus pass. Five reports complete with zero errors and closed resources. Phone system/ride screenshots visually inspected; tiles are intentionally intercepted, so no basemap-availability claim.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-map/additional.sh`

   **Exit0**, `additional.log`:90tests/ninefiles, covering draft/refresh/storage/identity/live-update behavior, server checkpoint restart/parity, Docker runtime dependency closure and class-deadline states. Combined distinct tests: **167 across16files**. Mobile/desktop recovery checks pass transient/persistent failures, explicit reset, blocked clear/getter, external focus, independent disclosures, touch/keyboard and reflow. Reused reviewer-authored in-memory fault wrapper around actual TransitMap proves real-trip draft retention, report-identity reset and intentional header Refresh clearing. Actual service-worker test proves offline cached-shell reload, expired/unavailable live values, no cached API response and automatic network recovery. Four more reports complete with zero errors and closed resources. No candidate modification or production service involved.

3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-map/pinch.sh`

   **Wrapper exit0 only because it captures all four outcomes. This is not a passing candidate test.** Candidate manual and natural-auto-end invocations each exit1 on the no-page-error assertion; paired baseline invocations each exit0. Both candidate failures have the same new `_onTouchEnd/_resetView` exception. The script uses current built source by default and `DIST_ROOT=.../ux/ux-09/baseline-dist` for the frozen baseline. `AUTO_END=1` selects natural expiry. See the blocking finding above. No screenshots added by this probe.

4. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-map/audit-source.py` — **exit0**. Exact recovery preservation, two-option-only map scope and supplied-base frozen bundle provenance.

5. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-map/verify-integrity.py` — **exit0**, `integrity.json` / `integrity.log`: exact head/base/merge-base, clean checkout/index/tree,908tracked file hashes and131builder evidence files unchanged; main/CrashRecovery/TransitMap rebuilt-source parity; nine routine browser reports pass. Screenshot census across both teams:345images,16,153,983bytes, below100MiB. The four diagnostic pinch reports are explicitly separate from those nine passes.

6. `git diff --check 98e535b99649e74ca599d2e33bcfdc46df83d30d..HEAD`, `node --check services/shuttle-v2/scripts/map-lifecycle-check.mjs` and `node --check services/shuttle-v2/scripts/crash-recovery-check.mjs` from repo root — **each exit0**.

## Handoff and limits

The builder should address only the active-gesture teardown regression and add its durable test, retaining the passing original reproduction and prior recovery work. Fresh independent review is required after that correction. UX10saved-place/location/weather work follows this coherent fix. Controller owns all capture/PR/fullsuite/staging/CI/release/deployment actions; this review publishes nothing.

Physical iOS/Android, native assistive technology and OS/background behavior are not certified. Natural expiry here uses a legitimate near-expiry fixture, not a measured frequency estimate. No source, Git branch/commit/index, controller/other-team file, DB record, private feedback or credential was changed. All owned sessions28393/43254/53584completed; every browser/server/lock closed, existing watcher untouched. Original evidence retained. No pending experiment.
