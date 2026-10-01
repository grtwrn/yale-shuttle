# Make saved destinations and recent places usable by keyboard

Builder result, September 18 2026, 06:29–06:41 ET. Tested proposal ready for independent review; no publication performed. Entry/current HEAD is `a5966b1e87a9f4fbecf3888456fbd272f186fcb8` on `overnight/ux-20260917-011`. Prior crash/map proposal approved in independent-review-round-16.md remains intact. This is an additional three-file delta; controller still owns the cumulative candidate and release gates.

## Reproduced rider failures

`baseline/report.json` records actual 390px built-SPA behavior before edits. Saved destination and recent destination rows are clickable DIVs with tabIndex -1, so Tab skips the planning action. Enter on the focused saved Delete button leaves both records in storage because its only handler is mousedown. Typing a new name, pressing Escape, then leaving the field still commits that unwanted name. Delete measures21px high and the rename field uses12px text, below the repository's mobile conventions. Zero page errors; all test resources closed. `entry-dist/` and `TransitMap.entry.tsx` preserve the actual entry baseline. These are synthetic reproductions, not a claim about production incidence.

## Proposal

- New `web/src/SavedPlaces.tsx` owns the two reachable list presentations. Native destination buttons are separate from Save/Remove buttons, with full destination-specific accessible names. Controls measure at least44px in both dimensions and rename inputs use16px text with a visible native focus outline.
- Enter or ordinary blur commits a trimmed rename; Escape restores the committed name and moves focus to Done without saving the draft. Blank input restores the old name. Delete uses click for keyboard and touch; pointerdown only prevents premature blur from saving a partial rename.
- Removing a focused row moves focus to its next/previous sibling, then a surviving list control or To. Saving a recent focuses the corresponding saved destination (or rename input while editing). Focus restoration only occurs when the removed control owned focus; another control selected in the same DOM task keeps it.
- Saving a recent already present at the same coordinates reuses the saved entry and removes the redundant recent instead of adding another copy. Existing `samePlace` tolerance, stored record format, destination coordinates and shell storage callbacks are retained.
- `TransitMap.tsx` renders the component and places focus on the To summary after a destination pick. It removes the now-replaced list markup and an unreachable starred-row rename branch. Popular-place actions are unchanged.
- New `scripts/saved-places-check.mjs` is the durable actual-SPA keyboard/touch regression. It uses `seedTestId`, intercepts every request and closes resources on success/failure.

Source audit removes only the list markup/helper/state and new import/render call, then proves the entire remaining TransitMap text equals entry. All other910tracked-file hashes are checked. Thus numerical planner code, route-forward tracking, current bus/visit identity, both upcoming occurrences, class calculations, historical samples, transport and prior recovery/map files are untouched. No ETA accuracy/probability claim.

## Executed validation

Commands below were executed from the assigned checkout unless otherwise stated. Full heavy commands use the single shared lock. No dependency installation or staging server was needed.

1. From `services/shuttle-v2`:

   `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/baseline DIST_ROOT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/entry-dist flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/baseline.mjs`

   Exit0, `baseline.log`: positively asserts the three old failures and captures actual geometry. This is a successful reproduction, not a claim the baseline is fixed.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/verify.sh`

   Exit0, `verify.log`: **96tests/5files**, both backend/frontend typechecks, Vite build131modules. Script executes `npm test -- web/src/recents.test.ts web/src/tripDraft.test.ts web/src/endpoints.test.ts web/src/format.test.ts web/src/anonId.test.ts`, `npm run typecheck`, and `(cd web && npx vite build)`. All paths exist; no ignored filenames counted.

3. Initial browser checks from `services/shuttle-v2`:

   `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/mobile-first flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/saved-places-check.mjs`

   `DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/desktop flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/saved-places-check.mjs`

   Both exit0, corresponding logs and reports preserved. Harness then gained meaningful last-entry, long-list, pending-feed and selection-focus cases; application source did not change.

4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/browser.sh`

   Exit0, `browser-final.log`: **four final reports pass**, each with zero page errors and bounded browser cleanup. Mobile/desktop saved-place reports each cover11groups: actual Tab/Shift+Tab/Enter/Space/Escape, correct selected coordinates, rename/blank/cancel/blur/reload, keyboard/touch delete, last-entry fallbacks, promotion in/out of edit mode, coordinate deduplication,12saved-place scroll/selection, no focus theft, blocked storage read/write, pending/failed initial feed, unavailableGPS, long names and360/390/430/640/1280px plus200%CSS zoom. All changed targets meet44px; inputs16px. Existing navigation-search report passes12groups including delayed search/quick-reopen/errors/draft. Existing feed report passes8groups including pending/empty/failed/malformed/stale/recovered snapshots and both #307/#309 arrival slots. No new claim about native phone behavior.

5. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/verify-integrity.py`

   Exit0, `integrity.log/json`: exact entryHEAD/index, all910tracked hashes, precise three-file scope, unchanged shell outside list replacement, both candidate source files matching actual Vite source maps, all four final reports, screenshot budget. Shared screenshot census409files/18,551,952bytes, below100MiB; existing images retained.

6. `node --check services/shuttle-v2/scripts/saved-places-check.mjs` and `git diff --check`: exit0. One read-only source inspection had unavailable `rg`; fallback `grep` succeeded. No verification failure or application change resulted. Earlier initial attempts to read two guessed nonexistent harness paths are inspection errors only, not tests.

Visually inspected `mobile-first/saved-390.png` and `editing-390.png`. Clear Edit/Done/Delete controls, separate recents actions, readable16px rename fields, no overlap. Compact saved names still truncate visually as before; their complete names are accessible and available in edit fields. This is not a redesign of list density.

## Reviewer and next builder

Review three-file delta atop entryHEAD and cumulative diff as controller directs. Prior review16 approval belongs to the earlier crash/map candidate; this saved-list proposal still needs fresh independent review. Reproduce with fresh `OUT` around `browser.sh`; run `verify.sh` for tests/types/build first if source changed. Integrity script pins builder entryHEAD/index, so after controller capture adapt those metadata assertions while retaining hash/scope/provenance checks.

Full suite, complete staging smoke, CI, commit/PR/merge/deploy and deployment verification remain controller gates. No native AT/Safari/iOS/Android/OS-background certification. Every owned page/context/browser closed; no fixture server, process or heavy lock remains. Existing simulated rider watcher untouched. No credentials, private feedback, historical DB writes, other-team artifacts or protected controller files were touched.

Next bounded builder slice: UX10 weather disclosure semantics and unavailable-location typed-origin recovery, starting `NEXT_UX10.md`. Those leads remain source-inspected, not proved browser defects. Then UX11 and remaining VIEW_COVERAGE gaps. Do not repeat completed saved/map/ETA experiments merely for new context.
