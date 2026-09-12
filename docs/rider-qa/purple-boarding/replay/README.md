# Purple boarding: recorded-feed comparison

Baseline: `6e0fb799ec2860663bb0bc4db255fdc20da39952`. Candidate: PR #234 after merging that baseline and narrowing rejection to positive evidence. [Source hashes](source-hashes.json) identify the tested files; the archived executed harness is included because its metadata reporting was subsequently improved without changing selection logic.

3,579 recorded payload frames, September 11, 2026, 05:31–20:29 ET. Selected the freshest valid payload in each 15-second bucket from the two watcher logs; 24 stale/invalid rows rejected, two gaps over 60 seconds reset history. Inputs and their original source hashes are included. Both arms use the same earlier topology/calibration snapshot. This is a comparison of recommendations, not an exact reconstruction of historical ETA accuracy.

## Live selection sweep

All eligible ordered stop pairs per line, sampled each minute. Each comparison starts from the same baseline pin and warm chronological estimator state; it is not a persistent rider waiting through the entire day. Counts are decisions, not distinct riders. “Different bus” and “later pickup” overlap; a different bus does not by itself prove a direction flip.

| Line | Decisions | Changed | Different bus | Later pickup >1s | Offered → no ride |
|---|---:|---:|---:|---:|---:|
| Red | 548,100 | 0 | 0 | 0 | 0 |
| Green | 104,490 | 9,114 | 3,069 | 9,100 | 0 |
| Purple | 60,233 | 14,993 | 4,926 | 14,993 | 0 |
| Blue West | 8,052 | 0 | 0 | 0 | 0 |

Every changed live decision has a same-bus, same-route occurrence witness: another pickup precedes the destination, with consistent ETA ordering. All explanations and bus coordinates are in [changes.jsonl.gz](changes.jsonl.gz). Fourteen Green bus changes had pickup differences of at most one second. Neither arm gained or lost a ride, and no changed decision moved pickup earlier by more than a second.

## Initial planner comparison

The actual baseline and candidate `planTrip` functions were called every 15 minutes for eight evenly spaced origin/destination pairs per route, plus Purple 127→22 and Red 48→72. The candidate retains the baseline's cold initial-planning policy. Each comparison restricts buses and routes to the line under test, so this does not measure competition across lines.

| Line | Plans | Changed | Different bus | Longer total trip | Offered → no ride |
|---|---:|---:|---:|---:|---:|
| Red | 405 | 0 | 0 | 0 | 0 |
| Green | 432 | 25 | 25 | 25 | 0 |
| Purple | 540 | 117 | 77 | 117 | 0 |
| Blue West | 64 | 0 | 0 | 0 | 0 |

[Every changed initial plan](plan-changes.jsonl) includes both boarding/alighting points. In this file `eta` and the summary's planner `later` counter mean **total trip seconds**, not pickup time. The original summary's planner `unexplained: 0` is an unused counter, not a claim that this grid has individual occurrence witnesses. The final harness omits that field.

The longer trips remove the original underpricing: a short static ride was incorrectly paired with the wrong physical pickup visit. For example Green 26→25 at 06:00 ET changes #325 / 503 seconds total to #300 / 2,089 seconds. Purple 24→10 at 05:31 ET changes its boarding stop from 25 to 24 and total from 2,720 to 3,289 seconds. Missing destination rows retain the baseline option rather than being interpreted as evidence against boarding.

## Representative GPS follow-through

Selection: first changed decision in each UTC three-hour bucket, up to four usable examples per line. A visit enters within 45m, and a later visit requires leaving 100m first; missing curb hits or a horizon over 90 minutes are unscorable. These eight examples corroborate the model's order, but share its source GPS and are not independent ground truth or a population accuracy score.

| Line / original bus | Pickup → destination | First pickup UTC | Pickup again UTC | Destination UTC |
|---|---|---|---|---|
| Green #325 | 26 → 127 | 09:52:34 | 10:11:35 | 10:14:45 |
| Green #325 | 26 → 127 | 12:03:20 | 12:12:20 | 12:16:00 |
| Green #325 | 26 → 25 | 15:06:11 | 15:58:35 | 15:59:51 |
| Green #325 | 26 → 25 | 18:06:17 | 18:57:14 | 18:58:34 |
| Purple #329 | 25 → 26 | 09:51:14 | 10:00:14 | 10:01:54 |
| Purple #329 | 127 → 26 | 12:12:10 | 12:51:10 | 12:55:37 |
| Purple #329 | 127 → 26 | 15:08:54 | 15:51:35 | 15:56:41 |
| Purple #329 | 127 → 26 | 18:11:37 | 18:50:34 | 19:05:54 |

[GPS examples with recommendation timestamps](gps-prespecified.json). For all eight, the bus revisits the pickup before reaching the destination. This is why waiting for the later visit or a different bus is appropriate.

## Reproduce with no browser

From the repository root, prepare a detached baseline worktree at the SHA above and install its service dependencies. Then:

```bash
mkdir -p /tmp/purple-replay
 gzip -dc docs/rider-qa/purple-boarding/replay/sep11-feed.jsonl.gz > /tmp/purple-replay/feed.jsonl
 gzip -dc docs/rider-qa/purple-boarding/replay/payload.json.gz > /tmp/purple-replay/payload.json
cd services/shuttle-v2
NODE_OPTIONS=--max-old-space-size=512 nice -n 19 node --import tsx scripts/eta-replay/recommendation-replay.ts /tmp/purple-replay/feed.jsonl /tmp/purple-replay/payload.json /absolute/baseline/services/shuttle-v2 /tmp/purple-replay/results
python3 scripts/eta-replay/gps-visit-examples.py /tmp/purple-replay/payload.json /tmp/purple-replay/feed.jsonl /tmp/purple-replay/results/changes.jsonl /tmp/purple-replay/results/gps-examples.json
```

`MAX_FRAMES=120` runs a small smoke slice. The full sweep used one low-priority Node process and no browser. The existing `scripts/eta-replay/rider-sim/run.ts` supports persistent waits, per-rider anchor memory, time-travelled calibration from a database snapshot, and paired before/after runs through `CLIENT_ROOT`. Its boarding adapter now invokes the candidate's shared visit helpers and requests destination arrivals; old baseline worktrees retain their old behavior. Its scoring tests pass, but a new full-day persistent-wait simulation was **not** run for this report.

The [browser replay](../browser-result.json) separately checks the actual reported Purple trip against 23 controlled feed responses. It selects outbound #329, shows a 1–5 minute pickup band and 16 minutes total, and shows no returning #332 boarding prompt. There were no page errors. [Updated screenshot](../candidate.jpg).
