# Continuous rider instrumentation

This versions the previously workspace-only continuous runner so measurement fixes are reviewable. `attach({page, ctx, outputDir, initialFeed, allowedLabels, fixedTrip})` receives an existing tester-seeded Playwright page/context; it launches no browser. Existing local supervision owns offline pause/resume. Imports use the repository canary helpers.

September 11 fixes:
- Brown's first `BOARD🚌Science Park Garage⏸ 14:04` row now resolves immediately. Exact lookup previously missed the icon/pause decorations, delaying identification until the bus left. The 45-minute timeout is excluded, not an app wait error.
- West Haven Train Station resolves as West Haven Station. Use the normal Enter action and verify saved destination coordinates within 80 m, rather than wait for an exact alias that is absent. A distant result fails the run instead of silently testing the wrong destination.
- Invalid/ambiguous stop labels skip boarding and mark accuracy excluded; no stale previous stop ID is reused. A changed board stop restarts walking. Hot handovers are marked excluded, and listener cleanup removes old callbacks.

Raw records remain unchanged. Output records identify `instrumentVersion: inputs-v2`, invalid stop samples and handovers. This is GPS-correlated simulation, not independent physical ground truth. Existing 200 MiB per-runner image caps remain; the two-role supervisor plus legacy gallery stays below the user's 2 GB limit.

Run `node --test scripts/rider-watch/inputs.test.mjs`. Live browser verification is recorded separately in the QA workspace. Local release copies only rewrite the two canary import paths for the companion watcher directory. No application bundle, estimator or service deployment is changed.
