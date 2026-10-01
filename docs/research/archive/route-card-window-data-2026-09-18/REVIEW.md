# Route-card destination arrival windows

Worktree: `/home/gwarren/projects/yale-shuttle-watcher/route-card-window-2026-09-18`

Branch: `ui/route-card-arrival-window-2026-09-18`, based on `3b4a4a41b569916970b89c1bb121ae51dbc78d67`.

Commit: `9d92b802a3ebb4841381a8a78e0f15bb0309422b`. Three source files only; dependency symlinks are untracked and excluded.

## Existing single-time meaning

The right-hand clock in TripPlanner's route cards was the **estimated time at the rider's destination**, including the final walk. With a valid joined live journey it displayed `journeyArrival.pointMs`, which is `now + destination.eta + walkFromSec`. The destination row is selected after the catchable bus's pickup occurrence and before another pickup occurrence; it can therefore belong to a different bus or later visit than the nearest shuttle shown in the pickup countdown.

The ETA's point is median-based: `DISPLAY_TAU = 0.5`, applied to the lead-position cluster, followed by the estimator's existing corrections, standing behavior and smoothing. It is **not the average or midpoint of the visible window**, and should not be described as the exact median of every displayed forecast dot after all transformations.

When no joined destination forecast was available, the card fell back to `now + totalSec`. Future mode showed **departure time – estimated arrival time**, which was a trip span, not an arrival uncertainty range.

## Change

* Live shuttle cards, collapsed and expanded, show `At destination (est.)` above both endpoints of the existing `journeyArrival.lowMs/highMs` window.
* Both endpoints round outward to whole minutes. Example fixture: `10:21a–10:27a` replaces `10:23a`.
* The bounds include the final walking estimate and preserve the existing joined catchable bus/occurrence. No pickup-plus-ride bound addition or UI clipping.
* Explanatory text says arrival can be earlier or later and assumes catching the named shuttle. Existing catch warnings remain unchanged; limited-data/catch-risk context is also in the destination description.
* Walking, future plans, and missing destination windows remain explicit approximate point estimates (`~10:23a`). Future mode no longer presents departure-to-arrival as if it were an uncertainty range.
* Departed and unavailable/stale shuttle states suppress the destination clock as before. The route card's duration, pickup countdown/window, route choice and estimator are unchanged.
* Clock digits cannot wrap. A range can wrap between endpoints and a future date can wrap separately from its clock.

## Validation

See `checks.log` for typecheck and the first complete pass; `final-checks.log` and `browser-results.json` contain the final focused tests, build and browser run after retaining the fallback point clocks' original minute buckets. Both runs used the shared `heavy.lock`:

```sh
npm run typecheck
npm test -- web/src/DestinationArrival.test.tsx web/src/journeyArrival.test.ts web/src/arriveBy.test.ts web/src/livePickupSelection.test.ts web/src/arrivalDetails.test.ts
npm --prefix web run build
node /home/gwarren/projects/yale-shuttle-watcher/route-card-window-data-2026-09-18/browser-check.mjs
```

Focused suite: 34 tests in five files, including seven new destination-display tests. These cover joined bus identity, correct forward visit, final walk, outward rounding, narrow windows, stale/departed omission, walking/future/missing-window fallback, cautions and midnight date distinction.

Built-SPA browser fixture: all external requests intercepted, no collector/live DB and no reports submitted. Synthetic server ETA rows drive actual TripPlanner/arrival components. At 360, 390 and 1280 px, verify:

1. Same bus/current visit.
2. A different catchable bus than pickup countdown.
3. Destination forecast disappears without changing pickup or wait.
4. Same bus on a later visit.
5. Destination forecast recovers.
6. Stale forecast suppresses destination time.
7. Fresh forecast recovers.

Each viewport additionally checks walking remains a point, future departure remains a point (not a false window), keyboard opens expanded details, the chosen-bus boarding action remains present, zero page errors, no horizontal overflow, destination content not clipped, and each clock's digits stay on one line. Screenshots include `same-bus-*`, `different-bus-*`, `expanded-*`, `missing-destination-*`, `same-bus-later-visit-*`, `stale-*`, and `future-*`.

Visual inspection completed for representative phone and desktop screenshots. Map tiles are intentionally blocked in these fixtures; this does not represent a production basemap failure. The browser fixture destination is Union Station with a long destination label to test fitting; the display change is route-independent.

## PR-ready description

Route cards showed only one destination-arrival clock, leaving riders unable to judge the arrival window. Live shuttle cards now show a labeled estimated destination window from the existing joined journey forecast, including the final walk, with bounds rounded outward. Pickup timing, catch warnings, trip ranking and ETA calculations are unchanged. Walking/future/missing-window cases stay approximate point estimates; stale and departed options do not show a destination time.

Validation: typecheck; 34 focused tests; production Vite build; actual built-SPA browser checks at 360/390/1280 px covering current and later bus occurrences, missing destination, stale/recovery, future planning, walking and expanded details.

No merge, deployment or watcher changes were made by this agent.
