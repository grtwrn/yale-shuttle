# September 18: clues in prior waits and bus coordination

**A bus's previous Winchester wait carries a modest predictive signal. It survives full pickup replay but does not materially narrow the rider's window. No new predictor was deployed.**

The history screen used 160 training holds from six dates, 125 initially available later holds, and five newly completed holds examined only after coefficients were frozen. Longer prior Winchester waits predict somewhat longer current waits after lap/elapsed/clock/Union-age controls. This describes vehicle operating history; the data does not identify drivers or prove a bathroom-break rule.

The complete three-day replay then compared 190,157 forecast identities with unchanged forward position beliefs. Among 68 supported connected Division pickups, the frozen core→history comparison changes average error 79.22→76.90 seconds and average window width 473.38→471.19 seconds. Today's 14 matched pickups improve error 112.01→106.02 seconds while width increases 505.35→511.47 seconds. Thus this is a useful clue, not the requested broad-window fix.

The other clues are:

- **Coordination has an official basis.** Yale's [Transit FAQ](https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/yale-transit-faqs) describes operational holds to prevent buses bunching, separately from driver breaks. Its ten-minute break provision is not a cap on every hold. The FAQ supplies neither an exact release rule nor designated restroom stops.
- **Cedar remains unresolved.** Only three prior Cedar histories in the training cohort lasted at least two minutes. Separate Gilbert/Cedar117 and Amistad/Cedar13 features give mixed gains. Genuine long Cedar pauses can still be followed by long Winchester waits, so there is no deterministic substitution rule in these examples.
- **Neighbor identity matters.** A current-anchor screen fixes one documented ahead/behind mistake and changes identities in 237 of 1,022 snapshots. The predictive gain remains small and fails on the latest day and slower-observation sensitivity. Specific coordination triggers remain a hypothesis.
- **Some short histories are measurement fragments.** Union60020 records about five seconds despite raw fixes showing at least 320 seconds continuously standing before a late re-anchor. Prior Winchester66622 begins after a 650-second gap and provider-ID change; its recorded 105-second duration has an unknown start. The subsequent current holds and regressions remain valid and scored. Known Winchester65237 retains its independently verified departure, with its truncated duration unavailable. Original model results are preserved; these are field-level input-quality findings, not reasons to delete difficult outcomes.

Evidence and reproducible artifacts:

1. [Full pickup result and deployment verdict](full-pickup/REPORT.md), [independent review](full-pickup/independent-review.md), [following loop audit](full-pickup/following-occurrence.md).
2. [Prespecified own-history models](own-history/REPORT.md), [independent model review](own-history-model-review.md).
3. [Measurement and raw-case audit](own-history-measurement-review.md).
4. [Corrected neighbor-order screen](neighbors/REPORT.md).

The latest candidate is not integrated or deployed. Existing production improvements are unchanged, and the rider watcher remains active. The immutable source capture, fixed plans, input hashes, coefficients, paired forecasts, valid regressions and explicit missing/censored cases remain beside these reports.
