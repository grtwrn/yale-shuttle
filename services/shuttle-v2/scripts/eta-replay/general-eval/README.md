# General ETA evaluation

This directory contains offline extraction, model interfaces and paired scoring. It does not change production code. Run commands from `services/shuttle-v2`.

## Frozen cohorts

- **September 3:** discovery/training. The raw capture begins at 09:51 ET.
- **September 4:** model selection/development validation. After selection, the chosen specification may be refitted on completed September 3–4 observations before confirmation.
- **September 5–6:** reserved confirmation for this study. These are weekend service patterns. Historical repository reestimation already used these dates, so they are not claimed to be globally untouched.
- **September 7:** reserved partial cohort: only 00:00–00:17 ET is captured. It cannot establish holiday/daytime performance.
- **September 8:** regression only. These failures and labels influenced the earlier investigation and model choices.
- **September 9:** prospective capture. Freeze the selected specification and source/parameter hashes before scoring. Do not tune on prospective results and keep calling the revised result prospective.

The canonical data is under `scripts/.eta-replay/overnight-2026-09-08/dataset-v2`. Its manifest records source hashes, archive publication clocks, table counts, topology provenance, route coverage and output hashes. Version 1 remains intact for audit; version 2 adds a continuous-track requirement for physical target matching and conservatively excludes unresolved route-index groups from occurrence-dependent component models.

`inventory.json` outside the dataset covers the archive/capture files and local SQLite snapshots, deduplicated by content hash. Nonempty SQLite WAL files make a main-file hash insufficient as a frozen database. The local development `store/shuttle-v2.db` includes old test/import data and is not a canonical source. Real split `stop_visits` and `legs` begin September 3; older v1 `arrivals` and `segments` have different measurement semantics and are not interchangeable pinned-stand labels.

## Causal and physical clocks

`positions.jsonl.gz` retains every GPS poll. Update tracking state on every poll, then thin the scoring grid; thinning input observations changes the filter.

`episodes.jsonl.gz` contains the stored stop visits in `contract.ts`. Pinned and departed clocks, current outcome, later anchors and next arrival are labels. They must not be used as current-visit input features. A rest component can condition on a causally observed current rest clock; first issue and elapsed-grid studies that use the completed visit's pinned clock are component diagnostics, not a complete online detector evaluation.

Database insertion times were not recorded. `knownAt` is therefore explicitly a **proxy**: two subsequent same-bus/same-route anchors plus a fixed 120-second margin, capped by the time the row was actually observed in an archive. `availabilityKind` records which bound was used. Training requires both physical completion and `knownAt` before the fit cutoff. Freeze prior-day fits for confirmation; use replayed event emission times for stronger claims about online availability. Never represent the proxy as an exact historical insertion timestamp.

`physical-arrivals.jsonl.gz` is independent of the stored stopped/passed classification. It records the first observed crossing into 50 metres, rearms only after 120 metres, interpolates within the observed endpoint interval and accepts at most a 30-second GPS gap. Initially inside the radius is left-censored. Each target records `trackStartAt`: a prediction must have `issuedAt >= target.trackStartAt`, or an earlier missed arrival might have occurred in a capture gap. The current-stop-to-next-stop target also stops at the next recorded occurrence of the current stop, preventing substitution of a later lap. Null targets remain censored, never zero.

Repeated stops retain their sequence indices. A geographic crossing alone cannot distinguish two occurrences at the same marker; `stopIndices` lists the possibilities. Full-route scoring must pair a forecast to its occurrence on the same continuous route traversal, not merely search the next matching stop ID. `topology-variants.json` outside the dataset records raw and currently repaired sequences. The in-memory repair changes Pink, Green and Purple indices, while the database and public payload retain upstream order. September 8 groups with conflicting index semantics are marked unresolved; do not silently pool those indices with historical ones. Raw-GPS end-to-end regression can still score these routes with the actual client ring and independent physical labels.

For full client replay, use `pair_client.py --served-cohort`. `served_targets.py` corroborates each independent crossing against a unique recorded same-bus/route/stop visit from 30 seconds before its anchor through 30 seconds after its final physical clock. Only the earliest crossing associated with that visit is retained. The common cohort contains the next one through five actual served visit occurrences within 30 minutes on the same continuous track. It excludes a query already within 50 metres of the target, reports every exclusion and unmatched arm key, and resolves repeated markers through their served occurrence. These future labels define scoring only and must not enter prediction features. The physical target clock remains the GPS crossing, not the visit's classification clock. A geographic-only diagnostic is broader and includes incidental nearpasses; its errors are not an acceptance score. `served-cohort-lock.json` freezes this label adapter separately from the model selection lock.

## Common scores

Both arms must emit the same `ScoredForecast` IDs, issued clocks, physical targets and quantile levels. A component departure forecast has `targetAt=departedAt` and `actualSec=(departedAt-issuedAt)/1000`. A full ETA uses a verified future physical target. An episode's grid is fixed before comparing arms. Baseline and candidate must have identical fallbacks and exclusions; report cold starts and censoring counts.

`score.py` averages issue moments within each episode, then gives episodes equal weight. It reports MAE, signed bias, quantile CRPS approximation, 80% interval coverage/width, errors more than 120 seconds in either direction, route/pattern/day strata, and a macro average over routes with at least ten episodes. Quantile CRPS uses midpoint weighted pinball quadrature; on the shared 19 midpoint levels it is exactly twice mean pinball loss. A positive error means the actual bus arrived earlier than forecast and the rider was given too much time. Bootstrap intervals resample whole episodes and are descriptive: shared day/vehicle conditions and model-selection uncertainty are not removed. Fewer than nine supplied quantiles yields no CRPS claim; three displayed bounds are insufficient to recover a full distribution.

Use `--bus-day-sensitivity` for an additional interval resampling whole vehicle/day blocks across routes. Few captured days still limit generalization. `--first-moment` chooses the original first issue before the horizon exclusion; a very long first wait is reported as excluded rather than silently replaced by a later remaining-wait prediction. Full ETA clusters use the destination `targetArrivalId`; origin dwell and current-visit metadata remain available for diagnostic cohorts.

For the three widened rider-facing bounds only, `--displayed-intervals` permits a negative lower bound on a `physical_arrival` row with levels `[0.1, 0.5, 0.9]`. The median and upper bound must remain nonnegative. It preserves the raw bound and interval width, reports negative-bound counts and the minimum, and makes no CRPS claim. It does not relax component distribution validation or silently clip an interval. A single vehicle/day receives no clustered uncertainty interval; resampling the same block cannot establish precision.

```sh
python3 scripts/eta-replay/general-eval/score.py \
  --baseline /path/baseline.jsonl --candidate /path/candidate.jsonl \
  --out scripts/.eta-replay/overnight-2026-09-08/comparison.json
```

Reserved-day scoring additionally requires `--candidate-lock /path/lock.json`, containing `selectedAt` and `candidateHashes`. The model owner should record feature definitions, code and fitted parameter hashes, train/selection cutoffs, query grid and selection rule before opening confirmation scores. A failed confirmation remains evidence; it is not another selection fold.

Standing-display comparisons use `compare_stands.py`. Remaining truth is the physical departure minus the issue time. First total means the earliest recorded valid display for that visit on the frozen scoring grid, not the mathematical distribution at a retrospectively supplied pin and not necessarily the first five-second UI refresh. The client updates tracking and ETA display floors every feed poll; `POLL_STRIDE=6` stores approximately one query every 30 seconds. Both arms must share the same original earliest recorded key, and missing first displays remain in coverage counts.

## Separately frozen measurement repair

Historical late pin timestamps were independently verified against raw GPS and a current causal detector replay. `rebuild-labels.ts` reconstructs all routes without reading forecasts or fitted models. Its lock records raw inputs, detector sources, canonical geometry, censoring rules and mutual unique old-to-new visit matching. A label-only client replay must use exactly the same network geometry as its original forecast replay; a newer topology changes the experiment. Runtime training/history and model parameters remain the original frozen inputs.

`compare_rebuilt_stands.py` verifies unchanged predictions at every original issued key using the label-independent `.unlabelled-stands.jsonl.gz` file. It associates each captured display with a unique complete reconstructed physical visit. A disagreeing inferred stop occurrence remains a tracking error in the primary cohort; only genuinely ambiguous physical associations are excluded. The report separates the original mutually matched visits, those visits with repaired clocks and restored early queries, the same original first queries with only their truth clocks repaired, the full reconstructed population, and an occurrence-agreement sensitivity. Original results are retained. Every route uses the same material-regression rule.

`score_rebuilt_client.py` waits for completed label-only replay manifests, checks geometry/source agreement, runs those comparisons, and aggregates the reserved dates. It launches no model or replay. A measurement repair is not permission to tune a selected model against confirmation outcomes, replace the original full-ETA target cohort, or call previously inspected data a new test.

For downstream component comparisons, convolve every candidate's departure distribution with exactly the same drive distribution learned before the cutoff. A drive label can be formed from `nextPhysicalArrivalAt-departedAt` only if both its visit and physical-arrival availability clocks precede training. Root's full client replay additionally measures state inference, route traversal and presentation behavior that component scoring cannot validate.

## Reproduce extraction and checks

```sh
python3 scripts/eta-replay/general-eval/inventory.py
python3 scripts/eta-replay/general-eval/build_dataset.py --out /tmp/general-eval-new-freeze
node --import tsx scripts/eta-replay/general-eval/topology-variants.mts \
  /tmp/general-eval-new-freeze/topology.json /tmp/topology-variants.json
python3 -m unittest discover -s scripts/eta-replay/general-eval -p 'test_*.py'
```

Extraction refuses to replace a manifest that already exists. Source archive response completeness is transport integrity, not a claim that the whole day's service was captured. No reserved outcome-duration summaries or model scores are printed during inventory/extraction.
