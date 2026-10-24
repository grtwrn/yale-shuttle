# Fleet countdown watcher

This local operator process reads the live evaluator's flushed gzip journals.
It makes no HTTP requests and does not execute the estimator, change the
evaluator or publish model parameters. It complements the two virtual riders:
it examines original published offers for every route, bus and physical stop.

The detector reuses the canary's existing 180-second large-change threshold,
120-second comparison window and 120-second return tolerance. It compares
absolute arrival times under the same public travel anchor. A jump and return
is a review candidate, not a confirmed ETA error. It preserves every offer and
all 50 quantiles, including repeated physical-stop calls, ties and explicit
following visits. GPS, calibration and stand changes are attached as context;
they do not automatically suppress a candidate. Overlapping stop candidates
share a bus episode ID; evidence may arrive in several immutable parts.

`state.json` atomically checkpoints the source namespace, verified compressed
prefix, detector state and recent original frames. A fresh process can finish
a jump begun before restart. Build, epoch, source-key, cycle, cursor and clock
gaps break comparisons explicitly. A cold start covers the latest two minutes
of available journals; it does not claim earlier coverage. Missing forecasts
and fresh empty feeds remain distinct from physical service outcomes.

Run from `services/shuttle-v2`, using the same Node/tsx environment as the
local observer:

```sh
node --import ./node_modules/tsx/dist/loader.mjs scripts/countdown-watch/poll.mjs
```

Schedule the one-shot process every 30 seconds. `COUNTDOWN_WATCH_ROOT` overrides
the read-only native input root (default `scripts/.learning-loop`);
`COUNTDOWN_WATCH_DIR` overrides its separate output root (default
`scripts/.bot-artifacts/countdown-watch`). Overlapping input/output paths are
refused. Enable independent health supervision with
`LEARNING_WATCH_COUNTDOWN_STATUS` pointing to its `status.json`. The learning
health monitor flags stale coverage, namespace mismatches and storage failures
using its existing three-check confirmation rule. Countdown candidates remain
local operator findings and are not sent as rider alerts or closed reports.

`findings/<id>.json.gz` contains complete original source frame JSON/context
and every triggering forecast triple. Findings are content-addressed; retries
after a checkpoint failure reuse the original bytes. Unreviewed and orphaned
evidence is protected up to 256 MiB. Saturation leaves the committed cursor
unchanged and reports failure, rather than discarding evidence. Checkpoints
are bounded to 64 MiB and individual findings to 8 MiB compressed/64 MiB raw.

After reviewing a finding, write a separate `reviews/<id>.json` receipt:

```json
{
  "id": "<64-character finding ID>",
  "status": "reviewed",
  "reviewedAt": "<ISO timestamp>",
  "note": "<finding and follow-up decision>",
  "bundleSHA256": "<SHA-256 of the original .json.gz bytes>"
}
```

Only matching review receipts authorize rolling deletion. Reviewed evidence
is retained for seven days within a 64 MiB budget. Review receipts remain
separate from original evidence; an invalid or mismatched receipt leaves its
finding protected. Findings do not certify physical accuracy or model gates.
Review receipts expire with their reviewed bundles; a receipt left alone by a
crash is removed after the same seven-day interval.
