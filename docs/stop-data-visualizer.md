# Stop data operator page

`/stats/stops` lets an operator inspect recorded bus visits and saved algorithm
comparisons before changing the estimator. It is linked from `/stats`, uses the
same read-only operator session, and has a separate Vite entry from the rider UI.

The page has two evidence sources:

- **Retained database:** choose an Eastern date, route, exact stop occurrence,
  and bus. Inspect standing durations, departures, same-bus return intervals,
  individual visits, and raw GPS distances. A 15-minute lead-in helps identify
  late recorded pin clocks. Missing GPS is explicit: raw positions generally
  expire much sooner than stop visits.
- **Saved study:** open a JSON export in the browser to inspect reconstructed
  labels beside the original recorded pin, saved baseline/candidate displays,
  physical arrival targets, and archived GPS. The file stays in the browser;
  it is never uploaded or served as a public asset.

The daily scatter and visit ledger select the same visit. The prediction panel
switches between total standing time, remaining wait, and downstream ETA; its
slider selects original query times. ETA bounds are the saved 10th/90th
percentiles when available. Each physical target arrival has its own identity
and selector. GPS lines break across gaps over 30 seconds and bus-ID changes,
and the distance plot can zoom to the 200 metres around the stop.

The second scatter relates **time away before reaching the stop** to the
subsequent stand. That x value excludes the current stand. The ledger also
shows completed departure-to-departure intervals, explicitly as observations.

## Reading the comparisons

First-total error uses each arm's original first **associated** display, before
pairing or export sampling. If that first display is not paired, a later pair
does not replace it. Remaining-wait error pairs exact query times, computes
truth from physical departure minus query time, averages within each visit,
then gives each visit equal weight. Passes, censored labels, invalid clocks,
and queries outside the physical stand are excluded from these scores while
their visits remain visible in the ledger.

The browser reports loaded sample counts and both directions of errors over
two minutes. Occurrence disagreements remain visible as tracking errors. The
page does not fit or publish models, simulate missing forecasts, or turn a
previously examined cohort into independent validation. Export provenance
records input SHA-256 hashes, source hashes, cohort/training descriptions,
pairing counts, sampling intervals, and the chosen downstream target.

For the saved September 8 regression data, the browser's Red / 344 Winchester
comparison reproduces the prior evaluation's 25 paired first displays:
134.8647 seconds baseline MAE and 71.1693 seconds candidate MAE. These are
existing replay results, not new evidence that the visualizer improved the
algorithm. Remaining error in this view describes the exported query sample.

## Run locally

From `services/shuttle-v2`:

```sh
npm ci
npm ci --prefix web
npm --prefix web run build
npx tsx scripts/stop-data/preview.ts --db /absolute/path/to/saved-snapshot.db
```

Open `http://127.0.0.1:8098/stats/stops` and use `preview-only-token`. The helper
backs the read-only snapshot up into a disposable database, starts no collector
jobs, disables external fetches, and binds only localhost. It removes the copy
on exit. See [export and preview instructions](../services/shuttle-v2/scripts/stop-data/README.md)
for study inputs, including `arrivalTargetStopId` to inspect a destination more
than one stop ahead.

The page's live data endpoints are `GET /api/stats/stops/catalog`,
`GET /api/stats/stops/visits?day=…&routeId=…&stopId=…&stopIndex=…`, and
`GET /api/stats/stops/visits/:id`. All require the operator cookie or admin
header, use `Cache-Control: no-store`, return only allowlisted fleet fields,
and enforce date, count, and GPS-window limits. No migrations or model changes
are part of this feature.

## Validation and previews

Unit coverage includes authentication, repeated stop occurrences, Eastern DST
boundaries, incomplete clocks, causal previous departures, query-only database
reads, payload caps, GPS gaps/identity changes, archive schema validation,
pairing/sampling, target identity, and comparison weighting. Both backend and
frontend TypeScript checks and the full test suite pass.

The browser check runs the built page in Chromium with a non-Eastern browser
timezone. It exercises login, local study import, route/bus filters, visit
selection, forecast targets, query scrubbing, invalid imports, and a 390-pixel
phone viewport. It checks for page errors and same-origin-only requests.

```sh
node scripts/stop-data/browser-check.mjs --study /path/to/study.json
```

Screenshots and their saved-data provenance are in
[the PR preview](../pr-preview/stop-data/README.md).
