# Checkpoint averaging development study — 2026-09-22

The point, joint-vector window and fixed-visit action comparisons are complete. Both quality-policy jobs passed. No estimator is promoted: averaging has mixed window effects and introduces additional missed point-reminder cases. The separate chronological residual-calibration stage remains unimplemented and unscored.

Averaging has route-dependent effects. These reused September 17–20 observations do not establish a general narrower-and-safer replacement. The primary experiment returns to the deployed live estimate at the wait release; continuing all offsets 0–K after departure is a separately reported extension.

## Supported scope, primary highway25

All counts are physical target visits, not independent riders. Supported visits can contain both single-source and multi-source snapshots. `all / multi` counts visits with any supported joint-vector snapshot / any supported multi-source joint-vector snapshot. Every unsupported case keeps exact deployed forecasts.

| Route | Sampled / labelled snapshots | Labelled visits | Frozen K5 all / multi | Frozen K10 all / multi | Rolling K5 all / multi | Rolling K10 all / multi |
|---|---:|---:|---:|---:|---:|---:|
| Blue Day |6520 /5504|176|22 /22|30 /27|27 /27|50 /47|
| Orange Day |4747 /2940|130|73 /71|76 /75|73 /71|76 /75|
| Red |7025 /5269|188|80 /77|63 /63|80 /77|79 /79|
| Blue Weekend |723 /371|42|0 /0|0 /0|0 /0|0 /0|
| Pink |1805 /1570|71|31 / 30|45 /43|31 / 30|45 /43|
| Green |4474 /1462|109|0 /0|0 /0|0 /0|0 /0|
| Purple |3622 /495|49|0 /0|0 /0|0 /0|0 /0|
| Blue Night |1990 /631|31|0 /0|0 /0|0 /0|0 /0|
| Orange Night |1995 /1625|74|13 /12|15 /14|13 /12|15 /14|
| Gold |496 /493|27|14 /14|14 /14|14 /14|15 /15|
| Blue West |1139 /910|29|9 /8|10 /10|9 /8|10 /10|
| Orange East |1169 /967|30|0 /0|0 /0|0 /0|0 /0|
| Grocery Ham |310 /63|3|0 /0|0 /0|0 /0|0 /0|
| Brown |2032 /1555|35|0 /0|0 /0|0 /0|0 /0|

Zero support describes this stricter ensemble/traversal/whole-group contract, not a rejection of an existing route model. Daytime comparisons above chiefly use two evaluation dates, September 17–18. All generated fallback reasons, source/date/target counts, single-source cases and post-wait cells remain in the compact summary.

## Averaging versus a matched single checkpoint

On supported multi-source K10 snapshots, with identical physical vectors, weights and protection:

- Red: averaging widened printed windows by 31.9s frozen / 53.1s rolling; point MAE improved 3.4s / 14.0s. Frozen support was 63 visits/27 source traversals; rolling 79/30.
- Blue Day: averaging narrowed printed windows 19.2s / 21.4s, while empirical coverage fell 9.0 / 5.2percentage points. This does not pass a useful-window accuracy tradeoff.
- Orange Day: averaging narrowed printed windows 106.1s / 58.8s against the matched single checkpoint. Both remained wider than deployed on the matched and full-route cohorts; this is not a deployment gain.
- Pink, Orange Night, Gold and Blue West also have measured, differing effects; every K5/K10/frozen/rolling/primary/extension cell is retained in `summary.json`. No winning K is selected.

Literal frozen offsets 0–10 after wait departure had only 7 Blue Day visits/5 sources and 10 Orange Day visits/7 sources, with no supported Red post-wait visits. Compared with continuing the single checkpoint, averaging narrowed printed widths 83.4s and 66.5s. Compared with the deployed live handoff, it instead widened widths 144.9s and 282.0s and worsened MAE 22.8s and 120.1s. These small samples favor preserving the live handoff, not generalizing a post-wait averaging benefit.

Component agreement is not independent evidence. In the fixed frozen full pre-wait K10 mask, paired error correlations were 0.922–0.996 on Blue Day, 0.928–0.999 on Orange Day and 0.826–0.997 on Red. Within-snapshot point SD was 34/37/36s while ensemble MAE was 172/160/150s. These descriptive, target-pooled correlations may include shared bias; they do not identify a causal break mechanism or calibrate intervals.

## Controls and provenance

- Causal evidence run [35740424751](https://github.com/grtwrn/yale-shuttle/actions/runs/35740424751), code `840462a`: 44763 original features exact, 0 full-poll differences, 3 physically deleted-future prefix comparisons exact including strict source/proof/reset ledgers; no EOF closure. 48057 of 48111 strict emitted sources had an exact prior active-pin proof, 54 remained unproven.
- Fitting run [35741682149](https://github.com/grtwrn/yale-shuttle/actions/runs/35741682149), code `323ce80`: both complete unscored streams frozen, 152188 exact old-single controls per policy, 48052 exact training-visit/proof matches, 2 independent fitting-prefix comparisons. 23855/23965 immutable labels under 25m/50m. This run's report stage failed on a Python module-name collision after fitting and formatting; its completed fitted streams are preserved.
- Report/action reuse run [35743388426](https://github.com/grtwrn/yale-shuttle/actions/runs/35743388426), code `1d44077`:unique entry modules and hosted import smoke gate; no refit/replay. Reuse audit hashes every fitted path/vector/forecast/control stream before and after reporting. Pre-action compact artifacts: 25m`10700887692`, 50m`10700039122`.
- Full-stream comparison[35744152950](https://github.com/grtwrn/yale-shuttle/actions/runs/35744152950), code `512eaa5`: all 12 other routes' entire unscored/enriched rows exactly equal across25m/50m. Green/Purple new estimates remain exact deployed fallback. 50m adds 110 labelled Purple snapshots and 3 physical visits; original labels are nested and unchanged. No fits or new scores.

The initial serializer buffer/OOM failures, duplicate audit `day` failure, report import collision and smoke-test missing synthetic import config are preserved in run history. Fixes did not alter samples, fitted values, thresholds or labels.

## Limits and outstanding validation

Joint-vector intervals are empirical duration-distribution diagnostics, not calibrated coverage claims. The point-only comparison retains deployed bounds as reference metadata and may have a point outside that envelope; it is not a renderable interval treatment. Actual formatter coverage/width is reported separately, with explicit point-fallback counts. The full Blue Day printed-width mean is unavailable because some observations render a point instead of a window.

Fixed bus/physical-visit actions cannot establish complete app safety: destination bounds affect route ranking/stability, and pickup low affects catch risk. Ordering checks concern labelled, physically ordered compatible occurrence pairs, with exclusions retained. Concentration tables give counts rather than within-target/date/source outcome deltas. No new dates, production changes, support relaxation or threshold tuning occurred.

## Completed action controls and interpretation

The primary quality policy retained 994 labelled physical visits, of which 531 had the fixed common deployed 5–20 minute arming observation; 463 did not. The original22 cohort retained 938 visits / 511 armable visits. The 50m sensitivity had 997 / 534, adding three Purple visits. These are physical boarding episodes. The eight walk/response settings and different action policies replay the same episodes and must not be summed as independent riders.

All deployed action records were exact: primary all-cohort interval 12744 and point 4248; original-cohort interval 12264 and point 4088. The two actual formatter checks had zero mismatches (157176 / 151256 armed-window checks and 72300 / 71412 triggered-window checks). Every one of the 17 frozen fit/forecast/control files per policy retained its original hash after reporting/actions.

For the point-only primary K10 diagnostic, at a 180-second walk and 30-second response, Red introduced two missed reminders versus deployed among 27 scored pairs out of 103 attempted episodes. Compared with traversal-matched single-K, it introduced one frozen and two rolling missed reminders on that same grid cell. Pink K10 at a 300-second walk / 30-second response introduced three versus deployed among 10 scored pairs / 41 attempted episodes, and two versus matched single-K. These are scenario-specific counterexamples, not totals across settings or observed rider misses.

The deployable-format **joint-window** treatment has a stricter complete-vector support gate than the point-only diagnostic. In that same Red K10 cell, it introduces **one frozen / two rolling** point-reminder misses versus both deployed and matched single-K. Pink joint-window K10 still introduces three versus deployed and two versus matched single-K in the stated cell. Thus the safety counterexamples also apply to the actual interval treatment, not just the broader point-only comparison.

Protected ensemble intervals introduced no new paired misses versus deployed for either raw-lower or actual-rendered-lower reminder policies across the fixed grid. That follows the nonlater lower-bound protection; it does not preserve point-reminder behavior or complete app route choice. Full paired waiting, censoring, original-single and matched-single comparisons remain in the hosted action output. A separate compact digest reduces the existing summaries without rerunning or rescoring any action.

Across the eight fixed settings, primary K10 protected rendered-lower reminders add a mean paired wait of 0–0.98 seconds on Blue Day, 10.8–16.4 seconds on Orange Day, and 2.2–3.3 seconds frozen / 1.8–7.0 seconds rolling on Red, versus deployed. These are ranges of setting-specific means, not a pooled rider average. Censoring remains substantial: Red point-action cells have only 26–39 scored pairs from 103 attempted episodes, with 46–77 deployed censorings depending on setting; the exact cell counts and already-too-late statuses remain visible. No censored episode becomes evidence of a safe prediction.

Final summary artifacts from run 35743388426 are 25m`10702211566` and 50m`10702581319`; full record artifacts are 25m`10702156618` and 50m`10702746471`. The original action-comparison JSON is highly repetitive and expands substantially; use the hosted compact action digest for routine review rather than processing the full comparison JSON on the Pi.

Compact action digest run [35745463668](https://github.com/grtwrn/yale-shuttle/actions/runs/35745463668), artifact `10702847347`, SHA256 `25602f8d91e9ce5b3d532a85ce00a159c72c9b7bddb3ab41ef4d11dfda073cd0`, succeeded using only immutable completed summaries. It is 110KB compressed / 4.4MB JSON and retains every fixed arm, comparator, original/all cohort and grid-level failure, with setting ranges rather than summed repeated scenarios. All 12 non-Green/Purple route entries in these paired summaries match exactly across the two quality policies.

**Decision:** preserve current estimates and the live handoff. This experiment answers the averaging question with mixed measured effects and specific rider-risk failures; it does not justify a general rollout, a selected K winner, or a new calibrated-window claim. Residual calibration remains a separate unfinished stage.
