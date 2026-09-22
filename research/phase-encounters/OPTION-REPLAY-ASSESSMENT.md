# Complete option replay: data feasibility assessment

September22,2026. Read-only source/schema assessment; no new capture, browser, fitting, scoring, production change, or September23–29 outcome inspection. The643 Blue labels without an identified earlier encounter remain unvalidated, and encounter censors remain unchanged.

## Existing forecasts cannot reconstruct a historical rider's option set

`predictions_log` intentionally stores a sampled public bus-to-stop reading, not a rider session or option snapshot. It omits rider origin/destination, walking position, plan identity, board/alight pair, selected/countdown bus, UI visibility, pin state, rank state, refresh actions and feed receipt/failure clocks. Those fields cannot be recovered from the archived rows.

Three lossy operations are explicit in the source:

1. `web/src/shownLog.ts::noteShown` rounds time to a15-second bucket and uses **busName:stopId:bucket:surface**, first write wins. Neither route occurrence nor `stopsAhead` is part of this key. Two future visits of the same bus to the same stop collapse. The batch cap and sampled loads also mean absence is not proof a forecast was unavailable.
2. `src/server/predictions.ts::record` uses **busId:stopId:bucket:surface**, first write wins both in memory and `predictions_shown_uniq`. It merges reporters from unrelated browsers. Provider, route and `from_stop_id` come from the server fleet at receipt; `from_stop_id` is not the client's priced anchor. The stored timestamp is a quantized reported-age clock, not a complete payload's forecast/receipt clock.
3. `research/canonical-windows/replay.ts` deduplicates by **predicted_at,bus_name,route_id,to_stop_id**, preferring `trip`. Its feature projection omits provider ID, surface and client build. Some provenance may be rejoined from the original rows where unique, but that cannot recover lost occurrences or browser option membership.

`TransitMap` calls `noteShown(live,"trip",nowMs)` after filtering boarding visits for one board/alight pair. Logged trip rows therefore neither enumerate every possible stop pair nor preserve the complete destination visit list. Grouping equal timestamps would combine unrelated observers, discard unreported alternatives, and invent a joint option set.

## What the frozen artifacts actually preserve

| Artifact | Useful preserved information | Missing for complete options |
|---|---|---|
| Run35677536788 `raw_positions.jsonl.gz` | All1,487,970 supplied observations; provider/name/route, coordinates, heading, last-stop hint and observation time | Historical full public bus state (`at_stop_*`, stationary clocks, lap context), server ETA payloads, received/failure clocks, historical published model/calibration/checkpoints |
| Same run `predictions_log.jsonl.gz` | Original sampled bus-target point/low/high, hops, provider, surface and client build | Complete contemporaneous bus/stop-occurrence set and the client state above |
| Canonical `features*.jsonl.gz` | Causal reconstructed phase/origin evidence and asof for sampled targets;15s-delay variant | Unqueried targets and options; actual server/client state parity |
| Canonical `unscored.jsonl.gz` | All38,047 sampled feature rows, deployed values and frozen/rolling K candidates before label attachment | All-bus/all-target candidate export; joint pickup/destination option sets |
| Canonical `forecasts.jsonl.gz`, older scored files | Accepted physical-outcome samples attached to forecasts | Excluded/no-label rows and contemporaneous alternatives; must not define the option population |
| Canonical training visits and directed-phase/encounter artifacts | Full reconstructed occurrence/knownAt evidence and independent physical ambiguity, including retained barriers | Public ETA beliefs, calibrated payload, user selection state; future visits cannot supply missing asof input |
| Topology, preparation and exported route models | Explicit fixed research geometry, waits and selected fitted exports | A historical time series of every deployed calibration/model/topology version; selected route exports are not a complete all-route candidate wire |

A complete fixed-scenario **counterfactual** could eventually replay all supplied GPS with predeclared calibration/model state, all targets, a pinned client and synthetic trips. It would not reproduce actual historical rider menus. Substituting a present-day fit, reconstructed future visit, or selected scored bus for a missing option would invalidate even that narrower interpretation.

## Existing capture/watchers checked by source and schema

- `/home/gwarren/projects/yale-shuttle-watcher/ongoing-rider-qa/runner.mjs` delegates to `releases/pickup-range-v6/runner.mjs`. Its retained sample is `{at,runId,phase,feedAgeMs,text,buses:feed.buses}`. It keeps a full response in process memory but discards `server_eta`, topology, calibration and model fields from samples. Other inspected runner releases use the same sample shape. UI text and synthetic journey metadata are not a full option-input snapshot.
- `ongoing-rider-qa/supervisor.mjs` fetches `/api/buses` every15s and uses it to manage existing QA. It persists status, not complete responses. This review did not change or start it.
- `/home/gwarren/shuttle-captures/record-all.sh` saves raw-position database fields, not `/api/buses` payloads. The checked `positions-*.jsonl` filenames are September3–10.
- `/home/gwarren/yale-shuttle/services/shuttle-v2/scripts/eta-replay/general-eval/capture.mjs` saves an entire reserialized `buses.json.gz` once per archive-capture iteration, default15min, after sequential table pulls. Existing September9 timestamped filenames were inspected. A schema-only check of `2026-09-09T03-39-31.840Z/buses.json.gz` confirms routes/paths/stops/segments/dwells/pace/model parameters/service metadata and bus fields, but **no `server_eta`**. This is useful historical calibration context, not a continuous served-forecast recording. Its capture-start timestamp is not an exact fleet response receipt clock.
- `services/shuttle-v2/scripts/eta-replay/watcher-replay.ts` explicitly supplies one fixed calibration payload, restores per-trip estimator memory, and handles Red only. Its own header says calibration is not reconstructed historical polls. It cannot establish contemporaneous all-route option parity.
- The new immutable `capture.py` in `ongoing-window-research/capture-tools/f72e39bff61dba6632e9a6b03c7f8cf6bbc1708e/` preserves original `fleet-before.json` and `fleet-after.json` bytes plus request times/HTTP Date/hash and health build around each export. The existing September21 freeze filenames were inventoried without reading outcomes. These isolated complete snapshots cannot establish30-second ranking continuity between them.

## Feasible prospective public-response sidecar

The public full response already supplies the necessary **forecast and planning** fields for a predefined synthetic observer. A lightweight recorder can preserve that response, and hosted research can run the actual deployed frontend exports over it. No client ETA fit or extra browser is necessary, and recording a served `server_eta` wire avoids inventing the server's posterior/checkpoint history.

Required endpoints:

- **GET `/api/buses`**, preserving the exact URL/query, successful body bytes and failures. Keep the whole response: fleet and observation clocks; published routes and paths; stop coordinates/names; every segment/dwell field, including occurrence keys and pace/lap carriers; service hours/active flags; model parameters; complete `server_eta.buses`, row arrays, row-aligned distributions, `at`, `servedAt`, version and trial metadata. Never deduplicate wire rows by bus/stop or slice to the eventual selected route.
- **GET `/healthz`**, to bracket server build identity. A release between brackets is a version ambiguity, not permission to attach the latest build retrospectively.
- **Deployed root HTML and referenced rider bundle identity**, recorded when the release changes, with a verified source/build mapping for the actual exports. The public ETA wire captures served forecasts; frontend source/bundle identity is still needed to reproduce option logic and bundled schedules/walk constants.

No geocoding, `/api/shown`, reports, notifications, rider identifiers or private locations are required. Synthetic coordinates can be fixed public stop/landmark coordinates. `/api/stats`, extra model endpoints and archived outcomes are unnecessary for this input-only capture. An optional `/api/buses?eta_model=usual` comparator needs its own predeclared purpose; pair only matching forecast/fleet snapshots and report unmatched requests. Two sequential responses are not automatically atomic.

For every fetch retain request start, response receipt, status/error, HTTP Date, original-body hash and an immutable response ID. Retain server forecast `at`, `servedAt` and every bus's `observed_at` separately. `attachServerEta` computes effective source time as `receivedAt-(servedAt-at)`; replacing that with a newly computed option time would refresh stale evidence. Keep original stale/malformed/missing responses and request gaps. A chosen sampling cadence defines this synthetic observer;15s samples cannot prove every intermediate5s production change was seen.

## State required for an actual-export hosted replay

Freeze before capture/evaluation: scenario coordinates/stop IDs, plan-start times, targetDate/live mode, remaining-walk schedule, poll/render clock, refresh/replan rules and release-transition policy. No trajectory may be inferred from a real rider or chosen after seeing a preferred bus.

The hosted consumer must apply the actual feed preparation: service filtering, paths/model-parameter registration and `attachServerEta` to the exact bus-array instance. The wrapper distinguishes an attached unavailable live source from an offline array; accidentally passing an unattached array invokes the local estimator and changes the experiment.

It must then preserve the real state transitions:

1. `planTrip` generates every eligible board/alight candidate, selects a pair per route, applies its route cap and walk option. Preserve its initial `stableOptions`, initial bus pins and planned ride times for that scenario plan epoch. Replanning afresh at every poll does not mirror the memoized component.
2. Reuse the actual live option-update path, including raw at-stop eligibility, all boarding/destination occurrences, `rideBoardArrivals`, `pickLiveArrival`, countdown-versus-boardable identity and `journeyArrival`. Calling only `planTrip` and the ranker misses the component's live pricing and selected bus changes. If this update path is not exported, a reviewed shared pure extraction with parity tests is needed; do not implement a research lookalike silently.
3. Persist `stableTripOrder`'s previous order, tier signature and pending order/since clock; the hold is30s. Preserve destination/refresh reset rules and third-visible-option state when testing actual visibility. Unknown destination windows still affect ordering through the pickup lower bound and an infinite upper bound.
4. Record all pre-rank and ranked options, hidden/capped reasons, board/alight pairs, route tiers, point and full destination windows, countdown and boardable evidence, and state transitions. Within a response, identify a forecast occurrence by response ID plus row ordinal/bus index/route/stop/hops; `stopsAhead` is relative, not a durable cross-poll visit ID.

This supports reproducible **deployed forecasts plus actual frontend selection for fixed synthetic scenarios**. It does not reconstruct historical private trips or establish boarding availability. Candidate overlays must consume the same complete snapshot and use the actual exported candidate implementation with explicit all-target fallbacks; the existing sampled K rows alone cannot supply missing destination/bus forecasts. Keep encounter/continuity barriers as a separate safety ledger, including all32 existing barriers. No relaxation or collection has been performed by this assessment.
