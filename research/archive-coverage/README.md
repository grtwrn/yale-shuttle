# Archive coverage evidence

This hosted research gate distinguishes file integrity, transport integrity,
closed-day provenance, observed service coverage, and sampled prediction
coverage. It changes no production code, archive contents, schedules or watcher.
No full scans, replay, model fitting or tests run on the Pi.

The workflow pins public fleet data at research revision
`e2d0468e7f1890be0fc5a2a9498f35daa23234ce`, with per-file manifest hashes and an
independently pinned all-route topology hash. It deliberately includes Orange
Day's known September11/14/15 GPS loss and September16–18 for comparison.
Successful CI means the audit and regression checks passed, **not** that the
archived days qualify as complete training or evaluation inputs.

Run `coverage.py --help` on a hosted runner for arguments. Inputs support either
a research `manifest.json` with `sources:[{path,bytes,sha256,...}]` or original
per-day `YYYY-MM-DD/manifest.json` files with the archive's `tables` mapping.
Required files for a complete-day comparison are GPS, visits, arrivals and
predictions. Extra fleet tables are accepted only from the archive allowlist.
The `--require-complete` option fails when any audited route/day cannot support
a complete-day comparison. Without it, the command produces diagnostics; the
JSON flags remain authoritative. Scope a proposed route/day separately before
using this conservative gate; an unpublished or non-operating route with no
independent service evidence is **unknown**, not a failed prediction model.

For each file the audit verifies SHA256, declared byte and row counts where
present, gzip/JSON readability, original column sets where recorded, timestamp
bounds and duplicate identity conflicts. If raw API headers/trailers are
preserved, it also checks header day/table/bounds, the final trailer and its row
count. A legacy file without wrappers remains `stream:not_preserved`; hashes
do not manufacture proof that production exported everything it once collected.
Closed/partial status comes from the original export timestamp, not the current
clock or later research freeze. Later freezes without original metadata remain
`unknown_export_finality`. Missing original arrival files are explicit.

The output reports 15-minute bins by route and normalized public bus number.
A visit/arrival bin with no matching GPS is a service-coverage gap, even if an
empty GPS file was successfully transferred. Completed nongap visits also get
a separate endpoint/interior screen: GPS within30 seconds of arrival/departure
and no interior gap over60 seconds. This does not establish route-occurrence
truth, detector accuracy or that an entire source-to-pickup journey is safe to
score. Scored experiments must keep their own stronger continuity/identity
gates. Visits crossing midnight conservatively need adjacent-day context that
this per-day diagnostic does not merge.

`predictionSurfaces` and `clientBuilds` stay separate. Browser prediction logs
cover viewed stops on sampled page loads, not every bus/stop. `upstream` rows
cannot fill missing rider observations. `client_build` does not identify
server-only estimator changes; archive `build` identifies the export server,
not necessarily the code that originally produced a row. Preserve deployment
boundaries, server/model revisions, topology and original manifests for new
experiments. The audit contains no rider reports, identities or coordinates.

For newer frozen inputs, copy the existing successful nightly archive into an
immutable research input directory, preserving the original day manifest, then
hash the copies. Do not rerun into or replace the canonical archive. The normal
03:40 ET export fits inside36-hour GPS retention; if it fails, use the existing
admin-header-only archive API into a separate destination before retention
expires. Preserve original API wrappers when possible. Export failures and
partial captures must remain failures until coverage is demonstrated.

Without independent archived poll heartbeats or a service schedule, a period
missing from *all* streams cannot be proved inactive. This limitation remains
explicit rather than treating an absence of evidence as complete service.
