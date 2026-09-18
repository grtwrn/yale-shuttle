# Keep place search accessible and preserve keyboard focus

Builder candidate, September 17, 2026, 23:24 ET. Ready for independent review; no builder publication. Preserved HEAD/base `948712e153cea1017e9471ce84851a41fae4508a` (controller-reported deployed PR282). Entry checkout was clean.

## Rider problem and result

The actual built SPA exposed the destination input under its placeholder and the origin input as “📍 Current location,” even when editing another starting point. Suggestion lists lacked names, and Trip/Map/Issues conveyed their selected state only visually. Empty/failed search messages were ordinary text. Picking a displayed place with Enter removed the focused input and left focus on BODY.

From and To now have explicit, stable accessible names; the visible labels are associated with their inputs. Lists identify which endpoint they serve. Main navigation exposes the current page and keeps its existing Tab/Enter/Space behavior. Search failures/empty matches use an alert, while the existing loading status stays intact. Active-descendant references are guarded against missing rows. To's expanded state now reads the rendered rows, but **no existing length mismatch was demonstrated**: the current `toRows` maps `toSugg` one-for-one.

Selecting a displayed suggestion or origin recent/current-location row from a focused editor returns focus to that endpoint's summary. The next Tab reaches the existing Save or Swap control. Focus is restored only if the removed editor had it, and only while focus is still on BODY; a result picked while another control is focused leaves that control alone. The summary is not a text input, so the implementation does not request the phone keyboard.

An extended keyboard experiment found a related race: immediately reopening From after a recent pick allowed the previous editor's delayed 180ms blur handler to close the new editor and lose the pending start. This was reproduced twice on the initial accessibility candidate, whose blur logic was unchanged from base. `reopen-before/after-browser.json` records the editor disappearing and “Tap to set start.” Pending blur timers are now canceled when the corresponding editor regains focus and when TripPlanner unmounts. Ordinary blur still resolves a typed origin and preserves focus on the destination. The final regression freezes browser timers across rapid reentry, so a slow host cannot accidentally skip the old pending callback.

Files: `web/src/TransitMap.tsx`, `web/src/PlaceList.tsx`, and reusable `scripts/navigation-search-check.mjs`, all under `services/shuttle-v2`. No estimator, ETA values, planner ordering, repeated occurrences, wire semantics, historical observations or storage format changed. No new tab, filter or rider-facing copy beyond programmatic names/roles.

## Reproduce and review

From the repository root:

```sh
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-02/verify.sh
```

The checked script uses the v2 service cwd and runs:

```sh
npm test -- web/src/recents.test.ts web/src/tripDraft.test.ts web/src/format.test.ts web/src/endpoints.test.ts
npm run typecheck
(cd web && npx vite build)
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-02 node scripts/navigation-search-check.mjs
```

**Exit 0**, `final-verify.log`: 87 tests in four files, backend/frontend typechecks, Vite build (124 modules, 4.80s) and built-SPA browser assertions passed. App source has not changed since this verification. A subsequent test-only addition verified actual navigation button bounds and automatic resolution on blur, without repeating unchanged source gates:

```sh
# cwd services/shuttle-v2
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-02 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/navigation-search-check.mjs
```

**Exit 0**, `supplemental-browser.log`, final `after-browser.json`. `node --check services/shuttle-v2/scripts/navigation-search-check.mjs` and `git diff --check` also passed from repository root. HEAD remained unchanged and only the three intended source files are modified/untracked; index untouched.

Browser acceptance covers:

- From/To names, named listboxes, current Trip/Map/Issues state, navigation landmark; Tab/Enter/Space with navigation focus retained.
- Destination arrow wrapping and Escape dismissal with input focus retained; origin recents and typed matches; selected summary focus and the next Tab action.
- Rapid origin reopening with a still-pending old blur timer; ordinary delayed blur resolving a single result without stealing destination focus.
- Touch suggestion selection and no list reopening; a programmatic option activation after focus moves to navigation does not steal focus (controlled assistive-activation simulation, not a separate screen reader).
- Pending, empty, failed and recovered search responses, with loading status and error alert semantics. Current-location selection under unavailable GPS remains selectable and honestly asks for a start again; it is not treated as a successful position fix.
- Endpoint retention across Trip → Map → Issues → Trip and reload. Empty fleet is a local fixture, not a statement about overnight service.
- 360/390/430/1280px and 640 CSS-pixel reflow equivalent to 200% desktop width; long match names remain fully accessible while visually truncated. No horizontal overflow; input font is 16px and height >=44px; actual primary navigation targets >=44×44px. Phone screenshot visually inspected.
- Zero page errors, no report submission, all external requests intercepted.

Independent reviewer should especially inspect focus ownership, the quick-reopen regression, ordinary auto-resolution on blur, and preservation of endpoint drafts. Use a separate OUT directory to preserve builder evidence.

## Evidence history and limits

- `baseline.log`, `before-browser.json`, `before-search-360.png`: initial built baseline (before any source edits), exit 0. Includes old accessibility snapshots and BODY focus after a keyboard pick. This initial harness did not yet exercise rapid reopening.
- `first-verify.log`: initial candidate exit 0 with 19 existing tests, both typechecks/build/browser. Two guessed nonexistent filenames were ignored by Vitest; no tests from those files are claimed. Final script uses real format/endpoints files and passes 87 tests.
- `extended-browser.log`: harness-only strict selector failure, fixed with exact Save button name.
- `extended-browser-2.log` and `reopen-before.log`: real quick-reopen failure before blur cancellation. The latter includes its failure accessibility snapshot. Existing evidence preserved.
- `reopen-fix-verify.log`: 87 tests/types/build passed; browser later failed its assumption about the Current location selection. Hover can seed the active row, and unavailable GPS cannot yield a resolved Current location pill. The final harness explicitly reaches/asserts option zero and accepts the honest unresolved-GPS summary. No app location behavior was changed to satisfy this test.
- `final-browser.log`: extended artifact harness passed. `final-verify.log` and `supplemental-browser.log` execute the reusable app harness and are the final candidate evidence. Earlier artifact `search-check.mjs` is retained as construction history; use the app script for review.

No full suite, complete backend staging smoke, native screen-reader session, physical phone keyboard, native browser zoom or deployment verification is claimed. Mobile emulation proves focus is on a non-input; it cannot prove every OS keyboard animation. Existing empty-editor cancellation and explicit Enter-before-results focus behavior remain candidates for UX-10; this slice restores focus for displayed-place selections and preserves existing cancellation/draft behavior. Saved-place rename/delete and the small Swap target remain outside this slice.

All browser pages/contexts/browsers closed through bounded commands, including failure paths. No server, collector, persistent watcher, dependency install, production DB access, private feedback, credentials, GitHub action or controller-state change. Both-team screenshot total at handoff: 44 files / 2,398,581 bytes, prior evidence retained. ETA's latest research report has no app/wire change or dependency for this proposal.
