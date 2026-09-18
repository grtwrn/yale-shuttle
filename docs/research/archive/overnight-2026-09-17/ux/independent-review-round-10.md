# Independent review 10 — UX07 corrected availability and map recovery

Reviewed September 18, 2026, 03:27–03:32 ET. **Verdict: approve. No blocking findings.** This is the fresh review following independent-review-round-9.md, on controller round 8's captured correction.

Exact HEAD: `b8228f443e1d7a0a6a1e3fc3ade4346e20fe0b91`.
Exact supplied base and merge-base: `d5a392f533e8684320259ff0d323a3b0da75cc50`.
Parent: `a401ef5c7fe675e59e0ec0e2b4dbb474ba176b34`, the previously reviewed candidate.

The entire two-file candidate diff against the supplied production base was inspected, as well as the correction against its parent. Only services/shuttle-v2/web/src/TransitMap.tsx and scripts/empty-service-check.mjs differ from the base. HEAD, tracked checkout and index were clean on entry and remain unchanged. No application fix or source-control operation was performed by this reviewer.

## Both prior blockers are resolved

1. The stable callback ref restores focus before removal only when the disappearing recovery action owns focus and the mode control is still connected. The original reviewer acceptance now observes BUTTON / Running now after an empty fleet removes Show selected routes; external focus remains on Issues. The committed browser checks also cover ordinary polls, recovery appearing, programmatic navigation while the departing action retains focus, Map remount, and a newly reporting selected route. My additional browser check exercises unchanged fleet size with off-route buses moving back onto the selected route: removal restores mode focus; the action's subsequent return does not steal it. Enter, Space and touch activation retain their existing recovery behavior.
2. The selected-route message now describes the Running now filter rather than claiming no buses reported. The idle chip explicitly says no **on-route** bus in the last update. The original valid off-route/no-forecast fixture now shows that explanation, then correctly reveals 2/2 buses and 2 buses off route after recovery. No geometry/filter/count policy was changed or forecast fabricated to make the copy pass.

The correction is exactly the builder's recorded proposal.patch, and its committed source hashes match the successfully tested builder hashes. The added tests retain the earlier acceptance paths and add the reviewed transitions; no material assertion was weakened.

## Supported rider improvement and scope

Initial loading, failed initial feed, successful empty feed, and interrupted retained snapshots now have distinct wording. Fresh bus positions can retain their counts when only forecasts are unavailable. Cached notices are qualified; route schedules and walking remain usable. Both pickup slots (#307 and #309) survive fresh recovery. The shared map filter remains authoritative; Show selected routes preserves manually hidden lines, and Show all routes clears hiding and the Running now mode together. Recovery controls meet the measured 44px target; mode pressed state is exposed. Phone and desktop screenshots were visually checked, including the off-route explanation and off-hours route cards.

The complete numerical options memo equals current production base (SHA256 c897c8084a4172ec4bb99f0d1e8e65a6502f5290d282b32e3ef3bc2cb3fe4db9). The route-filter block, AllRoutesMap implementation, planner, journeyArrival, arrivals, etaSource, liveUpdates, mapFilter and schedule remain identical to that base. Polling differs only by added snapshot presentation bookkeeping; validation, sequencing, ETA attachment and freshness policy are preserved. The generated TransitMap sourcemap exactly matches committed HEAD. The merged ETA walking-caution fix is part of this comparator and remains intact.

No model, feature timing, coefficient, forecast occurrence, interval, cap, sample selection, historical weighting, route ranking or statistical accuracy claim changes. The follower research remains exploratory and score-dependent; this approval promotes none of it. Repeated-visit transport, server parity, restart/checkpoint behavior, current-release fixture, class-deadline distinctions and Docker import closure are covered by the independently run full suite.

## Independently executed commands and results

All heavy work held the shared heavy.lock for the entire command. Every output below is in the fresh review-ux07-fix directory; original builder and failed-review evidence is preserved.

1. From the worktree root:

   `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07-fix flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07-fix/verify.sh`

   **Exit 0**, verify.log. 158 tests / six files, backend and frontend typechecks, Vite build (127 modules, 4.88 sec), separate mobile and desktop built-SPA suites, and the unchanged original reviewer boundary acceptance all pass. Mobile/desktop each execute 38 feed requests (14/13 intentional HTTP failures); original acceptance executes five. No page errors; all resources closed.

   Browser coverage includes pending/failed/empty/malformed/missing/stale/off-hours, failure past the 45sec freshness window, schedule/walking fallback, both pickup slots, cached notices, manual filters, Enter/Space/touch, guarded focus, navigation/remount, 44px controls and 360/390/430/1280/640 CSSpx reflow. Original acceptance JSON contains an empty blockingFindings array and modeFocused/externalFocusPreserved both true.

2. From the worktree root:

   `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07-fix/extra.sh`

   **Exit 0**, extra.log. Runs `npm test` from services/shuttle-v2: **2,780 tests / 129 files pass**, 48.51 seconds. This includes the 158 tests above; do not add them as distinct tests. Then runs reviewer-authored review-lifecycle.mjs (adapted from the prior reviewed lifecycle harness, with valid no-forecast off-route data and new geometry/focus assertions). Five check groups / 29 feed requests pass: initial and retained hanging requests expire correctly; empty/nonempty recovery works; hidden-route choices survive reload; keyboard recovery then Tab advances into the restored Blue Day card; same-fleet off-route/on-route focus behavior passes; runtime storage-write failure does not break recovery. No page errors, all resources closed.

3. From the worktree root:

   `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07-fix/verify-integrity.py`

   **Exit 0**, integrity.log / integrity.json. Verifies exact head/base/parent, clean tracked checkout/index, committed blobs, correction patch and builder source hashes, unchanged numerical/filter/poll invariants, built sourcemap, syntax/whitespace and all **101** prior builder/reviewer experiment files. Combined team image census: 196 images / 8,857,836 bytes, below 100 MiB.

No test or browser failure occurred in this review. One optional read of a nonexistent vitest.config.ts returned exit 1; file discovery confirmed no such config. This was not a test failure and no configuration was changed.

## Limits and handoff

Synthetic intercepted fixtures validate display/interaction, not actual overnight service or ETA accuracy. No native screen reader, physical-device or native 200% zoom certification; 640 CSSpx is reflow coverage. The unmodified missing-forecast banner can still accompany fresh position counts. Backend staging/API smoke, CI, serialized integration/merge and deployment verification remain controller responsibilities; this reviewer performed no publication.

Keep the prior unresolved rapid-map teardown stress case separate: the map implementation is unchanged and this review does not infer that stress case's origin. The same-bus later pickup/missing-destination identity contract is also separate; latest ETA progress/requests through 03:20 were read and do not overlap this correction. No completed baseline experiment was restarted.

Read current v2 CLAUDE guidance, team handoff/backlog/first task/current progress/checkpoint/requests and prior review, other-team progress/requests, current Red release and follower progress/identity context. No other-team, controller, protected marker, schema or lock file was edited. No production/private feedback/credential/historical DB access, dependency installation or watcher modification occurred. Sessions 46746 and 47386 completed, every owned browser/page/context closed, and no owned server, collector or heavy lock remains.

Controller can advance this exact candidate through remaining integration/staging/CI/publication gates. Next builder work is UX08 alert/on-board status and recovery; coordinate the pickup bus/occurrence contract separately with ETA.
