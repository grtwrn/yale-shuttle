# Continuous rider instrumentation

## Local watcher

From `services/shuttle-v2`, run `node scripts/rider-watch/start.mjs`.
It uses installed Chrome on macOS or `/usr/bin/chromium`, with
`BOT_CHROMIUM_PATH` as an override. `BOT_BASE_URL` selects the target.
One mobile browser continuously chooses a random running line and random
stop pair, walks to pickup, boards through the UI, and follows live GPS to
the destination. It identifies as the excluded test rider.

Artifacts default to `scripts/.rider-watcher` (`WATCHER_DIR` overrides):
`status.json`, `events.jsonl`, `journeys.jsonl`, bounded UI samples and
screenshots, and an auto-refreshing `index.html` gallery. Serve locally with
`python3 -m http.server 8093 --bind 127.0.0.1 --directory scripts/.rider-watcher`.
Candidate issues require review; observations use the same GPS feed as the
app and are not independent physical arrival measurements. This launcher
does not deploy changes or submit rider reports.

For a detached run, use a process supervisor; redirect stdout/stderr to
`scripts/watcher.log`. The watcher PID is saved in the artifact directory as
`watcher.pid`. The browser restarts after a transport failure. On the team Mac
it runs under the launchd agent `com.grtwrn.yale-shuttle-rider` (KeepAlive,
starts at login); stop it with `launchctl bootout gui/$(id -u)/com.grtwrn.yale-shuttle-rider`
rather than killing the PID, which launchd would restart.

`RIDER_LINE` pins a rider to one line; adding `RIDER_FROM` (board stop id)
and `RIDER_TO` (stop id, or `ysph` for the School of Public Health landmark)
repeats one trip and idles while the line has no live bus. Give each rider
its own `WATCHER_DIR`. Since October 1 a second agent,
`com.grtwrn.yale-shuttle-rider-red`, rides Red from Division / Prospect (48)
to the School of Public Health with
`RIDER_LINE=Red RIDER_FROM=48 RIDER_TO=ysph WATCHER_DIR=scripts/.rider-watcher-red`,
logging to `scripts/watcher-red.log`, so every Red pickup after the
344 Winchester hold is observed for ETA experiments.

This versions the previously workspace-only continuous runner so measurement fixes are reviewable. `attach({page, ctx, outputDir, initialFeed, allowedLabels, fixedTrip})` receives an existing tester-seeded Playwright page/context; it launches no browser. Existing local supervision owns offline pause/resume. Imports use the repository canary helpers.

October 2 (redmissedboard20261002): the rider also boards when the card marks the followed bus at the pickup (`BOARD🚌`) and the feed agrees (`observedAtStop`: stationary, `at_stop_id`, ≤75 m), not only within 45 m of the stop pole. Red #119 stood at Division / Prospect 47 m from the pole for one poll at 16:02:02Z (card "At stop", "On Red #119?") and was missed. The card moved on to #308, 17 stops away. Blue Day #38 at Peabody (2026-10-01 16:09:05Z, 57 m) was missed the same way, costing 23 minutes. Across 105 retained runs, 25 board on an earlier poll this way, mostly by 10 s. A bus the card still lists as `· N stops away` is not boarded, even when the feed puts it at the stop.

October 4 (riderpromptmiss20261004): the at-stop offer ("On Purple #330? Detected near your board stop") lasts only while the feed puts the bus at the stop (`at_stop_id`), so it can go between the poll that decides to board and the click. Purple run 1791113952205: #330 stood at West Haven Train Station 47 m from the pole at 11:50:50Z. The app's next poll had it leaving, and "Yes, I'm on it" detached under the click. Playwright's 30 s default then waited for a button that never came back, sampling stopped for 40 s, and the run boarded #317 at 12:06Z and ended as `completed`. Now the offer is clicked with a 3 s timeout (`OFFER_CLICK_MS`; the 137 retained offer boardings all clicked within 1.3 s). If the offer has gone, the rider taps the card's "🚌 I'm on it", but only while our bus is the line's nearest within 100 m of the rider in the app's latest feed (`cardBoardsBus`, the app's `boardingBusName` rule). Otherwise the run ends as `boarding-missed-excluded` with a `boarding-missed` event (distance at the decision and now), instead of timing the next bus. The boarding decision itself is unchanged: within 45 m, or `BOARD🚌` with the feed observing the bus at the stop. A wrong stored bus still ends the run as `wrong-bus-boarded-excluded`, and a failed click with the offer still showing is retried on the next poll as before. The replay (`__fixtures__/purple-330-offer-gone-2026-10-04.json`) boards #330 through the card when the next app poll has it pulling away 62 m out (modelled, since that poll was not recorded), and ends the run as missed against the recorded 11:51:30Z poll (480 m out, card on #317).

October 3 (96f99a88): the wait cap follows the card's first quoted wait, as the ride cap does: 1.5× "Arrival: About N min", never below the old fixed 45 min (an unquoted wait keeps it) and never above 90 min, measured from the journey's start and recorded as `waitCapMin`. The rotation's "longest" fallback has no wait bound, so it can pick a trip whose wait is longer than 45 min. Grocery Ham run 1791026050850 got "About 44 min · Likely 33–60 min" at 11:14Z. #42 laid over at Aldi/Walmart and then held at Elm / York (TYCO) from 11:52Z, and the fixed cap ended the wait at 11:59:18Z. The next run on the same trip boarded it at 12:01:48Z, 47.6 min after the first run started and inside the quoted window. The replay (`__fixtures__/grocery-ham-long-wait-2026-10-03.json`) now boards at 12:01:48Z under a 66 min cap. Of 133 retained runs with a quote, 12 quoted over 30 min, and only this one hit the cap.

October 3 (riderbusoffroute20261002): a ride whose boarded bus stays in the feed but off its route ends as `bus-off-route-excluded` once two signals have agreed for more than 10 minutes on every poll with the bus: the feed puts it off the route (`busOnRoute`, the app's 500 m test against the route polyline), and the app's ride banner says "Looking for your bus…". A poll with the bus back on its route, or with the app tracking it, resets the clock. So a detour or a GPS jump is ridden through, and an app that loses an on-route bus (or tracks an off-route one) still rides to the cap for review. Polls without the bus don't reset it; the 10 min bus-left-feed rule covers those. The journey records `offRouteSince` and `offRouteFrom`; the `bus-off-route` event adds the last position and its distance to the exit. Before this, the last Pink #324 (run 1790978871687) turned back past Quigley Stadium Inbound at 22:38Z and deadheaded 7 km north, still tagged Pink, and the runner rode to its 50 min cap at 23:19:48Z. The replay of its 302 recorded polls (`__fixtures__/pink-324-off-route-2026-10-02.json`) now ends at 22:48:08Z. Of the 120 rides in the retained samples of both riders, only that one meets the rule; the one other off-route stretch, a completed Red #119 ride, lasted 1.5 minutes.

October 2 (riderbusgone20261002): a ride whose boarded bus is missing from a fresh feed for more than 10 minutes ends as `bus-left-feed-excluded`, the same 10 minutes after which the app says "Ride tracking stopped" (`BUS_ABSENT_MS`, web/src/rideEnd.ts). Stale feeds don't count. Before this, the riding phase only ended on arrival or the ride cap, so Pink #324 (run 1790893847183, last seen 22:42:24Z just after Pink's last loop) was ridden for another 38 minutes with nothing to score. `busLastSeenAt` records the last sighting. Across the 49 rides in the retained samples, no completed ride lost its bus for more than 5 minutes.

October 1 (riderwait20261001): once the followed bus is at the pickup the app drops its `🚌 #NN · N stops away` line and shows `BOARD🚌Stop⏸ 0:19`. The runner treated that as an invalid sample, so it skipped exactly the polls where it should board and half the runs timed out. A `BOARD🚌` dwell keeps the tracked bus while the app's own at-stop rule (`observedAtStop`, web/src/liveAnchor.ts: stationary, `at_stop_id`, ≤75 m) holds for it. While the tracked bus is still within 150 m of the stop but not observed there, the poll is skipped: the app may place it at the stop from route belief, and another bus listed at the stop is not the one being timed (Purple 2026-09-30 21:34:12Z: #321 at 75 m, #332 at the stop). Only when the tracked bus is gone does the single bus observed at the stop take over; several unknown buses fail closed. A poll with no followed bus (e.g. `Unavailable`) is skipped and counted as `unnamedBusSamples` without excluding the run; only unparsable stop labels still exclude. A waiting run whose line has no live buses for 5 minutes ends as `no-service-excluded` instead of waiting 45 minutes.

September 16: focus and activate the trip card with Enter so its nested ETA disclosure does not intercept a centre click. Install the matching canary helpers alongside a runner release: they parse the two-line arrival summary and measure movement of its visible estimate, keeping the interval for coverage scoring. A broad interval must not hide a jumping headline.

September 11 fixes:
- Brown's first `BOARD🚌Science Park Garage⏸ 14:04` row now resolves immediately. Exact lookup previously missed the icon/pause decorations, delaying identification until the bus left. The 45-minute timeout is excluded, not an app wait error.
- West Haven Train Station resolves as West Haven Station. Use the normal Enter action and verify saved destination coordinates within 80 m, rather than wait for an exact alias that is absent. A distant result fails the run instead of silently testing the wrong destination.
- Invalid/ambiguous stop labels skip boarding and mark accuracy excluded; no stale previous stop ID is reused. A changed board stop restarts walking. Hot handovers are marked excluded, and listener cleanup removes old callbacks.

Raw records remain unchanged. Output records identify `instrumentVersion: inputs-v2`, invalid stop samples and handovers. This is GPS-correlated simulation, not independent physical ground truth. Existing 200 MiB per-runner image caps remain; the two-role supervisor plus legacy gallery stays below the user's 2 GB limit.

Run `npm test -- scripts/rider-watch/inputs.test.mjs`. Live browser verification is recorded separately in the QA workspace. Local release copies only rewrite the two canary import paths for the companion watcher directory. No application bundle, estimator or service deployment is changed.
