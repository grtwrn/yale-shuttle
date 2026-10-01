# Historical: class arrival comparison

**Removed on September 18, 2026.** This document records the earlier design;
the separate Arrive by bar and class deadline/buffer panel are no longer part
of the app. Plan for later remains the trip scheduling control. Destination
arrival windows remain on route cards through `DestinationArrival.tsx` and
the shared `journeyArrival.ts` calculation.

For the current UI, build `services/shuttle-v2/web`, then run
`node scripts/trip-scheduling-check.mjs` from `services/shuttle-v2`. This
isolated browser check verifies legacy draft migration, Plan for later,
future departure selection, Now recovery, destination arrival windows, and
watcher recognition of arrival windows and approximate points at 360, 390,
and 1280 px. It uses checked-in fixtures, intercepts all network requests,
and closes its browser afterward. Set `BOT_CHROMIUM_PATH` to your Chromium
executable and `TRIP_SCHEDULING_OUT` to choose the screenshot/result directory
(default: `pr-preview/trip-scheduling/`).

The older `scripts/arrive-by-check.mjs` below applies only to revisions before
the removal. It is not a current UI or staged-deployment check.

## Earlier design

The trip planner offers **Arrive by…** after selecting a destination. Set the class date/time and a 0–30 minute indoor buffer (default 5). The comparison sits above the map and shows one relevant shuttle and the walking alternative. Tapping either opens its existing trip details.

The target is class time minus the buffer. A shuttle recommendation requires its destination window to fit before that target, a reachable pickup using the early end of the pickup window, measured route data, and a current feed. Walking is shown as a point estimate, without an invented probability or interval. When neither alternative meets those conditions, the panel explains the risk instead of promising an on-time trip. A passed deadline stays passed; it never silently becomes tomorrow. The selection survives a session refresh with the trip draft.

## Arrival arithmetic

`journeyArrival.ts` selects the destination visit **after the catchable boarding visit**, on the same bus and route. A repeated pickup before that destination disqualifies the pairing. It reads the destination's full model distribution, which already includes the waiting and ride, and adds only the final walking point estimate. It does not add marginal pickup and ride quantiles or infer a bell curve from three quantiles. Missing, malformed, or impossible journeys have no window.

The live trip's total, ride duration, destination clock, and map alight clock now use the same destination prediction when available. Pickup countdown selection and the underlying ETA estimator are unchanged. The displayed pickup can still follow an approaching bus while the journey is priced on the later catchable one; the new comparison explicitly identifies that catchable bus. The normal trip summary retains its existing fallback when no destination distribution is available.

The conditional window is **not a calibrated on-time probability**. It assumes the rider catches the named bus and walks at the model's pace. A connection is marked uncertain when the walking estimate exceeds the pickup's early bound, including a bus already at the stop when the rider is not. The recommendation does not rely on the driver's assumed boarding dwell. A failed poll or 45 seconds without a successful update suppresses the live window. Future departure plans also withhold live shuttle advice; their walking comparison starts at the selected departure time.

The existing pickup dialog remains available for observed hold location, stops away, next arrival, and estimated gap. This change does not invent historical previous-shuttle observations or exact on-time percentages. The September 16 replay found that the target 80% interval under-covered one cold-start rider cohort, so whole-journey percentages remain deferred.

## Historical verification

Pure regressions cover forward visit matching, repeated pickups, different vehicles/routes, full-chain interval arithmetic, risky boarding, missing/malformed arrivals, buffer boundaries, expired dates, stale/failed feeds, future departures, and draft restoration.

`scripts/arrive-by-check.mjs` exercises the built UI with recorded or live data, saves 390px/320px screenshots, checks overflow, changes the buffer, restores the draft, opens trip and pickup details, checks Escape/focus, rejects a passed deadline, interrupts the feed, and clears the deadline. Synthetic sessions use the repository's test identity helper.

Recorded-data command (paths point to the frozen local September 16 archive):

```sh
ARRIVE_BY_FEED=/path/to/payload.json \
ARRIVE_BY_WATCHER=/path/to/watcher.jsonl \
node scripts/arrive-by-check.mjs
```

Historical production command (before removal; do not run against the current site):

```sh
ARRIVE_BY_URL=https://yale-shuttle.fly.dev \
ARRIVE_BY_OUT=/tmp/arrive-by-production \
node scripts/arrive-by-check.mjs
```

Local validation on September 16: all **2,618 tests in 112 files passed**, backend/frontend type checks and the production frontend build passed, and the recorded-data browser checks passed with no page errors or horizontal overflow. Screenshots and the browser result are in `pr-preview/arrive-by-class/`.
