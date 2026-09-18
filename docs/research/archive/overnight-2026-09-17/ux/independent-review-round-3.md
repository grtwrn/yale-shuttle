# Independent review — UX-02 navigation and place search

Reviewed September 17, 2026, 23:28–23:36 ET (controller round 2; third UX review artifact). **Verdict: approve. No blocking findings.**

Exact base: `948712e153cea1017e9471ce84851a41fae4508a`.
Exact candidate HEAD: `55b20a7f5f07e2336f9c19785b8c6c027aa999ca`.
HEAD, parent and merge-base independently match the supplied values. Worktree and index were clean at entry and after testing. No tracked file, branch, commit, controller state, GitHub or publication action was changed by this review.

## Supported behavior

The complete three-file diff is confined to `services/shuttle-v2/web/src/{TransitMap.tsx,PlaceList.tsx}` and the new bounded `scripts/navigation-search-check.mjs`.

The inputs and suggestion lists have stable From/To names, independent of the chosen address or placeholder. The existing buttons remain keyboard-operable and now expose one current page inside a named Main navigation landmark. The active-descendant attribute names a rendered row, and errors use an alert. The destination rows still map geocoder results one-for-one; changing its expanded-state expression is consistency maintenance, not proof of an earlier length mismatch.

Displayed-place selection returns focus to that endpoint's summary only when its editor owned focus. The next Tab proceeds to the existing Save/Swap control. The animation-frame check preserves focus when it moves to navigation before that callback. Delayed blur callbacks are canceled on refocus and component unmount. Independent timer-controlled browser checks cover both From and To, including refocusing the same empty destination editor before its old 180ms callback, rapid re-opening after a selection, and leaving Trip during an uncommitted origin edit. Normal origin resolution on blur still works without stealing destination focus; view changes and reload preserve committed endpoints.

I independently executed the candidate's browser harness against a freshly built bundle, then two reviewer-authored harnesses. The latter add destination races, callback-time focus ownership, unmount/draft behavior, From failure/recovery and a genuine desktop context with live-feed failure. I visually inspected the review's 360px search, 390px re-entry and 1280px failed-feed screenshots. Search and primary navigation remain readable, with no horizontal overflow and tested control sizes. Long option names stay accessible in full while visually truncated on phones.

The previous UX-01 supporting-route correction is part of the supplied base and untouched by this diff. No ETA arithmetic, model, planner selection/ranking, route/bus identity, repeated-stop occurrence, server transport, historical observation or forecast wording changes. No new runtime import or Docker dependency. Existing Docker closure and ETA transport tests passed, including both occurrences and fail-closed missing/stale forecasts. This is an interaction/accessibility improvement; it makes no ETA-accuracy or probability-calibration claim.

Read the handoff, backlog, first task, progress/checkpoint/coverage/summary, builder evidence and previous independent reviews, current v2 guidance, Red release/follower reports, and ETA progress/requests (through its 23:30 independent research review). No shared-interface conflict.

## Independently executed checks

Service cwd: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`.

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-3/verify.sh` — **exit 0**. Output: `review-round-3/verify.log`. Checked script held one lock across:
   - `npm test -- web/src/recents.test.ts web/src/tripDraft.test.ts web/src/format.test.ts web/src/endpoints.test.ts web/src/liveUpdates.test.ts web/src/liveArrivals.test.ts src/server/serverEta.closure.test.ts`: **113 tests in six actual files passed**. `liveArrivals.test.ts` is an unmatched filter, not an executed test; no coverage is credited to it. The actual ETA transport test was executed separately below.
   - `npm run typecheck`: backend and frontend passed.
   - `(cd web && npx vite build)`: 124 modules; 5.06 seconds; passed.
   - `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-3 node scripts/navigation-search-check.mjs`: passed. Keyboard arrows/Enter/Space/Tab/Escape, touch selection, named inputs/lists/current navigation, pending/empty/failed/recovered searches, no GPS, origin timer race, normal blur resolution, endpoints across views/reload and 360/390/430/1280/640 CSS-pixel layouts. `after-browser.json` and separate review screenshot retained.
2. `npm test -- web/src/etaSource.test.ts` — **exit 0; 13 tests passed**, 1.23 seconds. Existing transport assertions cover repeated visits, next occurrence, server-derived values and missing/stale data. Light targeted test; no model fit or full suite.
3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-3/extra-browser.mjs` — **exit 0**. Six additional transition groups above, zero page errors, four expected geocode requests. `extra-browser.log/.json`.
4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-3/desktop-feed-failure.mjs` — **exit 0**. Desktop keyboard context, 1280px/640px reflow, live `/api/buses` failure with usable search, selection focus, navigation current state and preserved destination. Zero page errors. `desktop-feed-failure.log/.json`.
5. From repository root, `git diff --check 948712e153cea1017e9471ce84851a41fae4508a 55b20a7f5f07e2336f9c19785b8c6c027aa999ca` and `node --check services/shuttle-v2/scripts/navigation-search-check.mjs` — **exit 0**. Reviewer supplemental script syntax check also passed.
6. `git rev-parse HEAD`, `git rev-parse HEAD^`, `git merge-base 948712e153cea1017e9471ce84851a41fae4508a HEAD`, `git diff --exit-code`, `git diff --cached --exit-code`, `git status --porcelain=v1` — **exit 0**, exact head/base verified and working-tree/index/status output empty.

Total unit tests independently executed: **126**. No application assertion failed in this review. Builder and earlier review evidence were preserved; no completed baseline experiment was restarted.

## Limits and next work

No full suite, full backend staging/API smoke or deployment verification was run; controller/CI gates remain. Browser runs use mocked API responses and tester identity, with all network intercepted; they do not measure geocoder availability or production ETA accuracy. All pages/contexts/browsers closed, all command sessions collected and locks released. No server/collector/watcher was launched or changed. No dependency install, production database/private feedback/credential access, or analytics submission. Combined UX/ETA screenshots: **47 files / 2,526,399 bytes**, well below 100 MiB.

640 CSS pixels is equivalent desktop reflow, not native browser zoom. No native screen reader or physical phone keyboard was used. Empty-editor cancellation, async Enter-before-results focus and saved-place controls remain explicitly scoped to UX-10; this approval does not claim all keyboard paths are complete.

One nonblocking observation for existing UX-07/09: a failed initial live feed correctly shows “Live bus updates unavailable. Reconnecting…” but the existing empty-fleet section below also says “No shuttles running right now.” The reviewer screenshot/JSON records this. The same unconditional empty-buses wording is present at base TransitMap.tsx:4907; it is unchanged by this candidate. Future availability-copy work should distinguish unknown fleet from confirmed no service. No ETA arithmetic or service assumption should be altered to fix that wording.

Controller can advance this exact candidate through normal full-suite/staging/CI/publication gates. Next builder: **UX-03 feedback/reply accessibility**. Preserve the existing UX-10 follow-ups and UX-07/09 missing-feed distinction; do not repeat completed UX-01/02 baseline experiments.
