# Causal neighbor snapshots do not yet justify an ETA change

The frozen remaining-wait screen is complete. Do not integrate either neighbor arm. Winchester's primary gains against the current-code component are about one second of MAE and 1–1.5% WIS, improve only two of four development dates, and increase departures after the displayed upper bound. At Union, adding neighbors does not improve WIS over the matched lap/clock landmark core. This is useful negative evidence against directly promoting the earlier one-step hazard gains. It does not establish that all neighbor models fail.

All application files and HEAD remain unchanged at `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`. No deployment candidate, publication, server request, watcher change or screenshot was produced.

## Design and chronology

`PLAN.json` was written before extraction/scoring. `extract_landmarks.py` independently implements the corrected causal identity/event contracts, without importing or executing old script fitting/output sections. It reads SQLite with `mode=ro`. Input hashes, exact cutoff, features, arms, penalty, likelihood weighting, support rules and tails are preserved in the plan. Three predefined arms use a fixed training-only core offset and joint L2=10 peer additions. No tuning or calibration-intercept refit was performed.

The 535 original completed true-rest episodes remain: Winchester102/58/99 and Union112/61/103 in training/calibration/development. Training dates are September3,4,8,9; calibration10–11; development14–17 through13:14 ET. These are previously inspected dates. The afternoon used to approve PR281 was not scored. The only prior demonstrated corruption,65237, remains quarantined. Previously audited genuine cases64318,58224,65347,48550,51469,54002,52633,52168,54777,53429 are retained. Afternoon cases67957/68304 remain valid prior evidence outside this cutoff.

At elapsed pinned wait0/60/180/300/480s, predictions condition on the hold still continuing. Every future risk row in training and inference uses the same frozen peer snapshot from that landmark; only deterministic elapsed time and clock advance. The primary arrival+15s and conservative completed+120s contracts were both tested. Snapshot progress older than600s, other-route evidence and unknown identities cannot supply progress features. Latest anchors are unconditional on eventual pin/outcome and come from all routes. Identity stays latched in departure order, not retrospectively identified physical order.

Each visit contributes total landmark weight one, with all surviving risk-bin exposures retaining their landmark's weight. This is visit-normalized repeated likelihood, not independent-bin evidence. Training remaining times beyond1800s contribute right-censored exposure; the final hazard continues beyond1800s with the existing production hazard bounds. Quantiles are never capped. Unsupported laps receive the exact fitted core in every candidate arm. Unsupported and ineligible landmark records are explicit.

There are3,898 extracted rows across both contracts. Development has722 distinct visit/landmark outcomes:352 from99 Winchester visits and370 from103 Union visits. All three arms and both contracts emitted all4,332 forecasts; comparator availability was722/722. The extraction checked1,070 per-visit weight sums and200 temporal-censor comparisons, one deterministic case per date/stop/landmark/contract. Six additional synthetic/numerical tests passed.

## Comparator limits

`export_comparator.mts` calls the **current checkout's** `loadReleaseObservations`, `fitRelease`, `releaseDist`, `releaseResidual`, `buildTables`, `lapFactor` and `residual`. Winchester's fit is frozen before September10; Union and unsupported Winchester use the pre-September14 marginal tables. The regenerated Winchester coefficients exactly match the existing runtime pre-September10 fit. Union is never mislabeled as having the experimental release hazard enabled.

This compares actual current component algorithms with declared historical calibration, **not continuously served production ETA**. The six-hour refit schedule, live position mixture, broad-versus-pin clock transitions,30s absolute-arrival pooling, downstream drives, future holds, repeated target occurrences, rider connections, ranking and jump stability are not replayed here. This conservative negative screen does not establish a complete ETA improvement, and its comparator is not described as an exact recording of what riders saw. `COMPARATOR_PLAN.json` preserves code/input hashes and this contract.

## Primary results

Visit-weighted quantities in seconds. WIS80 combines median error with the10–90 interval score; lower is better. Early means actual departure before the lower bound; late means actual departure after the upper bound. These empirical rates do not validate nominal coverage.

| Source | Arm | MAE | WIS80 | Width80 | Early | Late |
|---|---|---:|---:|---:|---:|---:|
| Winchester | Current-code component |71.7|44.5|297.4|6.1%|1.0%|
| Winchester | Landmark core |74.2|46.8|309.3|2.0%|7.2%|
| Winchester | Ahead snapshot |70.6|43.9|279.8|3.6%|5.6%|
| Winchester | Ahead + follower |71.2|44.0|265.3|3.6%|10.1%|
| Union | Current marginal component |135.3|77.9|359.3|11.5%|13.0%|
| Union | Landmark core |103.4|65.2|329.3|14.0%|4.8%|
| Union | Ahead snapshot |98.9|67.0|279.5|16.4%|5.4%|
| Union | Ahead + follower |100.2|65.5|280.6|15.6%|7.3%|

The large Union comparison against marginal pricing is largely the already-known lap/clock hazard effect; neighbor additions do not improve its proper score. Previous complete rider replay rejected a Union release rollout, so this component gain does not reopen that rollout by itself.

Under completed+120s, Winchester combined WIS43.3 versus44.5 looks somewhat better, but late misses remain9.4% versus1.0%. Union combined WIS65.2 is effectively tied with core65.2, with early/late misses16.4%/8.2% versus14.0%/4.8%. Selecting the favorable timing contract would overstate evidence. All per-date, per-landmark, median/p90, checkpoint-weighted, missing-lap and same/distinct/unknown follower results are in `scores.json` and `SCORES.md`.

Primary development snapshots retain55 Winchester and23 Union unsupported-lap landmarks. Follower identity is unknown at50/352 and26/370 landmarks; stale peer progress remains explicit. Same-as-ahead occurs at99 Winchester and113 Union checkpoints, still date-confounded. No latest-other-route contradictions occurred in the extracted cohorts; a synthetic reassignment test verifies fail-closed behavior. Neither the absence of contradictions nor a selected follower establishes physical ordering or fleet size.

## Largest primary combined-arm regressions

These are the five worst visit-averaged WIS regressions at each stop against the current-code component. All remain included. DeltaWIS is candidate minus comparator, so positive is worse. `top-regressions.json` also preserves every other predeclared arm/comparator/contract's five worst cases.

| Visit | Source | Actual hold | DeltaWIS | Component explanation |
|---|---|---:|---:|---|
|60836|Winchester|835.1|119.1|Long hold initially priced at median125s, versus417s current; core was already162s, and same-as-ahead peer additions shorten its upper tail further.|
|46865|Winchester|735.0|50.7|Pin-time median631→155s; landmark core already278s. Peer additions favor an earlier release before the observed long hold.|
|46677|Winchester|590.1|49.1|Pin-time median537→96s; core165s. Later checkpoints partly recover, but the early forecasts regress.|
|45102|Winchester|570.1|40.0|Unsupported-lap core fallback is identical across all candidate arms; upper bound484s versus current633s. This is a core/comparator difference, not a neighbor-specific failure.|
|65621|Winchester|508.7|33.7|Follower addition moves pin median331→293s and upper478→422s; current median366s.|
|48550|Union|1020.2|233.0|Previously audited genuine long hold. Core already predicts241s; peers reduce upper447→329s. Marginal current upper766s is also too short, but less severe.|
|62056|Union|15.0|161.5|Genuine short hold: current lower47s, core111s, ahead293s, combined208s. Neighbors further delay the already pessimistic window.|
|57990|Union|55.0|143.1|Current median140s versus core394s and combined440s; primary lower bound rises above the actual short hold.|
|49315|Union|94.8|126.6|Current median230s versus combined453s; core456s. Peer addition mostly shifts the lower tail, and the underlying core is already wrong.|
|61157|Union|160.1|119.3|Current median235s versus combined421s; core422s. Combined lower242s is later than the real departure.|

The completed-record audit covers31 distinct worst-case IDs across all arms, each with non-gap stopped/rest evidence and an outgoing leg. It is not a complete connected endpoint validation. For the ten primary cases, observed GPS coverage exists for five:60836,65621,62056,57990,61157. Four have maximum gaps about5.3s;65621 has a21.259s gap and is explicitly retained. Each of these five has an observed coordinate change about4.7–5.2s after the stored departure. Five September14 cases lack this raw-frame coverage; no new GPS verification is claimed for them. No affirmative new measurement error was established.

Important provenance correction: `raw-frames.jsonl` contains recorded coordinates plus causally **reconstructed collector fields** from the archived `raw-feed.mts`. Its first reconstructed pin is not the first actual published pin receipt. Initial audit field names saying `firstPublished` were corrected to `firstReconstructed`; the superseded JSON is retained and marked. This affected no features, fit or scores. Exact receipts require actual watcher payloads.

## Reproduction and next task

Executed in this round (full absolute paths in `PROGRESS.md`):

1. `python -m py_compile extract_landmarks.py` and `fit_landmarks.py`: passed.
2. `OPENBLAS_NUM_THREADS=1 python extract_landmarks.py`: passed all extraction/cohort/temporal assertions.
3. Shared heavy lock + `OPENBLAS_NUM_THREADS=1 python fit_landmarks.py`: all12 fits converged,4,332 forecasts,12.09s fitting/evaluation.
4. From current `services/shuttle-v2`, shared heavy lock + local `tsx export_comparator.mts`:722 current-code component forecasts, regenerated Winchester fit.
5. `OPENBLAS_NUM_THREADS=1 python score_landmarks.py`: paired identities/timestamps/truth asserted, all scores and regressions written.
6. `python audit_regressions.py`:31 completed-record and10 selected raw checks; all outcomes retained.
7. `OPENBLAS_NUM_THREADS=1 python test_landmark_contract.py`:6 tests passed (analytic survival, no time cap, extreme logits, future-label invariance, unsupported lap, stale/reassigned peer).
8. Shared heavy lock + `npm run typecheck`: backend and frontend passed. No application change required a Vite build or staging; neither was run. No full suite claimed.

Request an independent research review, then advance to backlog3: consistent episode-clock audit. Reuse the prior completed Winchester origin audit; do not rediscover65237 or relabel59602/59805/66278 as errors. Select new cases by **current-production full-arrival error**, independent of these candidate deltas, and trace raw approach/rest/pin/confirmed-departure with connected Division/Rosenkranz outcomes and both occurrences. Separate actual watcher receipt clocks from reconstructed fields. Do not change the route-forward tracker or subtract approach waiting twice.

## Independent-review weighting clarification

The accepted round1 review is `../independent-review-round-1.md`. Overall visit-normalized summaries are correct. Within a fixed elapsed stratum, rows labeled `visit` retain original inverse eligible-landmark-count weights; call those original-cohort-weighted. The existing `checkpoint` row is the equal-visit result at that fixed elapsed time. Equal-checkpoint Winchester combined WIS46.1→48.4 reverses the small primary visit-weighted44.5→44.0 change; Union core→combined improves59.8→58.0 under equal checkpoints but worsens65.2→65.5 under primary visit weights. Both remain exploratory and do not support integration. Scores/forecasts/plans were not changed.
