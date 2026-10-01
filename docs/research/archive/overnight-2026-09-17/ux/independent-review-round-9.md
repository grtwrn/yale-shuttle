# Independent review — UX07 snapshot availability and filter recovery

Controller round 8; ninth UX review artifact. Reviewed September 18, 2026, 03:09–03:16 ET. **Verdict: changes_requested. Two bounded UI corrections are required.**

Exact HEAD: `a401ef5c7fe675e59e0ec0e2b4dbb474ba176b34`.
Exact supplied base and merge-base: `d5a392f533e8684320259ff0d323a3b0da75cc50`.
HEAD is a merge with parents `97b754165138b15342e3758ef342af1dbb749b1b` and the supplied base. The committed diff contains exactly `web/src/TransitMap.tsx` and `scripts/empty-service-check.mjs` under services/shuttle-v2. Checkout and index were clean on entry and remain unchanged. No source fix, branch/commit/index mutation, GitHub operation, publication or deployment was performed.

## Required corrections

### P2 — Preserve focus when polling removes the new recovery control

`services/shuttle-v2/web/src/TransitMap.tsx:8048` (handler through line 8055).

The new button restores focus only inside its click handler. Its surrounding conditional also disappears automatically when a fresh poll changes `mapDrawnHidden`. Independently reproduced on the built SPA: start with two Red buses, select only Blue Day under Running now, focus **Show selected routes**, then receive a successful empty fleet. The fallback correctly reveals the Blue Day card, but `document.activeElement` becomes `BODY`; the persistent mode button does not receive focus. The rider can lose their keyboard position on an ordinary five-second poll before activating recovery. This is a new interactive-control lifecycle, not a request to change the existing filter.

Restore focus to the persistent map mode control when the recovery button is removed **only if that button still owns focus**. Preserve external focus and avoid focusing an outgoing view on navigation/unmount. The existing TripBoardingActions guarded callback-ref pattern is a useful local reference; the builder should choose and independently verify the appropriate implementation. Extend the committed browser regression to cover automatic disappearance, ordinary polls, external focus and the already passing click/touch paths.

Evidence: `review-ux07/boundary-acceptance.json` → `automaticRecovery.focus.tag = BODY`, `modeFocused = false`. The external-focus control keeps focus on Issues (`externalFocusPreserved = true`). The exploratory lifecycle run independently observed the same focus loss.

### P2 — Describe the Running now filter without falsely denying received buses

`services/shuttle-v2/web/src/TransitMap.tsx:8046`, with the same assumption in the changed chip title at line 7965.

The empty-state condition uses `runningToggles`, which requires an **on-route** bus; it does not test whether any bus reported that route. In a fresh response with two Red buses outside Red's geometry, selecting Red produces “No buses are reporting on your selected routes.” The Red chip title says it “has no bus in the last update.” Activating Show selected routes immediately reveals the unchanged, correct card: **2/2 buses** and **29 stops · 2 buses off route**. Thus the new reporting statement contradicts the same response and confuses route filtering with feed absence.

Keep the existing geometry, visibility algorithm and counts. Use wording that describes the Running now filter/on-route condition, or distinguish truly absent selected-route reports from off-route reports using existing state. Update the chip title consistently. Add a valid current off-route position snapshot with no forecast rows to the browser checks; do not invent forecasts or change the ETA filter to satisfy the copy.

Evidence: `review-ux07/boundary-acceptance.json` → `offRoute.filteredText`, `chipTitle`, `recoveredCard`; visually checked `off-route-filtered.png`. The predicate and its geometric behavior are pre-existing; this finding concerns the new categorical “reporting / last update” wording attached to that predicate. Both contradictory strings are in the candidate diff.

## What is supported

The main change is useful. Pending first load, failed initial load, successful empty results, and interrupted retained snapshots are distinguishable. Fresh positions retain their counts when only forecast rows fail. Cached notices are qualified, schedules/walking stay available, and fresh recovery restores both upcoming buses. Explicit filter actions recover the intended selection, have measured 44px targets and appropriate pressed state, preserve manual route choices and restore focus when activated. Mobile/desktop reflow and keyboard/touch checks pass.

The complete live numerical options memo equals the current production base, SHA256 `c897c8084a4172ec4bb99f0d1e8e65a6502f5290d282b32e3ef3bc2cb3fe4db9`. Planner, journeyArrival, arrivals, etaSource, liveUpdates, mapFilter and schedule are byte-identical to that base. The AllRoutesMap implementation and shared filter decision are unchanged. Poll validation, sequencing, stale ETA attachment and numerical updates are unchanged except for the added position-snapshot presentation flag. The freshly built bundle's TransitMap sourcemap exactly matches committed HEAD. The merged ETA walking-caution correction remains in the comparator and candidate; the builder's older 373505d baseline is not used as today's numerical comparator.

No model coefficient, feature/label timing, forecast occurrence, cap, sample exclusion, route ranking, historical weighting or uncertainty quantity changes. No accuracy, normality, on-time probability or interval-coverage claim is introduced. Transport/restart/closure tests pass; frontend-only additions introduce no server runtime dependency.

## Independently executed commands

All heavy commands held `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock` for their full duration. Outputs are new reviewer artifacts; prior evidence is preserved.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/verify.sh` — **exit 0**, `review-ux07/verify.log`.
   - 158 tests / six files: liveUpdates, mapFilter, etaSource, schedule, announcements, routeThumb.
   - Backend and frontend typechecks pass. Vite build passes, 127 modules, 4.92 seconds.
   - Separate mobile and desktop unmodified built-SPA suites pass. Each executes 28 feed requests, with 14 failures in mobile and 13 in desktop; no browser page errors; all browser resources close.
   - Checks initial pending/failure, valid empty, failed-after-empty, missing/stale ETA, malformed response, failure beyond freshness expiry, fresh recovery, cached notices, schedule/walk fallback, both #307/#309 pickup slots, off-hours, single empty message, both recovery buttons, manual choices, Enter/Space/touch/focus/44px and 360/390/430/1280/640 CSSpx reflow. Reviewer visually inspected the phone recovery and desktop off-hours screenshots.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07/extra.sh` — **exit 0**, `extra.log`.
   - Runs `npm test -- src/server/serverEta.test.ts src/server/serverEta.closure.test.ts web/src/journeyArrival.test.ts web/src/arriveByMessage.test.ts`: 52 tests / four files pass, including checkpoint recovery/expiry, Docker runtime closure and deadline-state distinctions.
   - Runs reviewer-authored `review-lifecycle.mjs` on the same bundle. Stalled requests (without HTTP failure) expire at 45 seconds, successful empty/nonempty recovery works, manually hidden routes survive reload, keyboard activation places focus on the mode control and subsequent Tab enters restored cards, and recovery survives storage-write failure. No page errors; resources closed. This exploratory run records the two issues above instead of asserting they pass.
3. From services/shuttle-v2: `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07/boundary-acceptance.mjs` — **exit 1**, `boundary-acceptance.log`.
   - Focused reviewer acceptance test executes both cases, captures the external-focus control, then fails with precisely the two recorded findings. Five feed requests; no page errors; all browser resources closed. `completed: true` means every case executed, not that acceptance passed. Uses current off-route positions with no forecast, avoiding the exploratory run's initially inconsistent off-route/valid-forecast fixture.
4. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07/verify-integrity.py` — **exit 0**, `integrity.log`/`integrity.json`.
   - Exact head/base/parents, committed source hashes, unchanged numerical/filter/poll invariants, generated sourcemap, frozen builder baseline, all 37 hashed prior artifacts, clean checkout/index, candidate whitespace and all browser-script syntax checked.

**210 selected unit tests, both typechecks, build and standard browser suites pass. Two independently executed boundary acceptance assertions fail.** No reviewer application edit was made. Full suite, complete backend staging/API/browser smoke, CI and deployment remain controller gates after corrections and fresh review.

## Scope and handoff

Read current v2 CLAUDE guidance, handoff/first task/backlog/current progress/checkpoint/requests and previous UX review, along with ETA progress/requests through 03:02. Read current Red release and follower/identity research context; no experimental model finding is promoted here. Prior review corrections are retained in the exact merged baseline and scoped integrity checks.

The unresolved rapid Leaflet teardown/fake-clock event remains the builder's disclosed separate follow-up; this review does not call it proved pre-existing or introduced. Actual map implementation is unchanged. No new baseline experiment was restarted. Native screen reader, physical device and native 200% zoom are not certified; 640 CSSpx is a reflow check. Browser fixtures are synthetic, fully intercepted and use seedTestId. They do not demonstrate actual overnight service or ETA accuracy.

Owned command sessions 35198, 40090 and 35823 completed. Every owned page/context/browser closed; no server, collector or persistent browser was launched; no lock remains held. No dependency installation, watcher modification, historical DB/private feedback/credential access, other-team file mutation or controller-state mutation. Combined image census at integrity check: 178 images / 8,046,753 bytes, below 100 MiB; prior evidence preserved.

Next builder slice: correct only the two filter-recovery presentation/lifecycle issues, add both cases to the committed regression harness, preserve numerical/shared-filter semantics, then request fresh independent review. Continue UX08 and the same-bus pickup-occurrence contract separately after this correction. No production authorization follows from this review.
