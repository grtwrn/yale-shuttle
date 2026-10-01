# Episode-clock audit: next-case selection and first accounting slice

The next ten cases are frozen from the archived deployed-release **ON** full-arrival checkpoints, independently of every cycle-1 neighbor prediction. The original release-OFF field is not the comparator. These are already-used September16–17 development observations; selection is preparation for a current-code trace, not a newly run production replay.

`select_clock_cases.py` ranks sources by mean absolute arrival error across all saved warmed first-occurrence checkpoints and both destination endpoints, five sources per regulator. Every phase is retained. `PLAN.json` records the rule and hashes before selection. The original163 connected journeys,103 source count and all missing-chain/warm exclusions remain in `case-manifest.json`; only sources with recorded connected checkpoints can be ranked. `decompose_selected.py` independently checks20 exact outcome-time identities from the source pin through source wait, leg elapsed intervals, inter-leg residence and final endpoint timestamp adjustment. It never subtracts legacy dwell from segment residence or relabels an outcome.

Selected Winchester IDs:58224,61907,60836,65347,58717. Selected Union IDs:57454,63523,57990,61538,58510.58224 and65347 are previously audited legitimate regressions; their `alreadyAuditedClockOrigin=false` flag means they were not among the **four specific origin-audit cases**, not that nobody has reviewed them.60836/57990 already have fresh raw-coordinate summaries from cycle1, which should be reused.

The selected current-release errors do **not** concentrate on a large pin-versus-broad-rest offset. At pin, Winchester offsets are9.9–30.0s and Union0–5.0s. In all five selected Union cases the tracker is not yet marked rested at the pin checkpoint. This is a descriptive finding from the saved replay, not evidence that the clocks are equivalent or that approach behavior is correct.

At actual departure+60s, Union Division/Rosenkranz forecast-minus-observed errors remain substantial:

| Source | Source pinned hold | Division error | Rosenkranz error | Physical interpretation |
|---|---:|---:|---:|---|
|57454|355.2s|-658.4s|-697.3s|Bus reached the targets substantially later than forecast.|
|63523|40.0s|+405.2s|+410.5s|Bus reached the targets substantially earlier than forecast.|
|57990|55.0s|+474.9s|+497.9s|Bus reached the targets substantially earlier than forecast.|
|61538|630.1s|-398.4s|-345.3s|Bus reached the targets substantially later than forecast.|
|58510|620.8s|+349.4s|+386.0s|Bus reached the targets substantially earlier than forecast.|

This does not establish which downstream component or tracker transition causes the error. It does show why changing only the initial pinned remaining-wait model is insufficient evidence of a rider improvement. The next trace should inspect current tracked rest/position, downstream hop waits and future Winchester arrival/hold scenarios, alongside approach/pin clocks. Do not install a constant offset or modify route-forward tracking from this accounting.

Reuse the prior four-case `conditional-replay-data/rest-origin-review.md/.json`: real pre-pin waits59602,59805,66278 remain legitimate; confirmed restart truncation65237 already has PR279. No need to rerun those completed experiments. For selected new cases, actual watcher payloads are needed to recover receipt timing; `raw-frames.jsonl` collector clocks are reconstructed. Verify both target occurrences in any proposed fix; this selection uses first-occurrence checkpoints only.

Executed: `python cycle-2/select_clock_cases.py` (ten selected sources, all warm>=600s) and `python cycle-2/decompose_selected.py` (20 connected accounting identities passed). No fits, source edits, full replay or measurements of normal coverage were made in this slice.
