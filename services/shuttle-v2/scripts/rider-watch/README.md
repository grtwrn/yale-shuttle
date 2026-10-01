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

This versions the previously workspace-only continuous runner so measurement fixes are reviewable. `attach({page, ctx, outputDir, initialFeed, allowedLabels, fixedTrip})` receives an existing tester-seeded Playwright page/context; it launches no browser. Existing local supervision owns offline pause/resume. Imports use the repository canary helpers.

October 1 (riderwait20261001): once the followed bus is at the pickup the app drops its `🚌 #NN · N stops away` line and shows `BOARD🚌Stop⏸ 0:19`. The runner treated that as an invalid sample, so it skipped exactly the polls where it should board and half the runs timed out. A `BOARD🚌` dwell keeps the tracked bus while the app's own at-stop rule (`observedAtStop`, web/src/liveAnchor.ts: stationary, `at_stop_id`, ≤75 m) holds for it. While the tracked bus is still within 150 m of the stop but not observed there, the poll is skipped: the app may place it at the stop from route belief, and another bus listed at the stop is not the one being timed (Purple 2026-09-30 21:34:12Z: #321 at 75 m, #332 at the stop). Only when the tracked bus is gone does the single bus observed at the stop take over; several unknown buses fail closed. A poll with no followed bus (e.g. `Unavailable`) is skipped and counted as `unnamedBusSamples` without excluding the run; only unparsable stop labels still exclude. A waiting run whose line has no live buses for 5 minutes ends as `no-service-excluded` instead of waiting 45 minutes.

September 16: focus and activate the trip card with Enter so its nested ETA disclosure does not intercept a centre click. Install the matching canary helpers alongside a runner release: they parse the two-line arrival summary and measure movement of its visible estimate, keeping the interval for coverage scoring. A broad interval must not hide a jumping headline.

September 11 fixes:
- Brown's first `BOARD🚌Science Park Garage⏸ 14:04` row now resolves immediately. Exact lookup previously missed the icon/pause decorations, delaying identification until the bus left. The 45-minute timeout is excluded, not an app wait error.
- West Haven Train Station resolves as West Haven Station. Use the normal Enter action and verify saved destination coordinates within 80 m, rather than wait for an exact alias that is absent. A distant result fails the run instead of silently testing the wrong destination.
- Invalid/ambiguous stop labels skip boarding and mark accuracy excluded; no stale previous stop ID is reused. A changed board stop restarts walking. Hot handovers are marked excluded, and listener cleanup removes old callbacks.

Raw records remain unchanged. Output records identify `instrumentVersion: inputs-v2`, invalid stop samples and handovers. This is GPS-correlated simulation, not independent physical ground truth. Existing 200 MiB per-runner image caps remain; the two-role supervisor plus legacy gallery stays below the user's 2 GB limit.

Run `npm test -- scripts/rider-watch/inputs.test.mjs`. Live browser verification is recorded separately in the QA workspace. Local release copies only rewrite the two canary import paths for the companion watcher directory. No application bundle, estimator or service deployment is changed.
