# Independent review 14 — crash recovery and honest reset consequences

Reviewed September 18, 2026, 05:14–05:22 ET (controller round 11). **Verdict: approve. No blocking findings.**

Exact HEAD: `da51fcb0af70f554ef0b141aa07d4a390f3c7de0`.
Exact supplied base and merge-base: `98e535b99649e74ca599d2e33bcfdc46df83d30d` (PR292).

The complete candidate diff contains only `services/shuttle-v2/web/src/main.tsx`, new `web/src/CrashRecovery.tsx`, and new `scripts/crash-recovery-check.mjs`. I verified HEAD independently before tests and again afterward, examined the actual diff, read the builder's evidence and preceding independent review, and independently executed the checks below. The checkout, index and tree stayed clean and unchanged. No application, Git, controller, other-team or publication action was taken.

## Supported improvement

Recovery leads with Reload and a short explanation. Reset and its consequences are inside a separate native disclosure; technical details are initially hidden. The reset explanation matches the code: `localStorage.clear()` removes saved/recent places, alerts, ride state, preferences and the anonymous identity used to retrieve Your reports. It does not delete submitted server reports. The current tab's trip draft remains in sessionStorage. Only an explicit reset clears storage; ordinary crash Reload retains data. Existing catch-and-reload handling also works when clearing or accessing localStorage throws.

A crash that removes the focused app control now focuses the recovery heading. Reload is the next Tab action. Surviving external focus is preserved. Native disclosures work by keyboard and touch, their controls meet 44px bounds, and long technical text wraps at phone widths. I visually inspected independently produced initial/expanded recovery screenshots and the actual-app reset screenshot. Copy is short at the primary decision and gives the extra detail before destructive action.

The reviewer-authored supplemental fixture wraps the real TransitMap in an in-memory fault injector while keeping the real main boundary and CrashRecovery, plus every other runtime module unchanged. It proves a valid actual TripPlanner draft with both endpoints survives ordinary Reload and explicit reset, including a persistent startup fault that ordinary Reload cannot remove. Reset removes report identity before the tester helper reseeds its excluded identity on the next document. The normal app-header Refresh remains intentionally different: after recovery it still clears the trip.

## Independently executed checks

All Node commands used cwd `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`. Fresh evidence is `ux/review-ux09/`. Shared heavy.lock covered every test/build/browser invocation, including full local server start/test/cleanup. No dependencies were installed.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/verified flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/verify.sh`

   **Exit 0**, `verify.log`: 46 tests in five files (tripDraft, pullToRefresh, anonId, recents, liveUpdates); backend/frontend typechecks; Vite production build, 129 modules; actual entry-boundary recovery browser tests on mobile and desktop; unmodified rebuilt-SPA feed regression. Recovery tests include transient and persistent faults, explicit reset, blocked clear/getter, external focus, Enter/Space/touch, independent disclosures, and 320/360/390/430/640/1280px reflow. Feed checks cover pending/empty/failed/malformed/stale/recovered states, filter recovery and both #307/#309 upcoming slots. All three browser reports completed with no page errors and closed resources.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/integration.sh`

   **Exit 1**, `integration.log`, a reviewer-fixture selector error after all **44 tests in four files passed**. Passing files were `src/server/serverEta.test.ts`, `serverEta.parity.test.ts`, `serverEta.closure.test.ts` and `web/src/arriveBy.test.ts`. These exercise restart/checkpoint recovery, server row parity, runtime Docker dependency closure and class-deadline distinctions. The command also named nonexistent `web/src/liveArrivals.test.ts`; Vitest ran the four matching files only. The actual transport consumer test is `etaSource.test.ts`, run explicitly in step 3.

   The first supplemental browser expected exact standalone text “Independent destination”. Its preserved `extra/lifecycle.json` accessibility snapshot shows the correct restored trip in the composite named To button; zero page errors and all resources closed. I corrected only this reviewer selector to the actual accessible button. No candidate change occurred. Offline work had not started when this script stopped.

3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/additional.sh`

   **Exit 0**, `additional.log`: 13 `etaSource.test.ts` tests pass, including both occurrences, skew/aging, distributions, missing/malformed responses and no local-estimator fallback. Total distinct passing tests for this review: **103 across 10 files**.

   The corrected reviewer-authored real-app lifecycle test passes (`extra-second/lifecycle.json`, four intercepted bus requests, zero page errors, resources closed). It checks runtime and initial crashes, real endpoint/draft restoration, reset identity/local-data loss, native reset disclosure semantics, keyboard/touch, and header refresh behavior. It additionally checks actual recovery reflow at 320/360/390/430/1280px and 200% CSS zoom at 1280px. CSS zoom is not a physical-device/native-zoom certification.

   The unchanged built SPA plus actual service worker passes a bounded local port8093 offline/recovery test (`offline/offline-shell.json`, three fixture feed requests). Interrupted and expired estimates become unavailable, cached-shell reload opens with unknown live status instead of stale counts, no API response enters Cache Storage, and network restoration recovers automatically. All pages, contexts, browsers and the fixture server close.

4. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/verify-integrity.py`

   **Exit 0**, `integrity.log` / `integrity.json`: exact head/base/merge-base, clean tree/index/checkout; all 907 tracked-file hashes unchanged; all 82 builder evidence files preserved; exact three-file source scope and builder hashes; rebuilt sourcemap parity for main, CrashRecovery and TransitMap; unchanged main behavior outside fallback/import. The reviewer fault bundle also matches actual CrashRecovery, TransitMap, tripDraft and pullToRefresh sources. Five successful browser reports have zero errors and closed resources. Both teams' artifact image census is 297 files / 14,058,930 bytes, below 100MiB; existing data retained.

5. `git diff --check 98e535b99649e74ca599d2e33bcfdc46df83d30d..HEAD` — **exit 0**.

## Integration and limits

Estimator, planner, route-forward tracking, numerical arrivals, stop occurrences, server transport, wire schema, historical samples, notifications and service-worker behavior are unchanged. The entry's error capture/logging, preview routing, PWA registration and pull-to-refresh behavior are exact outside the fallback/import. No arbitrary cap, selective exclusion, statistical claim, probability or future-data feature was introduced. Current release and follower research notes were read; their mixed/exploratory evidence remains unrelated to this UI approval.

The builder's separate normal-clock map stress failures remain a real **pre-existing unresolved defect**, not a passing test or a claimed fix. I checked their recorded paired failures and source provenance: frozen baseline main is exact supplied-base source, and baseline/candidate built TransitMap sources are byte-identical. I did not restart that completed paired experiment. The next builder should use `ux-09/NEXT_MAP.md` to repair the zoom/unmount callback lifecycle; this fallback cannot catch those asynchronous Leaflet errors.

Faults and feeds are synthetic and explicitly labeled. No production crash-cause, native assistive technology, physical iOS/Android, OS background behavior or service-worker deployment-version race is certified. Full suite, complete backend staging/API smoke, CI, merge and deployment verification remain controller work. No production/private feedback, database or credentials were accessed. Tester helpers and fully local/intercepted network protected rider analytics. The existing watcher was untouched.

All owned command sessions (32880, 9040, 97948) finished. No owned persistent browser, server or heavy lock remains. Source-control state was preserved. Next: controller release gates for this approved recovery slice, then the already-reproduced map zoom teardown repair, then UX10 saved-place/location/weather work and remaining coverage items.
