# Keep get-off prompts current and preserve ride recovery focus

Builder completed September 18, 2026, 04:39 ET. **Candidate ready for independent review.** Base and preserved HEAD: `7f681d92a7d30331728d637216dabecf9d9e356c` (the preceding combined pickup candidate approved in independent-review-round-12.md). No commit, branch/index change or publication by this role. The controller's older REVIEW.json was preserved; this work has no independent approval yet.

## Reproduced problem and result

In the actual built SPA, an open get-off prompt advanced correctly through two stops, next stop and here, but then reverted to its original **Get off in 2 stops** when the live stop position became unavailable. This happened for stale and missing forecasts, an empty bus feed, and a new position five stops away. A failed poll that expired the retained track similarly kept an obsolete **Get off at the next stop** instruction. The background already warned that updates were interrupted; the foreground instruction contradicted that warning.

The existing notification trigger remains unchanged. An already-open prompt now reads current stop evidence: unavailable position produces **Live stop position unavailable**, with the route, bus, exit and a brief stop-sign reminder; a valid position farther away says how many stops remain. Fresh evidence restores the appropriate instruction without another notification. The description is associated with the dialog, and meaningful title changes use a polite live region.

The browser also reproduced keyboard focus landing on BODY after dismissing an automatically opened restored-ride prompt and after Done. Closing the prompt now falls back to the persistent Done button if there is no original focus target, while preserving focus deliberately moved outside. Ending the ride focuses the existing Finish your trip section when the disappearing ride controls lost focus. Dismiss returns to the selected view; Find another shuttle returns to Trip after preparing the existing recovery flow. Automatic endings preserve focus on surviving controls. Final walking coordinates and origin-free directions remain intact.

## Scope and preserved behavior

Application changes are limited to `web/src/{TransitMap.tsx,RideFinish.tsx,rideAlert.ts,rideAlert.test.ts}` and the meaningful built-SPA regression `scripts/ride-recovery-check.mjs`.

`verify-integrity.py` proves exact HEAD/index preservation, five-file scope, source-map/current-source equality and unchanged numerical options, ride map/list, stop arithmetic, notification trigger and auto-end collector block. Planner, arrivals, selected-pickup projection/consumer, ETA transport/anchor, repeated-stop arrival guard, stop alerts and ride-end engine are byte-identical to the base. This is a display/focus improvement, not an ETA accuracy or boarding-guarantee claim.

## Executed validation

All service commands used cwd `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`. All browser/build/type/test work held `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`.

1. `PROBE=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/baseline flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/ride-recovery-check.mjs` — exit 0. Before-edit built-SPA observation, both reproduced defects, no page errors; all resources closed. Original baseline JSON's generic check labels are descriptions of exercised scenarios, **not assertions that candidate behavior passed**. Its per-state dialog/focus fields show the defects. The final script explicitly labels probe reports.
2. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/verified flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/verify.sh` — wrapper exit 1 after the following successful gates:
   - `npm test -- web/src/rideAlert.test.ts web/src/rideEnd.test.ts web/src/RideFinish.test.tsx web/src/rideArrival.test.ts web/src/rideMapFocus.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts web/src/tripBusIdentity.test.ts` — **62 tests / 8 files passed**.
   - `npm run typecheck` — backend and frontend passed.
   - `(cd web && npx vite build)` — passed, 128 modules.
   - Initial browser run passed the prompt/finish checks through replan, then timed out on an incorrectly capitalized exact `Trip` selector (actual accessible name is `trip`; CSS capitalizes it). Corrected only the test selector. `verify-first.log` and the failed run's JSON remain preserved; its resources closed. No application source changed after these successful build/type/test gates.
3. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/browser flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/browser.sh` — exit 0, mobile and desktop lifecycle checks passed (`browser-second.log`).
4. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/release flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/browser.sh` — exit 0. Final mobile and desktop checks include **14 recorded states and 44 fixture polls per viewport**, two/one/zero stops, stale/missing/empty/farther/recovered evidence, failed-poll expiry, no duplicate notification, initial unavailable snapshots, restored ride, Tab/Shift+Tab/Escape, actual mobile tap, external focus, Done/Dismiss/replan, automatic end with owned/external focus and Map→Trip recovery. Final destination/directions preserved. Layout checks at 320/360/390/430 and 640/1280 px; Got it at least 44×44. Zero page errors, all resources closed.
5. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/verify-integrity.py` — exit 0; scope, unchanged blocks, source/bundle hashes, browser results, HEAD/index and screenshot budget checked. `integrity.json` and `proposal.patch` saved. Combined teams' screenshot total: **248 files / 12,080,473 bytes**; existing evidence retained.

Screenshots visually inspected: baseline/candidate mobile stale prompt, final desktop stale prompt, recovered 320px prompt, and final long-destination 320px finish. They show readable route/bus/exit attribution and intact controls. Network requests are intercepted, tester identity is seeded, tiles are intentionally absent, and no production analytics or feedback was generated.

## Review boundaries and next task

Independently review current null/farther prompt precedence, notification trigger invariance, and focus on explicit versus automatic end. Reproduce all current gates with `verify.sh` and a fresh OUT; it now includes the corrected final browser script. Integrity pins this pre-capture HEAD, so a reviewer after controller commit should adapt only its base/head expectations instead of rerunning obsolete pre-commit assumptions.

No external screen reader, native mobile device/zoom, OS background-notification delivery, off-route/repeated-stop full ride browser census, full suite, staging, CI or deployment was performed. 640/320 widths test equivalent reflow, not native 200% zoom. Existing off-bus/bus-gone behavior and absent/invalid destination handling remain covered by the 62-test set; full browser auto-end validation here uses the two-hour trigger. No calculation or threshold changes are proposed.

All owned sessions (1053, 69695, 60601, 92331) ended. No server, browser, lock or process remains owned by this role. The existing watcher was untouched. No dependency, credentials, private feedback, historical DB, other-team, controller-file or Git publication action occurred.

Next builder after review: UX09 crash/offline recovery with actual browser reproduction. UX08 global alert-strip dismissal/announcement and broader on-board/off-route accessibility remain bounded follow-ups; do not mark every UX08 surface complete or repeat this finished prompt/finish experiment.
