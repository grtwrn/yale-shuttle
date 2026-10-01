# Trip scheduling preview

Built-SPA captures at 360 px after removing the separate Arrive by bar:

- [Live trip](live-360.png): Plan for later remains available, and the Red card keeps its estimated destination arrival window.
- [Future trip](future-360.png): the departure picker and Now action remain available; future arrival times stay approximate estimates.

The test uses synthetic shared-server forecasts and blocks all external requests.
The gray basemap is intentional fixture isolation, not a production map failure.
The browser starts from a saved legacy draft containing a class deadline, which
is ignored without losing the trip.

Reproduce from `services/shuttle-v2` after installing its and `web/` dependencies:

```sh
npm --prefix web run build
node scripts/trip-scheduling-check.mjs
```

`BOT_CHROMIUM_PATH` overrides `/usr/bin/chromium`; `TRIP_SCHEDULING_OUT` chooses
an output directory. The harness also checks 390 and 1280 px, keyboard activation,
future planning, return to Now, expanded trip details, destination text overflow,
draft migration, and both watcher card readers. It closes its isolated browser.
