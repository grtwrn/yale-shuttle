# Current route-order screen

The current-anchor measurement fixes a real neighbor-identity error, but it does **not** yet establish a reliable new departure predictor. Keep the current production model unchanged on this evidence.

`PLAN.json` fixes the cohort, model arms, causal availability assumptions, and evaluation before fitting. `screen.py` uses the same 285 Winchester visits (160 training before September 14), with 1,022 total eligible snapshots at elapsed 0, 60, 180, 300, and 480 seconds. The target is departure within the following 120 seconds conditional on still waiting. This classifier is a clue screen, not an arrival interval or validated live probability.

The new measurement selects the closest forward and backward route-stop anchors known at each forecast, using all-route records to exclude buses whose latest assignment is elsewhere. It requires current-day Red anchors no more than ten minutes old, valid canonical stop indices, and a 15-second primary observation delay. The 120-second sensitivity tests slower availability. Equal-distance ties and co-located buses have unknown order; a single peer can be both ahead and behind around the loop. Stop-order gaps are neither physical distances nor travel times.

## What changed

For visit 70927, the primary measurement correctly identifies #316 ahead and #306 behind. The earlier departure-order feature had identified #306 in both directions because #316's just-completed departure was not yet available under its 120-second rule. Neighbor identities change in 237 of 1,022 primary snapshots; 15 contain a co-located peer and 274 have the same sole peer in both directions.

The first implementation did not suppress other peers when a co-located peer made order unknown. It was corrected to match the frozen plan before interpreting results. The original code and outputs are retained with `.before-colocation-correction` suffixes. No cases or outcomes were removed because of their errors.

## Scores

Checkpoint-weighted Brier scores (lower is better) compare against the same lap, elapsed-time, clock, and own-Union-age control. All fits use training-only standardization and fixed L2=4, with equal landmark weights. Per-date, fixed-age, log-loss, and visit-balanced descriptive results are retained in `results.json`.

| Observation delay | Evaluation period | Control | Add bus ahead | Add both neighbors |
|---|---|---:|---:|---:|
|15 seconds|September 14–17|0.105961|0.105312|0.104248|
|15 seconds|September 18|0.050700|0.050754|0.051926|
|120 seconds|September 14–17|0.105961|0.107581|0.106716|
|120 seconds|September 18|0.050700|0.052957|0.055500|

The primary two-neighbor model improves three of the four reused development dates but worsens September 16 and September 18. Its gain is not stable under slower availability. It provides no basis for moving the pickup window's lower bound later.

## Interpretation and limits

Yale's [Transit FAQ](https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/yale-transit-faqs) explicitly distinguishes driver breaks from holds intended to prevent buses bunching. Thus coordination is a supported operational hypothesis. This compact additive anchor screen neither identifies nor rules out a particular release threshold, stop-crossing trigger, dispatcher instruction, or interaction between two buses. Sparse stop anchors, observation delay, and unobserved operating decisions can obscure those rules.

The results use previously examined dates and five fixed forecast ages, not an independent-day experiment. Availability is a declared proxy rather than recorded receipt time. The code asserts no selected anchor is from the future and that each selected peer is its latest known all-route anchor. The root's comparison is descriptive; deployment would require independent measurement review and a continuously warm full pickup replay.

No application, production, database, or watcher changes were made by this screen.
