# Independent review — UX-01, round 1

Reviewed 2026-09-17 22:35–22:43 ET. **Verdict: changes_requested.**

Exact base: `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`.
Exact candidate HEAD: `b7c44c0e142d949de47375d9f56741cb404600f5`.
HEAD's parent is the supplied base. Worktree was clean on entry and after testing. No tracked file was edited; no branch, commit, GitHub or publication operation was performed.

## What is supported

The five-file diff is confined to v2 frontend presentation. Existing `compareDeadline` arithmetic, stale gate, walk/shuttle selection and recommendation are unchanged; its sole change is returning already-computed rows. The new helper correctly separates unknown forecasts, possible lateness, buffer use and conditional connections in the primary cases. It preserves successful walking/route advice, considers unknown alternatives before making an overall lateness statement, and makes no calibrated probability or normality claim. The future-planning note accurately describes existing schedule/headway/travel inputs; the blank bus suffix is removed without losing the catchable journey's identity.

Independent execution passed 54 targeted tests, backend/frontend typechecks, Vite build, an extended 18-state component browser harness and the built-SPA future-planning browser harness. Source and tests preserve repeated pickup occurrences and the same catchable vehicle/route for the destination. The Docker runtime closure test passes; the new runtime import stays in the frontend bundle. No server transport, cache, checkpoint, model coefficient, historical cohort or forecast outcome was changed.

Read CLAUDE.md, team handoff/backlog/first task/progress/checkpoint/summary, builder scripts/report, other-team progress/requests, current Red release documentation and follower research/identity reports. No previous independent UX review note existed. ETA has no overlapping application or wire change this round. Research findings do not support any new live model claim and none is made here.

## Blocking finding: show the route supporting the new advice (P2)

Location: `services/shuttle-v2/web/src/arriveByMessage.ts:28` and `:37`, integrated at `ArriveBy.tsx:31` / `:71`.

The helper searches **all** rows for a buffer-fitting or conditional shuttle, but the component continues to render only `comparison.shuttle` and `comparison.walk`. When Red has a window extending past class, Blue's later-ranked window ends inside the buffer, and walking is late, the new headline says “Your buffer may be tight” and explains that Blue's window ends by class. The only times/actions below are Red's late window and the late walk. Blue's time, bus and trip action are absent. The analogous conditional case says “Blue: ... This window assumes you catch it” above Red's unrelated window.

Reproduced in Chromium at 360/390/430/1280px with the real component. Screenshots `review-round-1/after-second-buffer-360.png` and `after-second-catch-360.png`, and `supporting-route-browser.json`, preserve the exact output. The independent acceptance assertion in `supporting-route-check.mjs` fails on both scenarios (exit 1). The builder's new second-shuttle unit test asserts the headline and unchanged selected row but does not catch their mismatch.

This is not ruled out by trip ranking. `routing-witness.mts` runs the real `preferredTripOrder` and `topVisibleOptions` on explicitly synthetic valid TripOptions: Red/Green/Brown/Blue Day/Walk remain in that order, the first three shuttles are visible, and the buffer headline refers to Blue Day behind “Show more”. See `routing-witness.json`. This witness is a reachability check, not a recorded rider incident.

Correction: retain the existing estimator, recommendation and route ordering, but make the supporting route's actual window and a clearly named trip action available alongside its new buffer/connection advice. A compact contextual action inside the existing panel can do this; do not silently present Red's window as the window referred to by Blue's explanation. Add rendered tests for a second-route buffer case and second-route catch/limited-data case, including a supporting route outside the main visible slice. Assert that its own route/bus/time and selection action stay together. Preserve walking comparison and existing partial-availability handling.

The first task explicitly asks for a buffer conclusion with its concrete time visible. Until this is corrected, the new class advice can give a rider a different route to assess from the one whose time/action the panel exposes.

## Executed checks

Working directory for service commands: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`.

`flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-1/verify.sh` — exit 0. Checked script runs, sequentially under one lock:

- `npm test -- web/src/arriveBy.test.ts web/src/arriveByMessage.test.ts web/src/journeyArrival.test.ts web/src/liveUpdates.test.ts web/src/tripDraft.test.ts src/server/serverEta.closure.test.ts` — exit 0, 6 files / 54 tests passed.
- `npm run typecheck` — exit 0, backend and frontend passed.
- `(cd web && npx vite build)` — exit 0, 124 modules, 5.01 seconds.
- `node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-1/browser-check.mjs` — exit 0, 18 states, no horizontal overflow or browser errors; buffer edits, fresh/stale/failed/recovered transitions, clear/reopen, invalid dates, names, Tab/Enter/Space, >=44px controls.
- `node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-1/shell-check.mjs` — exit 0, built SPA, future empty fleet, long destination, 360/390/430/1280px and 640px reflow, >=44px departure buttons, 16px input, keyboard Now/Plan for later, focus retained, saved draft restored and invalid deadline authoritative.

`flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-1/supporting-route-check.mjs` — exit 1, two demonstrated supporting-route failures. See `supporting-route-final.log`. An earlier construction attempt had an extra parenthesis in this reviewer-only harness and failed before launching Chromium; `supporting-route-check.log` preserves that setup error, corrected before the substantive run. It is not an app failure.

`./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-1/routing-witness.mts` — exit 0, confirms the app's actual ranking/visibility can hide the route supporting the new headline.

`git diff --check 40af3c0bb8e2522972b4e9f0222b1756fbd3c227 b7c44c0e142d949de47375d9f56741cb404600f5` — exit 0. `git status --porcelain=v1` remained empty; exact HEAD and parent rechecked after execution.

## Limits and handoff

Browser checks used existing tester identity helpers; all requests were intercepted, no real feedback/analytics or production DB traffic was sent. All pages, contexts and browsers closed, including before the failing acceptance assertion. No staging server or persistent watcher was started or changed. Total screenshots across both teams at review completion: 20 files / 1,078,500 bytes. Builder evidence was preserved in place; reviewer output is separate.

The zoom check is equivalent 640 CSS-pixel reflow, not native browser zoom. No external screen reader or physical phone was used. Full suite and backend staging smoke were not run by this reviewer; controller gates still apply after correction. Repeating unchanged estimator research is unnecessary for this presentation fix.

Next builder: fix the one supporting-route mismatch and rerun rendered regression plus existing primary states; request fresh independent review. Then resume UX-02 navigation/search accessibility. Do not publish this exact candidate before correction.
