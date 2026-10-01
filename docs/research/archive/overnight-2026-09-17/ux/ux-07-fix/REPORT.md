# UX07 review corrections — 2026-09-18 03:24 ET

**Tested candidate ready for fresh independent review.** The review's two blocking cases now pass. No publication or independent approval is claimed.

HEAD remains `a401ef5c7fe675e59e0ec0e2b4dbb474ba176b34`; production comparison base is `d5a392f533e8684320259ff0d323a3b0da75cc50`, including the merged ETA walking-caution fix. The index is empty. Exactly two tracked files are modified under services/shuttle-v2: `web/src/TransitMap.tsx` and `scripts/empty-service-check.mjs`.

## Problem and result

A successful fleet poll could automatically remove the focused **Show selected routes** action, dropping keyboard focus to BODY. A stable callback ref now returns focus to the persistent mode control only when the disappearing recovery action owns focus and that mode control remains mounted. Ordinary polls, another focused control, recovery appearing, navigation away, and returning to Map are covered. Existing keyboard/touch click recovery is retained.

Running now uses on-route geometry; reported off-route buses can therefore be filtered out. The empty explanation now says that the selected routes are hidden by Running now. The idle chip title explicitly refers to an **on-route** bus in the last update. With a valid current two-bus off-route snapshot and no forecast rows, recovery still shows **2/2 buses** and **2 buses off route**. Neither filtering nor counts changed.

The original failing evidence is `../review-ux07/boundary-acceptance.json` and independent-review-round-9.md. This round reused that established reproduction, preserved the artifacts, and executed the same reviewer acceptance against the corrected bundle; it did not restart the completed baseline experiment.

## Executed verification

From the worktree root:

```sh
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07-fix/verify.sh
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07-fix/verify-integrity.py
```

- First wrapper attempt: **exit 2**, `verify.log`. The 158 targeted tests passed; frontend typecheck found a missing useCallback import. Added the import; no browser/build run occurred on that incomplete source.
- Final wrapper: **exit 0**, `final-verify.log`. The same 158 targeted tests/six files passed, backend and frontend typechecks passed, Vite compiled 127 modules in 4.76 seconds. No source changes followed this successful run.
- Updated committed built-SPA harness: separate mobile and desktop runs pass eight check groups each. Mobile ran 38 feed requests/14 failures; desktop 38/13. Existing pending/failed/empty/missing/stale/malformed/off-hours, schedules/walking, both #307/#309 arrivals, manual filters, Enter/Space/tap, 44px actions and 360/390/430/1280/640 CSSpx reflow remain covered. Added ordinary-poll focus, empty-poll removal, external focus, recovery appearing, outgoing navigation while recovery retains focus, Map remount/newly running selection, and off-route reports. Reports: `verified/empty-service.json` and `verified/desktop/empty-service.json`.
- Original reviewer acceptance, executed unchanged by the wrapper: **exit 0**, `verified/reviewer-acceptance/boundary-acceptance.json`. Five requests, both prior blocking findings absent; automatic removal focuses BUTTON / Running now, external focus preserved, two off-route bus reports remain counted. Zero page errors; every page/context/browser closed in all three runs.
- Integrity command: **exit 0**, `integrity.log`/`integrity.json`. Preserved HEAD/empty index, exact two-file scope, numerical options and route filter byte-identical to current production, planner/journeyArrival/arrivals/etaSource/liveUpdates/mapFilter/schedule unchanged, poll and AllRoutesMap unchanged from reviewed HEAD, built sourcemap matches candidate, syntax/whitespace pass. All 78 prior builder/reviewer experiment files match their frozen hashes.

Phone and desktop off-route screenshots were visually inspected; text/action fit without page overflow and the map/filter area remains usable. Basemap tiles are intentionally intercepted. The existing missing-forecast update banner remains visible for this no-forecast fixture; successful position counts and filter explanation remain distinct from forecast availability.

## Limits and next action

The synthetic fixtures validate display and interaction, not actual overnight service or ETA accuracy. No native screen reader/physical device/native 200% zoom claim; 640 CSSpx is reflow coverage. Full tests, backend staging/API/browser smoke, CI, integration and deployment verification remain controller gates after fresh independent review. No estimator, ranking, occurrence, wire, history, geometry or service policy change.

All owned command sessions (15494 failed, 85704 passed) ended. No owned server, collector, browser or heavy lock remains. Existing watcher untouched; no dependencies installed, production requests, private feedback/credentials, historical DB access, other-team/controller-file edits or source-control/publication actions. Combined image census at integrity check: 187 files / 8,452,304 bytes, below 100 MiB; prior evidence retained.

Controller: capture this two-file proposal and request a fresh independent review of the corrected callback lifecycle/copy plus the original UX07 availability change. Review with a fresh OUT directory to preserve this evidence. The integrity script intentionally pins the builder HEAD; adapt consciously after capture. After approval, resume UX08 alert/on-board status and recovery. The ETA chosen-pickup occurrence/missing-destination contract and unresolved rapid-map teardown experiment remain separate bounded follow-ups.
