# Keep past-trip context clear and preserve focus when refreshing

Builder proposal, September 18, 2026. Base/HEAD preserved at `e436041a9b4617cbf14ef82c37dc6978f6e7fa3c` (deployed PR284 per controller). No builder commit, branch change, PR, merge or deployment. Independent review and controller publication gates remain.

## Problem and result

Opening arrival details showed the historical median below the graph, exposed the two-day weighting formula in primary content, and put the captured snapshot after the table/method disclosure. Actual phone component evidence is in `before-browser.json` and `before-standing.png`. More materially, keyboard activation of Refresh removed its button while fetching and sent focus to BODY. The baseline run reproduced this with a deliberately pending local response.

`ArrivalHistory.tsx` now places the captured snapshot and a plain “Typical past trip” summary above the plot. Origin → target and standing-versus-departure context remain prominent. Sample count, distinct date count and starting-date range are visible together. “About these records” retains the exact median, two-day half-life, effective-five-trip threshold, selection limits and caveats. Sparse weighted evidence explicitly lacks a typical-time summary. Dates use the same trip-start/New Haven basis as the server's service-date count; detailed record/capture times retain their existing device-local display, explained under the disclosure.

The Refresh button stays mounted during a request, retains focus, exposes aria-disabled and ignores repeat activation. Loading has status semantics and failures have alert semantics. A failure can be retried without losing the surrounding live ETA/following-arrival information. No new polling or automatic refresh was added.

No estimator, server, planner, arrival calculation, sample selection, validation, weight, summary threshold, plot geometry, endpoint clock, occurrence, or forecast-value change. A 30-second historical trip and a 45-minute trip remain in both graph and table. Filled forecast dots remain separately disclosed from hollow observations. No accuracy, calibrated probability, nominal coverage or causal driver-behavior claim.

## Files

- `services/shuttle-v2/web/src/ArrivalHistory.tsx`: presentation and refresh accessibility.
- `services/shuttle-v2/scripts/arrival-history-check.mjs`: bounded regression using actual ArrivalDetails, ArrivalHistory and ArrivalPlot components, fabricated history responses and current display helpers. No server/watcher or collector launched.
- `docs/server-side-eta.md`: existing history summary/focus behavior and effective weighted threshold documented.

## Verification

Run commands from the service directory unless otherwise noted. All heavy runs used `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock` around the complete command/script.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-04 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/arrival-history-check.mjs --baseline` — exit0. Baseline recorded BODY focus while refresh pending, primary formula and low snapshot placement. Existing graph/table/disclosure/reflow behavior passed. `baseline.log`, `before-browser.json`, screenshot.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-04/verify.sh` — first/final source gates exit0 in `first-verify.log` and `final-verify.log`: 26 tests (historyRecency4, ArrivalPlot2, arrivalDetails4, journeyHistory16), backend and frontend typechecks, Vite build, mobile and desktop component browser checks.
3. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-04/extended flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/arrival-history-check.mjs` — exit0, `extended-browser-corrected.log`. Added timeout recovery, old-request/new-bus race, one/100/effective-sparse sample cases and scrolled screenshots. Formula/summary source unchanged for that pass.
4. Same locked `verify.sh` after aligning date range to the server's start/New Haven dates — **exit0**, 26 tests, both typechecks, Vite build and final mobile/desktop matrices in `date-verify.log`; adds a midnight-crossing fixture. This is the authoritative final gate, along with main `after-browser.json` and `desktop/after-browser.json`.
5. Repository-root `git diff --check`, `git diff --cached --exit-code`, `node --check services/shuttle-v2/scripts/arrival-history-check.mjs` and HEAD/status inspection: final results recorded in PROGRESS/CHECKPOINT.

For independent review use a fresh output directory, e.g. `OUT=<review-directory> flock -w 900 .../heavy.lock bash .../ux/ux-04/verify.sh`. The script now honors OUT; default reproduces builder output. For browser only, `OUT=<review-directory> node scripts/arrival-history-check.mjs` under the same lock; add `DESKTOP=1` for actual desktop context. Dependencies already existed separately in this checkout.

Browser checks cover native dialog keyboard open/close and restored focus; Enter/Space disclosures; actual mobile tap open; 360/390/430px phone, 1280px desktop and 640 CSS-pixel equivalent desktop 200% reflow; 44px actions; loading/HTTP503/malformed/timeout/retry; short/long observations; 1/2/8/100 observations and a dominant-recent-observation case with effective evidence below five; no duplicate same-date range; midnight starts versus next-day arrivals; old labeled snapshot retained as a snapshot; ETA ticks do not refetch; delayed old-bus response cannot replace the newer bus's comparison; following shuttle, same-bus next lap, missing following estimate and bounds-only forecast fallback. No page errors. The original filter/matching behavior is covered by unchanged server tests, not by claiming fabricated browser records are a historical replay.

All requests intercepted, tester identity seeded before navigation, and every owned page/context/browser closes (browser finally covers failures). No production feedback/DB, private data, credentials, watcher or other team's files accessed for mutation. No persistent process or staging8093 needed.

## Harness failures and limits

Two command setup mistakes are retained: initial file creation used a repo-relative path while cwd was v2 and failed before writing; one supplemental invocation ran a v2-relative script from repo root (`extended-browser.log`, MODULE_NOT_FOUND). Correcting command cwd fixed both. There was no application/test assertion failure in completed browser runs. The 100-trip dominant-evidence fixture's metadata was corrected to two dates when its dates were reassigned; no app code was changed for that setup correction.

This bundles real components with esbuild and opens their real modal in Chromium, but does not exercise the full SPA/server/staging stack. Vite build is a separate production-bundle gate. Tests do not establish real API cohort quality, ETA accuracy or live route availability. Stale history means a clearly dated snapshot here; full-shell stale-feed suppression remains owned by its existing logic and was not recertified. No physical phone, external screen reader or native browser zoom tested; 640px is equivalent reflow. 100 historical dots remain noninteractive with a keyboard-accessible data table; no claim that hover titles alone are mobile interaction.

Review focus: numeric/clock semantics remain unchanged; historical summary stays distinct from forecast; service-start date range matches serviceDates; refresh focus survives pending/error/success without trapping focus or permitting duplicate requests. Adjacent full-shell history entry/access and assistive-technology output are useful independent checks if budget permits.

Next bounded task after acceptance: UX-05 minimap attribution/overlap fixtures. Retain UX-07/09 failed-feed copy and UX-10 existing editor/saved-place follow-ups. Do not restart completed UX-01/02/03 experiments.
