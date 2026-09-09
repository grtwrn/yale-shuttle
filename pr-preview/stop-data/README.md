# Stop data operator preview

These screenshots show the built `/stats/stops` page using saved fleet data.
The local server uses a disposable copy of the September 9 00:46 database
snapshot, a synthetic operator login, and no external requests or collector
jobs. The saved-study file is imported locally in the browser.

- [Retained visits, desktop](retained-desktop.png): September 8 Red Line visits
  at 344 Winchester. The original detector has 28 visits and 27 measured
  standing durations; old GPS has expired from this database snapshot.
- [Saved comparison, desktop](study-desktop.png): the same stop/date with
  independently reconstructed labels and saved baseline/candidate predictions.
  There are 25 completed, paired first displays. The selected 8:25 AM bus #307
  visit stood for approximately 9.8 minutes.
- [Division / Prospect ETA and GPS](study-arrival.png): the same 8:25 AM visit,
  showing the physical arrival target at stop 48, original predicted bounds,
  the query-time slider, and archived GPS. The target is three served stops
  ahead of Winchester. This does not claim the candidate wins every visit.
- [Phone layout](mobile.png): the study at 390 pixels wide. Charts and tables
  scroll within their panels; the page does not overflow horizontally.

September 8 is an already-examined regression cohort. The displayed forecasts
were saved by the earlier algorithm evaluation; this PR builds the inspection
tool and does not modify the estimator. The study contains all routes for the
day: 5,461 visits, 5,871 sampled paired standing query times, 228 paired arrival
query times for the selected target stop 48, and 93,951 GPS fixes in 37 tracks.

[provenance.json](provenance.json) records source and bundle SHA-256 hashes,
sampling, model context, source counts, and the exact selection.
[checks.json](checks.json) records browser interactions and zero page errors.
The full data bundle stays outside committed/public assets.

Reproduce from `services/shuttle-v2`, using your saved snapshot and study:

```sh
npm --prefix web run build
npx tsx scripts/stop-data/preview.ts --db /path/to/saved-snapshot.db
# In another terminal:
node scripts/stop-data/browser-check.mjs --study /path/to/study.json --out /tmp/stop-data-shots
```

See [the feature guide](../../docs/stop-data-visualizer.md) and
[export instructions](../../services/shuttle-v2/scripts/stop-data/README.md).
