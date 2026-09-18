# Distinguish missing shuttle updates from an empty fleet

Builder proposal, September 18, 2026, 02:44–03:00 ET. Ready for independent review; not independently approved or published. HEAD remains `373505d5076f21a08de69d9587be9b2a55956642`; index is empty. Controller owns capture, review, integration, CI, merge and deployment verification.

## Proven problem

The frozen production bundle matches the current TransitMap source exactly, checked through its sourcemap. In a 390px phone browser, both an unfinished first request and a503 response displayed “No shuttles running right now.” After a successful empty response followed by a failed request, the Red card still said “0 buses” and “no buses en route.” Those are observations about an unavailable snapshot, not evidence that service stopped. `baseline.json`, `baseline-final.log` and `baseline-failed.png` preserve the reproduction.

The Map page also repeated its hidden-route explanation above and below the map, and told the rider to tap “Every route” while the visible toggle read “Running now.” The filter algorithm itself was consistent between map and cards and remains unchanged.

## Proposal

Only two source files change:

- `web/src/TransitMap.tsx`: presentation and recovery behavior.
- `scripts/empty-service-check.mjs`: reproducible, bounded full-SPA browser regression with intercepted network and seeded tester identity.

Trip and Map now distinguish initial loading, unavailable position snapshots, and successfully received data. A successful empty result says no shuttles are **reporting**; it does not assert no service. A presentation-only flag distinguishes a failed position request from usable positions that lack ETA rows, so missing forecasts do not erase a current bus count. Both use the existing live-update freshness/hidden-tab policy. Existing global warnings, request validation, polling, ETA attachment and stale-forecast rejection are unchanged.

On unavailable snapshots, route schedules remain visible without stale inferred service-off labels; historical cached notices are marked “Last received notice.” Route cards explain missing live arrivals, including a fresh bus snapshot with no usable forecast. Thumbnail names no longer claim live positions when their snapshot is unavailable. Walking and destination actions remain available.

Map emptiness has one explanation, under the map where the missing cards would be. “Show all routes” clears manual hiding and switches to Every route. “Show selected routes” switches to Every route while retaining manual choices. Both return focus to the persistent mode control; its pressed state is exposed. The existing top-row chip behavior, storage format, map/card shared filter and geometry are preserved.

## Executed verification

Service cwd for browser commands: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`.

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/baseline-check.mjs` — final run exit0, `baseline-final.log`. Real phone reproduction above, zero page errors; all resources closed.
2. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/verified flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/verify.sh` — **exit0**, `verified.log`:
   - `npm test -- web/src/liveUpdates.test.ts web/src/mapFilter.test.ts web/src/etaSource.test.ts web/src/schedule.test.ts web/src/announcements.test.ts web/src/routeThumb.test.ts` — **158 tests / six files**.
   - `npm run typecheck` — backend and frontend pass.
   - `(cd web && npx vite build)` — pass,127 modules,4.75sec.
   - `node scripts/empty-service-check.mjs` and `DESKTOP=1 OUT="$OUT/desktop" node scripts/empty-service-check.mjs` — both pass. Each exercises28 bus requests including13 failed requests, with zero page errors and `resourcesClosed: true`.
3. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/verify-integrity.py` — **exit0**, `integrity.log`/`integrity.json`. Exact HEAD, frozen baseline and source hashes; unchanged complete numerical options memo, shared map filter, poll behavior other than the new presentation flag, and planner/journey/arrivals/etaSource/liveUpdates/mapFilter/schedule files. Empty index, whitespace and browser-script syntax pass. Builder HEAD assertion must be consciously adapted after controller capture for independent review.
4. Explicit `node --check services/shuttle-v2/scripts/empty-service-check.mjs`, `git diff --check`, `git diff --cached --exit-code` — pass. Additional source check confirms AllRoutesMap is byte-identical apart from trailing whitespace and final bundle sourcemap matches candidate TransitMap.

The final mobile and desktop reports are `verified/empty-service.json` and `verified/desktop/empty-service.json`. They cover pending/failed first load in both views; fresh empty, failed-after-empty, malformed response, missing/stale ETA and failed updates beyond45sec; fresh empty/nonempty recovery; cached notice context; preserved fresh counts; off-hours successful empty service; walking/schedule fallback; and both pickup slots307/309 after recovery. Map checks cover all-hidden basemap, selected-idle recovery, single explanation, route-choice persistence,44px buttons, pressed state, Enter/Space/touch and focus after the disappearing recovery control. Reflow at360/390/430 mobile and1280/640 CSSpx desktop; long destination text retained. Phone and desktop screenshots were visually inspected. Map tiles are deliberately blocked.

## Failed attempts and limits

- The first baseline probe used uppercase visual “Map” as its accessible name; the actual name is lowercase. It timed out after already reproducing the Trip contradiction. Preserved `baseline.log` and `baseline-first-attempt.json`; corrected final probe passes.
- `first-verify.log` passes tests/types/build and initial browser assertions, then stops at a Leaflet `_leaflet_pos` timer while fake time advances after an immediate map/trip/map transition. Final harness lets existing animations settle400ms around tab switches, and passes. The earlier browser evidence remains in `final/`; `second/` is the successful intermediate run before making Show all clear both modes.
- A smaller rapid-switch experiment against frozen baseline (`rapid-map-baseline.mjs`, `.log`, and `rapid-map-baseline/rapid-map-baseline.json`) completed successfully and **did not reproduce** that timer error. Thus there is no claim that it is proved pre-existing, introduced here, or reproducible on a real device. A setup attempt first used the wrong relative source path; corrected before the queued browser ran. Map implementation is unchanged. Normal-clock rapid zoom/filter/unmount reproduction is a separate bounded follow-up; the settled-state checks do not certify all animation races.
- Full suite, complete backend staging/API/browser smoke, CI, independent review and production verification remain controller gates. No native screen reader, physical phone, native200% browser zoom, or all-view accessibility claim.640 CSSpx checks reflow. No ETA accuracy, probability, sample-quality or service-availability inference is claimed from synthetic fixtures.

All owned sessions34560/52459/55850/38434/33187/29099 completed. Every launched browser/page/context closed; no server/collector, dependency installation, watcher change, private feedback/token/DB access, other-team mutation, GitHub operation or publication. Both-team image census170files/7,618,933bytes, below100MiB; earlier evidence preserved. ETA coordination read through02:51; its pending ordered-join integration does not overlap these presentation changes.

## Next bounded task

Independently review snapshot-versus-forecast availability, valid empty and off-hours states, shared-filter recovery/focus, and unchanged numerical/poll invariants. Then continue UX08 alert/on-board status and recovery, or the specific UX09 rapid map teardown reproduction using normal time before proposing a fix. Same-bus later pickup/missing destination identity remains a separate ETA contract request.
