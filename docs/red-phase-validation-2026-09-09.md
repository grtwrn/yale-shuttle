# Red Line phase-model evidence, September 9, 2026

The early recorded comparison did not exercise the Winchester phase model. A later raw-data replay, newly scored by this comparison, improved all three first total-wait estimates at Winchester. Division/Prospect ETA improved on average, but one of three arrivals worsened. This supports a useful effect in these examples; it does not establish general accuracy or a strictly held-out result.

The scope is Red route 3, Winchester stop 11 at occurrence 14, and Division/Prospect stop 48 at occurrence 17. All times below are Eastern. The [machine-readable summary](data/red-phase-validation-2026-09-09.json) includes exact numbers, hashes, clocks, coverage and exclusions. Raw positions, predictions and model artifacts remain in the ignored [local evidence archive](../services/shuttle-v2/store/red-validation-20260909/phase-0822-0955/).

## Early recorded window: 06:45:30.459–08:22:09.910

This compares the original registered `baseline-production-live` and `actual-served-context` arms, preserving absent contexts and fallback behavior. It uses the frozen client shadow driven by the received server payloads, not a logged rider phone. The network scorer initially stopped on duplicate physical-stop forecast keys; those duplicates affected other routes. Red was scored using the original registered scorer, with no measurement amendment or regenerated forecasts.

| Measure | Paired observations | Baseline MAE | Served-context MAE |
| --- | ---: | ---: | ---: |
| Winchester first total estimate | 2 holds | 51.99 s | 51.99 s |
| Winchester remaining time | 16 moments / 2 holds | 89.47 s | 89.47 s |
| Division ETA during a complete Winchester hold | 17 moments / 2 arrivals | 61.97 s | 61.97 s |
| All Red ETA, secondary | 1,151 moments / 66 arrivals | 71.43 s | 71.61 s |

All 23 recorded Winchester displays received some context for other stops; **none received matching Winchester context**. The first totals were unchanged for bus #119 at 07:34:20.776 and #306 at 07:56:20.945. Their actual pinned holds were 200.006 and 300.051 seconds, with total estimates of 287.985 and 284.051 seconds respectively.

Across all Red queries, contexts were present in 1,042 of 1,172 inputs before the 08:04:50 build replacement, and 2 of 406 afterward. Both periods remain in the primary comparison. The operational Winchester cell had a positive 0.70343 phase weight and a matching route pattern. No prior Winchester departure was visible in the bounded capture, but the omission reason was not logged: this does not prove the server lacked earlier history. Missing eligible same-bus history remains a possible explanation, not an established cause.

## Later replay: strictly after 08:22:09.910, through 09:55:53.271

Both arms use the unchanged PR source `e332cbaa9cfc4911bc97776d8103b64cb5437084`, identical frozen production calibration and published parameters. The baseline omits analytic contexts; the candidate uses the existing operational fit through `analytic-client-hook.ts`. No model parameters were changed using this window.

| Measure | Paired observations | Baseline MAE | Phase-model MAE |
| --- | ---: | ---: | ---: |
| Winchester first total estimate | 3 holds | 188.53 s | **40.10 s** |
| Winchester remaining time | 27 moments / 3 holds | 147.42 s | **79.17 s** |
| Division ETA during a complete Winchester hold | 27 moments / 3 arrivals | 119.24 s | **48.70 s** |
| All Red ETA, secondary | 1,780 moments / 91 arrivals | 102.93 s | 97.88 s |

The three first-total examples are estimates from `shown.typicalSec`, rounded here to the nearest second. They are not transcriptions of the current UI, which presents ranges.

| Bus | First recorded estimate time | Actual pinned hold | Baseline total estimate | Phase total estimate |
| --- | --- | ---: | ---: | ---: |
| #119 | 08:26:51.450 | 9m 16s | 4m 50s | 10m 30s |
| #306 | 09:00:22.967 | 2m 20s | 4m 50s | 2m 00s |
| #119 | 09:35:53.147 | 2m 20s | 4m 50s | 1m 55s |

All three first estimates improved; all 27 primary Division forecast vectors changed. Division error improved for two arrivals and worsened for one. Its paired arrival-bootstrap 95% interval for the MAE change is **−220.84 to +13.88 seconds**, crossing zero. There are only two bus/day blocks, so bootstrap intervals are descriptive, not evidence of reliability across service days.

The candidate recorded 643 successful positive-weight Winchester lookups in the scoring window, and 2,407 across Red; the baseline recorded zero. These are function calls, including repeated planner calls, not independent visits. Each arm had 33 recorded Winchester stand rows after the cutoff: 27 associated with complete physical holds and 6 outside them. All three eligible first estimates paired; no unmatched first was silently removed. Two original first estimates from the earlier warmup were excluded without promoting a later row.

## Frozen provenance and scoring rules

- The new window contains 2,246 Red position rows across 1,123 polls for buses #119 and #306, with no gap over 30 seconds. Earlier GPS is retained for browser-state warmup: 3,819 rows in total. No observation after 09:55:53.271 is included.
- Eight geometry captures agree on canonical pattern `3:643d62cc87a5f1be71b3cfef`. The copied source database's Red occurrence sequence, stop coordinates and polyline match the captures exactly.
- The source database is the read-only copy of `production-2026-09-09-0046.db`, SHA-256 `3497051dda04ab85d46949573b96605dcb5e1f9fe708450fddc926a544e773fa`. Production-table and fit cutoff is `2026-09-09T04:47:00Z` (00:47 Eastern). The phase fit contains no September 9 service-day training.
- The unchanged extracted operational fit has SHA-256 `207a38440ecea00d54409365ce29999df2d43869c08de63d2b4aa15aca9d1de8`; its original wrapper hash is `874642edbe48d00020fac9bec16b42017c6f49e4a4fb16df17c04ec0fb7680d6`. Captured parameters are version `fit-2026-09-08`, published before warmup, SHA-256 `13dfdd9743d91f0f4c7eac675578ec0f6c34da31bb2db1aa418a74b521639ff9`.
- Feature history retains the first completed captured server-visit version per bus, occurrence and anchor. Its `knownAt` is the archive's first observation of that completed version; later revisions are never moved earlier. All 158 retained histories resolve to the exact pattern. This conservative availability can differ from live server history.
- Prediction-blind physical labels are rebuilt separately from GPS: 158 complete visits (114 stopped and 44 passed) and 5 censored records across the full warmup plus scoring capture. These labels are used for scoring, not substituted into feature history.
- The actual client warms its belief state on every GPS update, querying stops and retaining every sixth poll for scoring. The original first valid recorded stand estimate is selected before time-window and pairing exclusions. First-estimate MAE uses the complete pinned hold; remaining-time MAE uses time to its departure. A browser's retained stand origin can differ from the reconstructed physical pin, as the recorded clocks in the summary show.
- Primary Division queries must originate during a unique complete Winchester hold. The target is the first future 50-metre Division crossing on the same continuous track, with current GPS outside that radius, within 30 minutes, and corroborated by one of the next five served occurrences. Arms pair on the same physical target. Targets or visits receive equal weight, with equal query weights within each.
- Both successful runs passed the frozen source/input checks (226 hashes). Initial v1 launches failed before prediction because of native-loader initialization; v2 changed preload order only. Failed logs remain preserved. Independent scoring reproduced the primary numbers and verified the original-first rule.

## Interpretation limits

This is a paired raw-data replay newly scored by this comparison, **not recorded prospective rider forecasts or a claim that the outcomes were globally untouched**. Earlier pause-display commit `ed68b30` and PR #185 described a rounded 9m 16s Winchester hold, attributed there to September 7, without a bus, time or report identifier. The available record does not establish whether that example is the same as or different from this September 9 hold. The phase fit predates September 9, but source/UI decisions may reflect earlier operator examples.

The earlier recorded and later replay comparisons differ in client source, calibration/exposure and history provenance. Their difference cannot isolate a single explanation for the morning null. The later result demonstrates activation and improved estimates for three holds, rather than proving why delivery failed earlier. It validates neither a subsequent motion-model change nor an optimal estimator. General client replay also does not reproduce the complete Trip/rider-simulator sequence; those evaluations use different targets and scoring units.

## Reproduction

The ignored local archive preserves both reports, original registration and manifests, copied inputs, original scoring code, predictions and activation reports. Historical absolute paths inside those original manifests remain unchanged. The checked-in JSON supplies compact results and hashes; raw data must be available locally to reproduce them.

From this repository, the following verifies the copied archive and pinned source, then reproduces the recorded later scores exactly without generating new predictions. Use an output path that does not already exist:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  services/shuttle-v2/store/red-validation-20260909/phase-0822-0955/reproduce_scores.py \
  services/shuttle-v2/store/red-validation-20260909/phase-0822-0955/reproduced-summary-2.json
```

The helper was run successfully against the preserved outputs. It requires the original pinned checkout at `/home/gwarren/wt/pr184-feedback/services/shuttle-v2`, including its Python scoring modules. To regenerate both client arms using durable copied inputs, retain that checkout and its dependencies at the pinned commit; do not substitute the experiment tree's newer runtime. With Node supporting `registerHooks`, run:

```sh
phase_artifacts=/home/gwarren/wt/red-conditional-eta/services/shuttle-v2/store/red-validation-20260909/phase-0822-0955
phase_source=/home/gwarren/wt/pr184-feedback/services/shuttle-v2
cd "$phase_source"
test "$(git rev-parse HEAD)" = e332cbaa9cfc4911bc97776d8103b64cb5437084
mkdir "$phase_artifacts/replay-new"
export TZ=America/New_York SOURCE_ROOT="$phase_source"
export EVAL_DATASET="$phase_artifacts/later/client-dataset-v1" EVAL_DAY=2026-09-09
export EVAL_DB="$EVAL_DATASET/artifacts/source.db" EVAL_FIT_AT=2026-09-09T04:47:00Z
export MODEL_PARAMS="$EVAL_DATASET/artifacts/captured-model-params.json"
export ANALYTIC_FIT="$EVAL_DATASET/artifacts/operational-fit.json"
export EVAL_LABEL_EPISODES="$phase_artifacts/later/rebuilt-labels-v1/2026-09-09/episodes.jsonl.gz"
export POLL_STRIDE=6 COMPARE_COLD=0 MAX_POSITIONS=
export RED_VALIDATION_AFTER=1788956529910
CONTEXT_HOOK= EVAL_OUT="$phase_artifacts/replay-new/baseline.jsonl.gz" \
  RED_AUDIT_OUTPUT="$phase_artifacts/replay-new/baseline.activation.json" RED_AUDIT_EXPECTED=0 \
  node --import tsx --import "$phase_artifacts/later/audit-preload-v2.mjs" \
  scripts/eta-replay/general-eval/client-replay.ts
CONTEXT_HOOK="$phase_source/scripts/eta-replay/general-eval/models/analytic-client-hook.ts" \
  EVAL_OUT="$phase_artifacts/replay-new/candidate.jsonl.gz" \
  RED_AUDIT_OUTPUT="$phase_artifacts/replay-new/candidate.activation.json" RED_AUDIT_EXPECTED=1 \
  node --import tsx --import "$phase_artifacts/later/audit-preload-v2.mjs" \
  scripts/eta-replay/general-eval/client-replay.ts
```

These replay commands write fresh outputs; the scoring-only helper above deliberately verifies and scores the preserved original outputs. Original launch instructions and SHA manifests are in `later/launch-manifest-v2.json`; the complete original scoring report is `later/scored-v2/report.json`, and the early recorded report is `early/report.json` within the archive. Older immutable artifacts may use stronger “held-out” or “display” wording; the interpretation and estimate terminology in this report supersede that wording.

A subsequent, separately frozen [09:55–13:59 Red comparison](red-phase-validation-later-2026-09-09.md) retains both archive-observed and causal reducer-history policies across eight additional Winchester holds. It reports the stronger fresh-history result alongside its overestimation tradeoff.
