# Independent review — UX-04 historical detail and refresh

Reviewed September 18, 2026, 00:30–00:38 ET (controller round 4; fifth UX review artifact). **Verdict: approve. No blocking findings.**

Exact base: `e436041a9b4617cbf14ef82c37dc6978f6e7fa3c`.
Exact candidate HEAD: `288b2955ab8b4bf603d05e320c0901bd837400e6`.
HEAD, parent and merge-base independently match the supplied values. Tracked worktree and index were clean at entry and after verification. No tracked source, commit, branch, controller state, GitHub or publication operation was changed by this reviewer.

## Supported outcome

The complete diff contains `web/src/ArrivalHistory.tsx`, `scripts/arrival-history-check.mjs` and `docs/server-side-eta.md` under their authorized v2/docs locations. No existing test is weakened, dependency added or runtime import changed.

The capture timestamp, matched origin/target, standing-versus-departure explanation, weighted historical summary, sample count and date range appear before the historical graph. “Typical past trip” remains explicitly labeled historical, with the exact recency-weighted median, two-day half-life and effective-five-trip threshold explained in the existing method disclosure. The new range uses minimum/maximum `startedAt` in America/New_York, matching the server's `serviceDates` definition. Detailed/capture times retain their existing device-local format, with that distinction explained. Sparse weighted evidence does not receive a typical-time number.

The existing fetch key, timeout, abortion/active guard and explicit refresh behavior are unchanged. Keeping Refresh mounted fixes its former disappearance while a request is pending. Its aria-disabled state is backed by an activation guard, so it remains keyboard-focusable without issuing repeat requests. Loading and failures expose status/alert semantics. Refresh succeeds and recovers from network failure without removing the surrounding shuttle/following-arrival information. No new polling is introduced.

Independent execution of the candidate component harness covers standing/departure, 1/2/8/100 records, effective-sparse evidence, short/long observations, midnight date boundaries, old snapshots, unavailable/unmatched/empty/malformed/HTTP-error/timeout/retry states, an older request finishing after the bus changes, both arrival identities and same-bus next-lap presentation. Enter/Space/Escape, native dialog focus, mobile tap, 44px controls and 360/390/430/1280/640 CSS-pixel reflow pass in separate mobile and desktop contexts.

The reviewer-authored `review-ux04/shell-history.mjs` exercises the newly built, unmodified SPA with fabricated wire/history responses. It establishes integration beyond the component harness:

- The actual trip-card arrival action lazily requests Red/#307 pickup history at stop48 with limit100 and retains following shuttle #309. No history request occurs before opening details.
- With the device in Pacific/Honolulu, the range remains Sep16–Sep17 in New Haven while table starts display Sep15–Sep16 and capture time displays 8am. The method explains the different clock bases. All eight fixture observations, including30seconds and60minutes, remain visible in graph/table.
- Space activation preserves Refresh focus and does not generate a second pending request. Moving focus to Close before completion prevents focus stealing. Aborted-network error and keyboard retry keep both arrival identities; Escape returns focus to the actual trip-card action.
- The class-arrival disclosure requests the actual selected alight stop121 for #307, distinguishes history ending before the final walk, preserves inline refresh focus, aborts on disclosure close and loads a new snapshot on reopen. Full-page reflow passes at all five widths.

I visually inspected this review's component history screenshot and corrected full-SPA phone screenshot. Primary history text is readable, long origin/target names wrap, the graph keeps its full range, and the record table remains reachable by keyboard. Each final browser report has zero page errors.

Source inspection confirms no estimator, weighting, summary threshold, validation, sample/identity/occurrence selection, transport, planner ranking, deadline calculation or forecast-value change. The weighted median helper, history reader and plot geometry are byte-unchanged. No arbitrary cap, outlier removal, fitted coefficient, on-time percentage, nominal coverage or causal driver claim is introduced. Both occurrences, stale transport, restart behavior and Docker runtime closure remain covered by independent targeted tests. This is a history readability/interaction improvement, not an accuracy or calibration result.

The handoff/backlog/first task, current progress/checkpoint/requests and prior UX reviews/current REVIEW were inspected alongside builder evidence, current v2 guidance, history/server contracts and Red/follower research notes. The prior supporting-route correction is present in `ArriveBy` and the previous search/feedback changes remain in the exact base, untouched here. Completed baseline experiments were not restarted. ETA progress/requests through00:29 identify a separate pooling-occurrence defect for ETA repair; this UX candidate neither changes that arithmetic nor claims to resolve it. No cross-team numerical/interface change is requested.

## Independently executed checks

Service cwd: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux04 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-04/verify.sh` — **exit0**, `review-ux04/verify.log`. The inspected checked script holds the shared lock over:
   - `npm test -- web/src/historyRecency.test.ts web/src/ArrivalPlot.test.ts web/src/arrivalDetails.test.ts src/server/journeyHistory.test.ts`: **26 tests in four files passed**.
   - `npm run typecheck`: backend and frontend passed.
   - `(cd web && npx vite build)`: **124 modules,4.77seconds, passed**.
   - `OUT=<review-ux04> node scripts/arrival-history-check.mjs` and `DESKTOP=1 OUT=<review-ux04/desktop> node scripts/arrival-history-check.mjs`: mobile/desktop passed; output is separate from builder evidence.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux04/shell-history.mjs` — **exit0**, both `shell-history-first.log` and `shell-history-final.log`. Final authoritative evidence: `shell-history.json` and `shell-history-honolulu-corrected-390.png`. Reviewer script syntax check passed before execution.
3. `npm test -- src/server/serverEta.test.ts src/server/serverEta.closure.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts` — **exit0**, **54 tests in four files passed**, `transport-tests.log`. Covers repeated occurrences, stale/malformed distributions, checkpoint restoration/rejection/failure and browser-free Docker import closure. Light targeted tests; no full suite or model fit.
4. `npm test -- src/server/app.test.ts -t 'public arrival history'` — **exit0**, **2 tests passed;108 unrelated tests skipped**, `api-tests.log`. Endpoint validation, explicit100 limit, no-store response and no-live-origin response pass. Skipped cases are not counted as coverage.
5. From repo root, `git diff --check e436041a9b4617cbf14ef82c37dc6978f6e7fa3c 288b2955ab8b4bf603d05e320c0901bd837400e6` and `node --check services/shuttle-v2/scripts/arrival-history-check.mjs` — **exit0**.
6. `git rev-parse HEAD`, `git rev-parse HEAD^`, `git merge-base e436041a9b4617cbf14ef82c37dc6978f6e7fa3c HEAD`, `git diff --exit-code`, `git diff --cached --exit-code`, `git status --porcelain=v1` — **exit0**, exact head/base above, empty worktree/index/status.

**82 selected tests passed**, both typechecks, production build and the component/full-SPA browser checks passed independently. No candidate application/test assertion failed.

Reviewer setup corrections: a read-only exploratory Node probe assumed the historical network fixture contained `buses`; it does not, so that probe threw before any browser or edit. The supplemental script explicitly creates its fleet. Its first passing synthetic history also reused the pickup stop as the source and gave the stored draft a mismatching stop name. These fixture names/IDs were corrected to the preceding route stop and real endpoint names; both passing logs, first JSON/screenshot and final corrected evidence are preserved. No application source was changed to obtain a pass. The script's fabricated midnight records deliberately test timezone presentation; they are not a cohort-quality or real historical-match validation.

## Limits and continuation

Controller retains full-suite, complete backend staging/API/browser-smoke, CI, merge and deployment verification. This reviewer did not execute or claim those gates. Browser network is fully intercepted and seeded with the tester identity; there is no production/private-feedback/DB traffic or analytic contamination. No live service is inferred from fixtures, and overnight Red being off is not treated as a fault.

640 CSS pixels is equivalent reflow, not native browser zoom. No physical phone or native assistive-technology announcement was tested; verified status/alert roles and keyboard actions are the evidence. Existing unmatched/old-snapshot behavior is preserved rather than certified as a complete cohort-quality audit. All historical/forecast numerical claims remain the existing descriptive/model semantics.

Every owned browser/context/page closed, all command sessions exited and locks released. No persistent server/collector/watcher was started or modified. No dependency installation or other-team mutation. Existing evidence preserved; combined team screenshots are **85files /4,107,496bytes**, below100MiB. No further review experiment is pending.

Controller may advance this exact candidate through its publication gates. Next builder: **UX-05 minimap bus/wait-label attribution and overlaps**, while retaining UX-07/09 missing-feed wording and UX-10 editor/saved-place follow-ups. Any pooling-occurrence numerical repair stays with ETA and its own validation.
