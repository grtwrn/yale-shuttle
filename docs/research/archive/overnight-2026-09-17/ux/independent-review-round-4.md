# Independent review — UX-03 feedback and replies

Reviewed September 18, 2026, 00:03–00:10 ET (controller round 3; fourth UX review artifact). **Verdict: approve. No blocking findings.**

Exact base: `cff3b2a6b7ad6cdd2f899bb4d564a4c03dae2d37`.
Exact candidate HEAD: `135f046e285074fb3e45d2c1640b02b661307487`.
HEAD, parent and merge-base independently match the supplied values. Tracked worktree and index were clean at entry and after execution. No tracked file, branch, commit, controller state, GitHub or publication operation was changed by this reviewer.

## Supported improvement

The complete diff has three files: `web/src/TransitMap.tsx`, `web/src/IssuesPanel.tsx`, and the bounded `scripts/feedback-accessibility-check.mjs`, all under the current v2 service. Existing tests are not weakened. No new package or runtime import is introduced.

A failed feedback send now displays an alert next to the retained draft, independently of the sending/success status. The error remains past the former six-second status timeout. The feedback and reply fields have associated labels; screenshot picker actions are actual keyboard buttons; priority selection is exposed; touched controls meet the measured 44px target and field font requirements. Picker buttons remain focusable while activation is guarded. Attachment removal restores focus to the surviving picker. Reply and feedback completion restore focus only when the removed composer owned it and another control has not acquired focus. Reply restoration waits for the refresh to finish and its Reply button to be enabled.

I independently ran the candidate browser script in separate mobile and desktop contexts against a newly built bundle. Enter/Space filechooser activation, invalid-image recovery, remove/replace/canceled selection, actual mobile taps, priority semantics, send errors/retries, success/reset, navigation focus, archived disclosure and loading/error/empty states pass. Layout checks cover 360/390/430/1280px and 640 CSS-pixel reflow. I visually inspected this review's phone feedback error/image, reply/image, and desktop feedback screenshots: errors stay with their composer and controls remain readable.

The reviewer-authored `review-round-4/extra-browser.mjs` independently adds these material transitions:

- Feedback with text, urgent priority and a screenshot survives HTTP 503 for more than six seconds, then an aborted network request, then a successful retry. All three payloads retain the same contents and tester identity header. This runs with `/api/buses` failing, so reporting does not depend on a live fleet.
- Opening report 802's reply while report 801's completed screenshot/draft is open clears those attachments/text. The next POST uses report 802 without the old image. Send and Cancel restore focus to report 802's actual Reply button, not the first button in the list.
- A deliberately delayed post-send refresh leaves Reply disabled until completion, then restores focus. Moving focus to another report's priority control during that refresh prevents focus stealing.
- A successfully acknowledged reply followed by a failed refresh remains labeled “Reply sent” while a distinct load alert appears. Keyboard retry retrieves the saved thread.
- Priority changes and archive/unarchive preserve report association and recover visible state.

All three browser runs completed with zero page errors. The candidate harness emits only the expected warning that service-worker registration is blocked by Playwright. No production feedback or private report was read or sent.

The report/image helpers and report transport fields are unchanged. Source inspection confirms no planner, deadline, ranking, route/bus identity, repeated occurrence, ETA arithmetic, checkpoint/cache, historical cohort, or forecast semantics change. Existing transport, restart/freshness and Docker closure tests pass, including both arrival occurrences. This is a supported accessibility/recovery improvement, not an ETA-accuracy or probability-calibration claim.

Read current team handoff/backlog/first task, progress/checkpoint/requests/summary, all previous independent UX reviews and current REVIEW, builder report/script/evidence, current v2 CLAUDE guidance and Red/follower reports. ETA progress/requests through its 00:04 research review propose no shared interface change. Prior supporting-route and navigation corrections are present in the supplied base and untouched here; their completed experiments were not restarted.

## Independently executed checks

Service cwd: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`.

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-4/verify.sh` — **exit 0**, `review-round-4/verify.log`. One checked script holds the shared lock across:
   - `npm test -- web/src/myReports.test.ts web/src/screenshot.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts src/server/serverEta.closure.test.ts`: **79 tests in five files passed**.
   - `npm run typecheck`: backend and frontend passed.
   - `(cd web && npx vite build)`: **124 modules; 4.91 seconds; passed**.
   - `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-4/mobile node scripts/feedback-accessibility-check.mjs`: passed.
   - `DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-4/desktop node scripts/feedback-accessibility-check.mjs`: passed.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-4/extra-browser.mjs` — **exit 0**. Five supplemental transition groups above; `extra-browser.log/.json`, two reviewer screenshots. Syntax check passed before execution.
3. `npm test -- src/server/reports.test.ts src/server/serverEta.test.ts` — **exit 0**, **20 tests** in two files; `server-tests.log`. Includes report helper behavior, recent checkpoint restoration, corrupt/old checkpoint rejection, write-failure tolerance and missing-bus expiry. Light targeted tests; no model fit/full suite.
4. From repository root: `git diff --check cff3b2a6b7ad6cdd2f899bb4d564a4c03dae2d37 135f046e285074fb3e45d2c1640b02b661307487` and `node --check services/shuttle-v2/scripts/feedback-accessibility-check.mjs` — **exit 0**.
5. `git rev-parse HEAD`, `git rev-parse HEAD^`, `git merge-base cff3b2a6b7ad6cdd2f899bb4d564a4c03dae2d37 HEAD`, `git diff --exit-code`, `git diff --cached --exit-code`, `git status --porcelain=v1` — **exit 0**, exact head/base above and empty worktree/index/status.

**99 tests total**, both typechecks, build and three browser executions passed independently. No application or test assertion failed in this review. One read-only search command found `rg` unavailable; `grep`/`find` completed the inspection. It is not an app failure or test result. `verification-summary.json` contains result summaries and reviewer evidence hashes; original builder/prior-review evidence is preserved.

## Limits and continuation

No full suite, complete backend staging/API smoke or deployment verification was run; controller/CI gates remain. Mocked browser APIs test the actual built SPA's state transitions, not real network reliability. All browser contexts use the tester helper and intercept every request. Every browser/context/page closed; all command sessions were collected and locks released. No server/collector/watcher was launched, stopped or reconfigured. No dependencies, production DB, credentials, private feedback or other team's artifacts were changed. Combined screenshot evidence is **67 files / 2,922,776 bytes**, below 100 MiB.

640 CSS pixels is equivalent desktop reflow, not native browser zoom. No native screen reader, physical phone or OS chooser UI was inspected. Cancel/reopen during an in-flight send/decode and parallel fetch ordering remain outside the exhaustive claim; ordinary switching after a completed attachment is explicitly tested here. Existing code already has those asynchronous draft/reset limitations; this approval does not certify every composer race as fixed. Existing failed-feed/no-shuttles wording remains the previously recorded UX-07/09 follow-up.

Controller may advance this exact candidate through its full-suite/staging/CI/publication gates. Next builder task: **UX-04 historical/forecast detail hierarchy**, preserving sample, weighting, origin, clock, uncertainty and both-occurrence semantics. Retain UX-10 focus/saved-place and UX-07/09 availability-copy follow-ups. No further review experiment is pending for UX-03.
