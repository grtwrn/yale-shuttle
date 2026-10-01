# Independent review — UX-01 correction, round 2

Reviewed September 17, 2026, 22:59–23:03 ET. **Verdict: approve. No blocking findings.**

Exact base: `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`.
Exact candidate HEAD: `3bfbcef0c87898668a9a348f9db74d664319ece3`.
HEAD was independently verified at entry and after execution; merge-base equals the supplied base. Working tree and index stayed clean. No tracked source edits, branch/commit operations, GitHub actions, publication or controller-state writes were performed.

## Finding resolution and rider outcome

The previous review's supporting-route mismatch is corrected in the actual candidate. `deadlineMessage` returns the existing comparison row that supports buffer/conditional advice. `ArriveBy` renders that row's route, catchable bus, outward-rounded destination window, caution and trip action together, adding it only when it differs from the existing shuttle/walk rows. It does not silently change the recommended route. The optional distribution now names its own route explicitly, so Red's plot cannot be mistaken for Blue's supporting window.

Independently executed Chromium checks reproduce both formerly failing acceptance cases and now pass. Additional buffer, connection and limited-data fixtures place Blue Day fourth in the actual ranking, outside the main visible slice. Its #410/window/action remains available; Tab reaches it between Red and Walk, and Enter/Space select Blue Day. Loading/failed states remove the supporting forecast, and recovery restores it. The named Red disclosure opens 50 modeled outcomes by keyboard.

The selected-route map now filters the complete ordered list, while the collapsed overview still filters visible options. In the actual application shell, opening the fourth route from the deadline panel renders Blue Day's map and details; Back restores the original top-three overview, collapsed list, class deadline and buffer. I visually inspected this review's own 360px buffer, connection and route-detail screenshots. Supporting actions remain readable and attributable; no horizontal overflow or short touched targets was found.

The complete seven-file diff against the supplied deployed base preserves numerical ETA calculations, `compareDeadline` selection/recommendation, route ranking, server transport, estimator state, historical observations and both upcoming occurrences. `compareDeadline` only additionally returns rows it already computed. New UI states distinguish unknown information, buffer use, conditional connections and evidence of possible lateness. Walking advice remains usable with missing shuttle data. No on-time percentage, coverage, normality or estimator-improvement claim is introduced. Future-planning copy is consistent with the existing schedule/typical-time calculation; blank bus identities are omitted.

Read the team handoff/backlog/first task, current progress/checkpoint/reports and prior review; inspected CLAUDE v2, frontend/runtime and tester-identity guidance; read ETA progress/requests, current Red release documentation and follower/identity research reports. There is no shared-interface conflict or basis for promoting research coefficients in this presentation slice.

## Independently executed checks

Service command working directory: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`.

```sh
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/verify.sh
```

**Exit 0.** Output: `review-round-2/verify.log`. Inspected copies of the existing browser harnesses write separate review outputs, preserving all builder/prior-review evidence. The checked script executes sequentially under the shared lock:

```sh
npm test -- web/src/ArriveBy.render.test.tsx web/src/arriveByMessage.test.ts web/src/arriveBy.test.ts web/src/journeyArrival.test.ts web/src/liveUpdates.test.ts web/src/tripDraft.test.ts src/server/serverEta.closure.test.ts web/src/tripRanking.test.ts web/src/planner.test.ts src/server/serverEta.test.ts
npm run typecheck
(cd web && npx vite build)
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/browser-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/supporting-route-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/reviewer-acceptance.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/shell-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/hidden-route-shell.mjs
```

- **159 tests in 10 files passed.** Includes rendered regression, deadline/journey handling, actual ranking/planning, stale updates, stored draft, Docker runtime import closure and server checkpoint/observation freshness. Existing repeated-stop/second-visit behavior remains covered.
- Backend and frontend TypeScript checks passed. Vite built 124 modules in 4.97 seconds.
- All five browser harnesses passed with zero page errors. Eighteen deadline states, buffer edits, clear/reopen, stale/failed/recovered transitions, invalid/past datetime suppression, accessible names, keyboard actions, >=44px targets, long destination, future empty fleet and built-SPA draft reload were exercised. Layouts cover 360/390/430/1280px and 640 CSS-pixel reflow.
- Both earlier acceptance failures pass. The JSON check label still calls them “mismatched supporting-route cases” because it describes their original regression scenario; this run's assertions pass and show the corrected output.

From repository root:

```sh
git diff --check 40af3c0bb8e2522972b4e9f0222b1756fbd3c227 3bfbcef0c87898668a9a348f9db74d664319ece3
node --check services/shuttle-v2/scripts/arrive-by-check.mjs
git rev-parse HEAD
git merge-base 40af3c0bb8e2522972b4e9f0222b1756fbd3c227 3bfbcef0c87898668a9a348f9db74d664319ece3
git diff --exit-code
git diff --cached --exit-code
git status --porcelain=v1
```

All exit 0; exact HEAD/base confirmed; working-tree/index diffs and status output empty. No check failed in this review.

## Scope and handoff

Browser fixtures use `seedTestId`, intercept all requests and close every browser/context/page. No server, collector, persistent watcher, production DB, private feedback or real rider analytics was accessed or changed. No dependency installation. Shared screenshot total after review: **41 files / 2,266,095 bytes**, well below 100 MiB, with prior evidence preserved. All review processes exited and the heavy lock was released.

The hidden-route shell fixture substitutes only planner candidate options; the real transport reader, destination computation, ranking and navigation run. It is a controlled integration regression, not proof that those exact synthetic options occur naturally or a measurement of ETA accuracy. Map tiles are intercepted. Reflow represents 200% equivalent CSS width, not native browser zoom; no external screen reader or physical phone was used. The full Vitest suite, complete backend staging/API smoke, older multi-feature `arrive-by-check.mjs` and deployment verification were not run by this reviewer. Controller/CI gates remain before publication.

Controller can proceed with the approved exact candidate through normal CI/publication gates. Next builder: **UX-02 navigation and place-search accessibility**. Do not repeat the completed UX-01 baseline experiments or reopen the corrected supporting-route finding without new evidence.
