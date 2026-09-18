# Independent review 17 — saved destinations, recents and cumulative recovery fixes

Reviewed September 18, 2026, 06:41–06:51 ET, controller round 11. **Verdict: approve. No blocking findings.**

Exact HEAD: `8f20f201a6cb7935ac3af4b983c173830510a277`.
Exact supplied base and independently checked merge-base: `98e535b99649e74ca599d2e33bcfdc46df83d30d`.

I inspected the complete nine-file candidate against the supplied base and the additional three-file saved-place slice against previously approved `a5966b1e87a9f4fbecf3888456fbd272f186fcb8`. Prior review16 was evidence to verify, not inherited approval for this head. All application files and the index tree remained unchanged. Fresh evidence is in `review-ux10/`.

## Supported improvement

Saved destinations and recent places now expose separate native planning, save and removal buttons with destination-specific accessible names. Actual Tab/Shift+Tab/Enter/Space tests select the intended coordinates and restore focus to the To summary. Edit/Done, rename fields and removal controls meet the repository's touch/input conventions. Enter and ordinary blur save a trimmed name; Escape restores the committed name before moving focus; blank names do not destroy the old label. Keyboard deletion works and focus follows the next/previous surviving entry or a useful list/form control.

The browser checks also establish promotion into Saved, coordinate-based deduplication, last-entry fallbacks, long-list scrolling, blocked storage reads/writes, unavailable GPS, pending/failed initial data, and protection against stealing focus from another deliberately selected control. No numerical trip or ETA behavior is changed.

The reviewer-authored supplemental fixture reuses only the synthetic fixture/setup helpers and exercises six additional state-transition groups on mobile and desktop: pointer Done while a name is dirty; Escape followed by another input; middle/last deletion; deleting a different row while retaining a dirty focused field; promoting a recent while committing a rename; duplicate display names retaining distinct coordinates. It also checks 320px and 640px at 200% CSS zoom. All pass with zero page errors. These checks exercise browser event order and stored records, not just static markup.

Fresh 390px saved/edit screenshots were visually inspected. Controls do not overlap; edit fields are readable; visible Edit/Done/Delete actions are clear. Saved chips still truncate long names, as before; complete accessible names, titles and edit fields remain available. This is a keyboard/touch/state improvement, not a claim that long chip names are now fully visible.

The preserved builder baseline report and its script positively assert the old keyboard-unreachable DIVs, Enter failing to delete, and Escape subsequently persisting the unwanted rename. I checked those observations against the original source and independently verified that the frozen baseline bundle embeds the exact previous candidate's TransitMap. The completed baseline experiment was not rerun.

## Cumulative fixes and integration

Previous crash and map changes remain included and unchanged. The current built SPA independently passes all eight active-touch teardown cases, including held pinch across manual Done and natural two-hour ride expiry, route filtering/navigation, unmoved gestures, queued movement and cancellation. Document listener counts return to their original values before touch release. Replacement maps work, final walking coordinates survive, and no asynchronous page error occurs. The ordinary map lifecycle fixture also passes keyboard pan/zoom, actual browser pinch, phone reflow and six rapid cycles on each of the system/ride maps. Thus the prior held-pinch blocker remains resolved on this exact candidate.

Crash recovery leads with Reload, describes reset consequences before the destructive button, preserves useful focus and keeps technical details collapsed. Fresh initial/expanded recovery screenshots were inspected. Both the real boundary fixture and a full-app fault-injection fixture pass; reload/reset retain the actual session trip endpoints, whereas the intentional header Refresh still clears the trip. Blocked browser storage remains recoverable. Fault injection is artifact-only; candidate source is untouched.

The actual service worker and a bounded local server on port8093 pass interrupted/expired data, cached-shell offline reload, API-cache exclusion and automatic reconnection. Search integration passes delayed result/blur/reopen/error/draft cases. Feed fixtures pass pending, empty, failed, malformed, stale and recovered states, retaining both #307 and #309 pickup slots. Unit tests cover server checkpoint restoration, wire parity and Docker runtime dependency closure.

Source integrity proves the entire TransitMap outside the saved-list replacement equals the previously approved candidate. Removing only the prior two map options/comments and helper calls/import restores the exact supplied-base TransitMap. The new slice changes exactly SavedPlaces, TransitMap and its browser script; the cumulative candidate is nine files. Planner arithmetic, route-forward position tracking, both stop occurrences, route/bus identity, class-deadline calculations, historical samples, estimator fitting, backend transport and service-worker code are unchanged. There is no new normality, coverage, calibration or ETA-accuracy claim. Current ETA progress/requests and the release/follower reports were read; no shared-interface action is needed.

## Independently executed validation

All commands below were executed, with fresh reviewer outputs. The shared heavy lock covered complete test/build/browser commands; port8093 remained inside that lock through start/test/cleanup. Scripts set cwd to the assigned worktree's `services/shuttle-v2`. No dependencies were installed.

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/verify.sh`

   **Exit0**, `review-ux10/verify.log`: 96 tests in five files, backend/frontend typechecks and Vite production build (131 modules) pass.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10/integration.sh`

   **Exit0**, `integration.log`: 139 additional tests in13 distinct files pass; combined total **235 tests in18 files**. Nine browser reports pass: mobile/desktop saved places, navigation/search, feed states, eight-case touch teardown, ordinary map lifecycle, real-boundary recovery, full-app trip recovery and actual cached-shell offline recovery. Reports have no page errors. Navigation's successful script explicitly closes its page/context and closes the browser in finally; the other reports also record resource closure.

3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10/extra.sh`

   **Exit0**, `extra.log`: reviewer-authored supplemental transitions pass on mobile and desktop, six groups each, zero page errors and closed resources. Total successful browser reports: **11**.

4. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10/verify-integrity.py`

   **Exit0**, `integrity.log/json`: exact head/base/merge-base, clean checkout, unchanged index tree, all912 tracked file hashes and all253 builder artifact hashes; exact slice/cumulative scope; source maps matching all five candidate runtime sources; frozen baseline provenance; previous map scope against supplied base; all11 browser reports; screenshot budget. Shared screenshot census:433 images/19,424,373 bytes, below100MiB. Existing evidence is preserved.

5. `git diff --check 98e535b99649e74ca599d2e33bcfdc46df83d30d..HEAD` and `node --check services/shuttle-v2/scripts/saved-places-check.mjs`: **each exit0**. Supplemental reviewer script syntax also passes. No failed verification gate or candidate correction occurred. Two path-discovery inspections returned nonzero because reports were outside the searched artifact directory and optional glob paths were absent; the correct read-only research paths were then read. Those were not tests.

## Handoff and limits

Controller may proceed with remaining full-suite/staging/CI/publication and deployment verification for the exact reviewed head. No publication was performed by this reviewer. Next builder slice: remaining UX10 weather disclosure/location-denied typed-origin behavior, starting `ux-10/NEXT_UX10.md`, followed by UX11/remaining coverage. Those source-only leads are not review findings against this proposal.

No physical device, native assistive technology, Safari, OS/background or service-worker deployment-version race certification is claimed. Synthetic fixtures establish state transitions, not production incidence. The private Leaflet adapter remains intentionally version-specific and should retain its actual-browser regression on dependency upgrades.

Owned sessions14550,13974,39719 have completed. All launched pages/contexts/browsers and the fixture server closed; no owned heavy command or lock remains. Existing watcher untouched. No application edits, branches, commits, index entries, controller files/state, other-team artifacts, historical DB records, credentials, private feedback, GitHub or deployment state were modified. No pending review experiment.
