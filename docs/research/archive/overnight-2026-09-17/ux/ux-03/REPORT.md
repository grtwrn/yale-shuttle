# UX-03 — Feedback and reply accessibility/recovery

Builder round 3, September17–18,2026 ET. Base/HEAD `cff3b2a6b7ad6cdd2f899bb4d564a4c03dae2d37` (deployed PR283), branch preserved. Independent review and controller publication remain required.

## Reproduced rider problem

A failed footer-feedback submission left its composer and draft open, but its error was rendered only in the closed footer. The rider saw no failure or recovery instruction. Browser baseline `before-browser.json` records `feedbackErrorVisible:false` after an intercepted503. Its screenshot preserves the silent failure.

Tab skipped both screenshot actions because each was a label containing a hidden file input. Both textareas were named only by their placeholders; feedback priorities were36px high with no programmatic selected state. Baseline focus after priorities and after reply text was Cancel. A mocked429 reply showed useful rate-limit text, but it was not an alert.

## Proposal

- Feedback errors remain visible beside the unchanged draft, announced as alerts until retry/cancel. Sending/success are separate polite status messages, with success available after the composer closes.
- Textareas have explicit associated labels. Priorities expose their selected state within a named group and have44px targets; feedback Send/Cancel also reach44px. Issue priority has a stable name and16px type.
- Real buttons activate the existing hidden file pickers from keyboard or touch. Existing image decoding, limits and paste/drop paths are preserved. Buttons remain focusable during processing with guarded activation and `aria-disabled`; processing is announced. Replace/remove are named actions and removal returns focus to the picker.
- Closing/canceling/success returns focus to the relevant feedback/Reply button only when focus belonged to the removed composer and has not moved to another control. Reply restoration waits until its post-send refresh has finished and its button is enabled.
- Issues load/action/image errors and loading/empty/action status are announced. Archived disclosure exposes its expanded state. Opening a different reply clears the prior completed attachment/error alongside its draft.

Only `web/src/TransitMap.tsx`, `web/src/IssuesPanel.tsx`, and bounded `scripts/feedback-accessibility-check.mjs` change. No server/report wire/identity/storage/ETA/planner/route/occurrence/history changes. All form submissions are fixtures intercepted at `https://shuttle.test`; no production feedback or private reports were accessed.

## Evidence and failure history

`baseline.log` / `before-browser.json` are the original built-SPA evidence; first basic `first-verify.log` passed40 existing tests, types/build and before/after browser checks. Extended testing found and corrected candidate focus issues instead of treating field names alone as keyboard verification:

1. A guessed Remove screenshot locator matched only a title in feedback; added the explicit accessible name shared with reply removal.
2. A successful reply tried to restore focus while Reply remained disabled during refresh. Capturing focus ownership before disabling Send and waiting for the enabled render corrects it (`reply-focus-failure.json`, `extended-browser-4/5/6.log`).
3. Disabling the attachment button during decoding lost keyboard focus (`attachment-focus-failure.json`). Keeping it focusable with guarded `aria-disabled` corrected this (`attachment-focus-fix.log`). Earlier fast native chooser activation timed out in two runs; the harness now uses focused locator key presses with60ms keydown/up and asserts focus/activation state. Both Enter and Space are exercised; failures are retained.
4. Two harness invocations used the wrong cwd; one prevented a intended test edit and the next repeated the existing failure, one exited before browser launch. Those are harness setup failures, not app results. Correct command cwd is the v2 service.

Final exact commands/results are appended below after final verification. `verify.sh` is the checked one-lock reproduction script. Browser pages, contexts and browsers close in `finally`; no server, collector or persistent watcher starts. No dependency installation.

## Browser coverage and boundaries

Actual built SPA, existing tester identity helper, all external network blocked. Mocked empty fleet is only a shell fixture; it does not assert Red should run overnight. Mobile360/390/430px, desktop1280px,640 CSS-pixel reflow equivalent to200% desktop layout. Names/roles and keyboard focus are inspected in Chromium; no native screen-reader, physical phone, native chooser OS UI or native zoom claim. Playwright observes native filechooser events and supplies fixture files.

Cases: keyboard opening, Tab to attachment, Enter/Space picker, unreadable image and recovery, replacement/canceled selection/removal, selected priority,44px controls/16px fields, no horizontal page overflow; feedback503 with retained text and successful submit payload; sending/success, reset, Cancel and navigation focus non-stealing. Reply429 then503 preserve text/image; success threads the follow-up, closes composer and restores enabled Reply focus; Cancel and navigation focus ownership. Issues loading, failed fetch, keyboard retry and empty state; named priority and archived keyboard disclosure. Browser fixture submissions never leave the process.

Paste/drop conversion logic is unchanged and covered by the existing screenshot unit tests; this round does not claim an OS clipboard integration test. Cancellation or changing reports during an in-flight send/image decode, stale parallel report fetches, and blocked-storage browser behavior are not exhaustively audited here; do not claim all asynchronous composer paths fixed. Existing explicit Cancel behavior is retained. Full suite and complete staging/browser-smoke remain controller/CI gates.

## Independent review focus

Review visible-error persistence and retained draft, filechooser keyboard continuity, focus ownership after async send/refresh and before/after disabling, named priorities/labels and exact report association. Reproduce with a fresh OUT directory or a copy of verify.sh to preserve builder evidence. Next coherent builder task after review: UX-04 historical-versus-forecast detail hierarchy using existing sample/clock semantics; retain UX-10 saved-place/focus follow-ups and UX-07/09 unavailable-feed copy finding.

## Final executed verification — September18,00:02 ET

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-03/verify.sh` — **exit0**, `final-verify.log`. Script runs from v2: `npm test -- web/src/myReports.test.ts web/src/screenshot.test.ts` (40/40), `npm run typecheck` (backend/frontend), `(cd web && npx vite build)` (124 modules), then the built-SPA browser harness in separate mobile and actual desktop contexts. Both browser runs completed with no page errors. Final app source is unchanged after these gates.
2. From v2: `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-03 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/feedback-accessibility-check.mjs` — **exit0**, `touch-final.log`. Final browser-only addition verifies actual mobile taps to open, select priority, activate native chooser and Cancel. Final mobile JSON is `after-browser.json`; desktop JSON is `desktop/after-browser.json`. No app source change after full gates.
3. `node --check services/shuttle-v2/scripts/feedback-accessibility-check.mjs` and `git diff --check` — **exit0**. `git diff --cached --exit-code` is empty; HEAD remains `cff3b2a6b7ad6cdd2f899bb4d564a4c03dae2d37`.

Phone feedback/error/attachment, reply/error/attachment and desktop screenshots visually inspected. Total screenshot evidence across both teams: **57 files / 2702127 bytes**, well below100MiB, with earlier evidence preserved. All command sessions collected, browser resources closed, no server/watcher launched or modified and no lock retained. No commit/branch/PR/merge/deployment/controller-state change. **Tested candidate ready for independent review**, not an independent approval or deployment claim.
