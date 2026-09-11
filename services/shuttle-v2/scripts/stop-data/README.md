# Local operator preview

Build the web app, then run from `services/shuttle-v2`:

```sh
npm --prefix web run build
npx tsx scripts/stop-data/preview.ts --db /absolute/path/to/snapshot.db
```

Open `http://127.0.0.1:8098/stats/stops`. The local sign-in token is
`preview-only-token`; it is unrelated to production credentials. Optional
arguments are `--port 8098`, `--staticDir web/dist`, and
`--now 2026-09-09T00:46:00-04:00` (ISO timestamp or epoch milliseconds).
Without `--now`, the clock stays fixed at the latest saved GPS/visit timestamp.

The helper opens the supplied snapshot read-only and uses SQLite's backup API
to create a disposable copy under `/tmp`. Only that copy receives any schema or
application writes. It loads persisted route topology, starts no collector or
background jobs, disables external fetches, and serves only visualizer routes
on `127.0.0.1`. Ctrl-C or SIGTERM closes the server and removes the copy.

Saved comparison studies can be imported through the page's local JSON import.
The source snapshot and original worktree remain untouched.

## Export a saved comparison

The exporter reads explicit archive paths and packages their saved values. It
does not run an ETA algorithm, fit a model, fetch live data, or modify a source
database. It supports every route and stop represented in the supplied files.
Names and coordinates come from the optional captured topology JSON; numeric
labels remain usable without it. Topology supplies labels, not replacements
for the episodes' saved route-pattern and occurrence identifiers.

Create an input configuration such as:

```json
{
  "title": "Saved comparison for an observed service day",
  "topology": "archive/topology.json",
  "forecastIntervalSec": 30,
  "positionIntervalSec": 5,
  "modelLabels": {
    "baseline": "Existing estimator",
    "candidate": "Saved candidate"
  },
  "context": {
    "cohort": "Describe this day as development, confirmation, or regression.",
    "training": "Name the actual training window and published parameters.",
    "comparison": "Describe the saved replay and its label source."
  },
  "days": [{
    "episodes": "labels/day/episodes.jsonl.gz",
    "recordedEpisodes": "archive/day/episodes.jsonl.gz",
    "matches": "labels/day/matches.jsonl.gz",
    "baselineStands": "paired/day/baseline.associated.stands.jsonl.gz",
    "candidateStands": "paired/day/candidate.associated.stands.jsonl.gz",
    "baselineEtas": "paired/day/baseline.matched.jsonl.gz",
    "candidateEtas": "paired/day/candidate.matched.jsonl.gz",
    "positions": "archive/day/positions.jsonl.gz",
    "manifests": ["labels/day/manifest.json", "replay/day-baseline.manifest.json", "replay/day-candidate.manifest.json"]
  }]
}
```

Paths resolve relative to the configuration file. Add more `days` entries for a
combined study, subject to the size limit. `recordedEpisodes`, `matches`,
`positions`, and both ETA files are optional; supply ETA files together.
`arrivalTargetStopId` is an optional top-level numeric filter for a particular
downstream boarding stop, including stops several served hops away. Without
it, the exporter selects the next served physical arrival. The chosen filter
is recorded in provenance. It never pairs an ETA with a different physical
arrival or guesses a current visit from a nearby timestamp.

```sh
node --import tsx scripts/stop-data/export-study.ts \
  --config /absolute/path/to/inputs.json \
  --out store/stop-data-preview/study.json
```

Create the output directory first. The command refuses to overwrite an
existing output and writes with mode `0600`. Keep captured configurations and
exports under ignored `store/`, outside committed source. Import the resulting
JSON through the operator page. The file is parsed locally in the browser; it
is not uploaded. The versioned `saved_study` contract has a **25 MiB** limit,
strict field validation, finite numeric values, unique visit/forecast keys,
and consistent physical-arrival identities. Oversized files require fewer
days or a larger, explicitly disclosed sampling interval.

The export preserves these distinctions:

- `pinnedAt` is the reconstructed pin. `recordedPinnedAt` is the original
  stored pin only when the saved match is unique. Missing or ambiguous matches
  remain missing. `observedStartAt` is the browser clock inferred from the
  saved issued time and elapsed time. All timestamps are epoch milliseconds;
  durations are seconds.
- Complete standing totals require an uncensored stopped visit. Censored,
  passed, unmatched, and prediction-free visits remain in the ledger without
  manufactured truth. Earlier departures for loop comparisons come from
  complete uncensored stopped visits of the same route, pattern, occurrence,
  bus, and service day.
- `predictedTotalSec` preserves `shown.typicalSec`; `displaySec` preserves
  exactly what the saved display used. `predictedRemainingSec` is populated
  only when that saved display showed remaining time. No subtraction is used
  to invent a missing forecast.
- Display queries are paired before joint sampling. The first common query
  of each visit is retained, followed by the requested minimum interval.
  `firstCapturedDisplay` is assigned from each arm's original **associated
  display rows before pairing or sampling**. A later common row never becomes
  an original first. The associated cohort is not every rider display; missing
  rows cannot establish that nothing was displayed. Occurrence disagreements
  remain flagged as tracking errors.
- Downstream bounds are the saved ETA interval values, including negative
  lower bounds. They are not a complete predictive distribution and do not
  support recomputing a distribution score. Associations require both arms to
  share the query, current visit, target occurrence, and physical arrival.
- GPS is normalized into `positionTracks` by route, bus id, and bus name, so
  overlapping visit windows do not duplicate every fix. First and last fixes
  and both sides of raw gaps over 30 seconds are retained, even when sampling
  less frequently. A five-second minimum interval can omit a slightly earlier
  jittered poll; `0` keeps every fix. `gapSec` records adjacent raw observation
  gaps, not the interval between sampled points. The page selects the visit's
  surrounding window and computes distance to its selected stop. Missing
  observations across a day boundary are still missing.

Provenance includes SHA-256 hashes for every input, including topology,
manifests, and configuration, plus the exporter/schema and saved source
hashes. Input names exclude private absolute paths. Counts disclose source
rows, pairing losses, exported queries, and GPS sampling. Cohort and model
labels are supplied descriptions, not a new claim of independent validation.

Focused checks use synthetic data and require no archives:

```sh
npx vitest run src/schema/stop-study.test.ts scripts/stop-data/export-study.test.ts
```
