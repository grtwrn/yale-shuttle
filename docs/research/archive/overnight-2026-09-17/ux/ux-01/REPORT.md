# Clarify class-arrival uncertainty and future trip controls

Status: tested builder candidate, awaiting independent reviewer/controller. No commit, PR, merge or deployment by this worker. HEAD remains `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`.

## Rider problem and result

The class-deadline panel said “Your arrival is at risk” whenever it could not recommend a trip. In an actual component browser, that included an interrupted feed, future departure, missing destination window, a walk arriving within the buffer, a risky pickup, limited data, possible lateness, and no options. The candidate gives each state a specific explanation. Existing “Walk now” and named-route advice remain intact.

Presentation precedence is: existing recommendation; a known option using the buffer; a conditional fit with its connection/data caution; unavailable information; available estimates extending past class. A second unavailable route prevents a blanket lateness headline even when the two displayed rows are late. Partial shuttle availability is explicitly “Some shuttle times are unavailable” and the explanation names the route with missing data. This is presentation, not a new recommendation or on-time probability.

The departure control now says “Leave.” Its future-plan note explains typical wait/travel times and when to check live arrivals. The two affected buttons now measure 44px high. A built-SPA screenshot also exposed the pre-existing `Red · #` placeholder on future plans with no bus assigned; the row now shows just `Red` until there is an actual bus name. Existing catchable-bus identity remains `Red · #309` in the fresh fixture.

## Source changes

- `web/src/arriveByMessage.ts`: small pure display helper.
- `web/src/arriveByMessage.test.ts`: nine meaningful state/precedence tests.
- `web/src/arriveBy.ts`: expose the existing comparison rows; no changed calculations, selected walk/shuttle, or recommendation.
- `web/src/ArriveBy.tsx`: use helper; omit empty bus suffix.
- `web/src/TransitMap.tsx`: departure label, future note, two minimum button heights.

All source paths are relative to `services/shuttle-v2`. No estimator, planner, shared transport, numerical window, history cohort, route ordering, or repeated-stop logic changed. ETA team requests confirm no concurrent semantic changes.

## Reproduction and validation

Run from `services/shuttle-v2`:

```sh
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01/verify.sh
```

The checked script runs these dependent gates under one shared lock:

```sh
npm test -- web/src/arriveBy.test.ts web/src/arriveByMessage.test.ts web/src/journeyArrival.test.ts
npm run typecheck
(cd web && npx vite build)
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01/browser-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01/shell-check.mjs
```

Final run: **exit 0**, 3 test files / **22 tests passed**, backend and frontend typecheck passed, Vite **124 modules built in 4.89s**. `git diff --check` also passed. Exact output is `final-verify.log`.

Component fixture: **13 states** (fresh, buffer, stale, loading/no received feed, partial availability, failed, missing, future, late, catch risk, limited data, walk recommendation, empty) at **360, 390, 430 and 1280 px**, without horizontal page overflow. Long destination name retained. Keyboard Tab reaches the named datetime and comparison row, Enter selects Red, Space opens/closes help. Past/empty deadlines show their existing alert and hide advice. Panel control bounds are >=44px. `after-browser.json` records all visible text and measurements.

Built SPA: actual compiled application, checked-in route/stop fixture, empty fleet and future trip. Verified future unknown headline, no placeholder bus identity, all widths above, 640 CSS-pixel reflow equivalent to a 1280px desktop at 200% zoom, 16px departure input, all touched controls >=44px, keyboard Now/Plan for later activation, focus retained on Plan for later after Now, saved future draft after reload, and invalid deadline behavior. `shell-browser.json` records checks, requests, controls, visible text and focus. Native datetime segments take seven Tab presses to reach Now on this Chromium; the harness accounts for that native behavior.

The 200% check is equivalent CSS-pixel reflow, not an assertion that native browser zoom was automated. Keyboard/accessibility names were checked through the actual browser DOM; no external screen-reader session was run. Full test suite and complete backend staging smoke were **not** run here; normal CI/controller review still owns them before merge.

Both harnesses use `seedTestId`, intercept every request, and close their pages/contexts/browsers. No production feedback or analytics traffic, server, collector, or persistent watcher was started. No live service availability was assumed.

## Visual evidence

- `before-buffer-360.png`, `before-stale-360.png`, `before-future-360.png`: original generic-risk message.
- `after-buffer-360.png`, `after-stale-360.png`, `after-catch-360.png`: distinct rider states.
- `pre-bus-identity-shell-future-360.png`: future-plan empty bus suffix before correction.
- `after-shell-future-360.png`, `after-shell-future-390.png`, `after-shell-class-360.png`: final full application.

Builder visually inspected buffer, stale, connection-risk and full-shell screenshots. Before/after component DOM evidence is retained as JSON. Initial harness issues (esbuild case resolution of `ArriveBy.tsx` / `arriveBy.ts`, clock initialization of the saved draft, and native datetime segmented Tab order) were fixed in test setup; final checks above pass. These were not application regressions.

## Independent review focus

Check precedence for late walking + unknown second shuttle; buffer-fitting walking + caution-only shuttle; partial versus fully unavailable shuttle windows; and future row identity. Confirm the sole calculation-helper change is returning existing rows. Review source and rerun `verify.sh` if needed. Proceed to UX-02 core navigation/search accessibility after this candidate is independently reviewed.
