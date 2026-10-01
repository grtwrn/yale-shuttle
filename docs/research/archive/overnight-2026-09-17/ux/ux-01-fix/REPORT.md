# Keep class-arrival advice with its supporting route

Builder correction, September 17, 2026, 22:56 ET. **Tested candidate; fresh independent review required.** HEAD remains `b7c44c0e142d949de47375d9f56741cb404600f5`, parent/deployed handoff baseline `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`. No commit, branch change, PR or deployment by this worker.

## Problem and result

The first review proved that new class advice could describe Blue's buffer or uncertain connection while only Red's late window and a late walk were actionable. The supporting route could also be behind Show more. The panel now includes that route's own window, catchable bus identity, caution and trip action, alongside the existing primary shuttle and walking comparison. It does not promote the route into a recommendation or change any time calculation or route order.

An actual application-shell fixture also reproduced a missing map when that action opened the fourth route. The details list already handled selected routes outside its collapsed slice, but its map only searched the slice. The map now finds the selected route in the complete ordered list; Back retains the original top-three overview and collapsed list. The arrival-distribution disclosure explicitly names its route because the comparison can now contain two shuttles.

## Changes

All source paths below are under `services/shuttle-v2`:

- `web/src/arriveByMessage.ts`: buffer and conditional messages carry the exact existing DeadlineOption that supports their advice.
- `web/src/ArriveBy.tsx`: render that supporting row if it differs from the primary shuttle/walk, without duplicates; explicitly name the route whose optional distribution is shown.
- `web/src/TransitMap.tsx`: selected-route map resolves against complete ordered options, matching the existing details list; overview visibility is unchanged.
- `web/src/ArriveBy.render.test.tsx`: four rendered regressions covering buffer, catch risk, limited data, hidden supporting route, correct bus/time/action, and no duplicate primary/walk rows.
- `web/src/arriveByMessage.test.ts`: preserve the supporting row identity in helper tests.
- `scripts/arrive-by-check.mjs`: existing forecast-disclosure selector accepts its route name. Syntax-checked; this entire older multi-feature script was not rerun.

No estimator, planner, shared wire, numerical comparison, recommendation, history selection, repeated occurrence or second-arrival logic changed. ETA's coordination notes contain no overlapping app change.

## Executed verification

All service commands ran from `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`. Heavy and complete browser commands held the common lock. All commands below completed with exit 0 unless identified as harness setup.

Initial targeted check:

```sh
npm test -- web/src/ArriveBy.render.test.tsx web/src/arriveByMessage.test.ts web/src/arriveBy.test.ts web/src/journeyArrival.test.ts
```

26 tests passed. Final source verification:

```sh
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/verify.sh
```

Exit 0; exact output in `final-verify.log`. Script runs sequentially:

```sh
npm test -- web/src/ArriveBy.render.test.tsx web/src/arriveByMessage.test.ts web/src/arriveBy.test.ts web/src/journeyArrival.test.ts web/src/liveUpdates.test.ts web/src/tripDraft.test.ts src/server/serverEta.closure.test.ts
npm run typecheck
(cd web && npx vite build)
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/browser-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/supporting-route-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/reviewer-acceptance.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/shell-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/hidden-route-shell.mjs
```

**58 tests passed; backend and frontend typechecks passed; Vite built 124 modules in 5.06 seconds.** All five browser harnesses passed. The original review acceptance cases now pass in a copied harness; original reviewer evidence remains unchanged.

A supplemental run extended only the fixtures/assertions after final source verification: correct route colors from `ROUTE_COLOR`, named Red forecast disclosure with 50 dots and keyboard Space, details reflow at all widths, and explicit unchanged collapsed overview on Back. No application source changed after the final source verification.

```sh
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash -c 'set -euo pipefail; node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/supporting-route-check.mjs; node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/hidden-route-shell.mjs'
```

Exit 0; `supplemental-verify.log`. The reviewer acceptance copy was rerun under the lock after giving its output a distinct filename (previously collided with the new supporting-route report); assertions unchanged, exit 0, `reviewer-acceptance.log` / `reviewer-acceptance-browser.json`.

```sh
node --check scripts/arrive-by-check.mjs
git diff --check
```

Both exit 0. No full-suite or backend staging smoke claim; normal controller/CI gates remain.

## Browser evidence and limits

- `after-browser.json`: existing 18-state matrix, including recommendation/buffer/late/missing/loading/stale/failed/future/catch/limited/empty/partial, buffer edits, clear/reopen and recovery; primary keyboard and invalid-date behavior preserved.
- `supporting-route-browser.json`: actual component and ranking/visibility helpers, synthetic Blue Day fourth in order and outside the main visible slice. Buffer, connection and limited-data states each show its own #410, window and action. Tab order is Red → Blue Day → Walk; Enter and Space select Blue Day. Loading/failed updates remove the old supporting forecast; recovery restores it. The original Red distribution stays explicitly labeled Red and expands with 50 modeled dots.
- `reviewer-acceptance-browser.json`: both previously failing rendered acceptance cases now pass.
- `shell-browser.json`: actual built SPA with intercepted checked-in network, future plan and empty fleet; long destination, controls, keyboard, saved draft and invalid deadline.
- `before-hidden-route-shell.json` / `after-hidden-route-shell.json`: actual application shell, substituting **only planTrip's candidate options** with synthetic TripOptions; real server-ETA reader, live destination computation, ranking, visibility and navigation. Before the map change, Blue Day details had no route map; after it, the map appears. Back preserves class time, buffer and collapsed top-three list. This is a controlled rendering/navigation regression, not a natural planner-output or ETA-quality validation.
- Screenshots `supporting-{buffer,connection,limited}-360.png` and `after-hidden-route-details-360.png` visually inspected. Map tiles are intercepted, so the screenshot verifies the map/route overlays and controls, not tile availability. Prior screenshots/data preserved. Total across both teams at this handoff: 31 images / 1,696,283 bytes (<2 MiB).

Layouts checked at 360/390/430/1280 px and 640 CSS-pixel reflow equivalent to 200% on a 1280px desktop. Supporting action bounds meet 44px minimums. No native browser zoom or external screen-reader application was run.

One initial shell-fixture attempt matched the Back button's title rather than its accessible text and timed out. Fixed the harness selector; `setup-back-selector.log` preserves that setup failure. No app fix was needed for it. Every browser context/page/browser is closed in finally or by its parent browser. No server, collector or persistent watcher was started or modified. All requests were intercepted, tester identity helpers were used, no private feedback/production data accessed, and no live-service availability assumed.

## Fresh review focus

Verify the supporting option stays attached to its own route, bus, window, caution and selection action; no duplicate primary/walk rows; unknown/partial precedence remains truthful; fourth-route navigation renders its map without changing Back's collapsed overview. Check source delta over `b7c44c0...`, and combined UX-01 proposal over `40af3c0...`. After approval, the controller owns capture/commit/CI/publication. Next builder task remains UX-02 navigation/place-search accessibility; do not repeat completed UX-01 baseline experiments.
