# Independent bunching-screen review

**Verdict: no predefined subset currently merits promotion.** The causal experiment is useful and substantially clearer than an oracle “next bus” feature, but the supported close-leader correction is inconsistent across dates, its newer result changes only one hold, and the compact-spacing model is sensitive to the assumed observation delay. This is an offline current-wait component study, not evidence of narrower or safer full pickup ETAs.

Reviewed the frozen plan, fitting/extraction/prediction source, extension source, fits/support, saved scores, runtime-comparator metadata and validation source/result. No model, replay or validation was run by this reviewer. After the user requested lower Pi load, review continued only from already-read outputs; no new raw-regression investigation was launched. No application or production changes were made.

## Causal design and validation

The extractor selects each other bus's latest known anchor across all routes, then checks route assignment, canonical occurrence, same day and freshness. It uses unconditional anchors rather than selecting eventual stopped visits. Co-anchor evidence makes physical ordering unknown; same-peer ahead/behind is explicitly represented. All neighbor features are fixed at the forecast origin throughout the residual distribution. Only the focal elapsed time and deterministic clock advance; no realized future neighbor trajectory enters the CDF.

Route-distance proxies use earlier single-hop leg medians. These are typical travel-time distances between observed stop anchors, not actual headways or predicted arrival times. Anchor+15 seconds is an availability approximation, not proof of historical receipt time. Applying the same frozen coefficients at +120 seconds is an appropriate sensitivity check. The fit uses 160 pre-September-14 holds and 569 overlapping landmark origins; the 10,957 risk-bin rows are not independent observations. Equal-origin composite fitting gives long holds more origins, as the plan explicitly discloses.

Only **close leader** meets the frozen minimum support: 31 training holds across six dates. Close follower has seven holds and co-anchor six, so neither qualifies. The gate checks only supported regimes and returns the exact control forecast outside them. This appropriately limits extrapolation; it means the study cannot establish the effect of two buses jointly waiting or a close follower.

Saved validation reports 6,426 finite/ordered quantile and probability checks, 6,426 continued-tail checks, 1,826 exact no-gate comparisons, and 226 future-deletion/perturbation checks across 113 deterministic origins. The validation source checks the claimed properties, including altered future outcomes/assignments and far-tail survival. These are numerical/causal invariants, not calibrated-probability or rider-safety validation.

Fits were saved at 20:00:03 UTC; the newer capture was opened at 20:06:30 UTC with fit/source/plan hashes checked and no old outcome changes. Its eight holds therefore form a legitimate frozen-coefficient extension of this component experiment. They remain one small same-day sample, not a new independent date or a full online deployment test.

## Results that drive the decision

Primary checkpoint-weighted numbers below are seconds. “Reused September 18” means the 17 holds already inspected before this experiment; “fresh” means the eight subsequent holds.

| Primary 15-second availability | Sample | Control WIS → gated WIS | Control MAE → gated MAE | Width change |
|---|---|---:|---:|---:|
| All September 14–17 | 113 holds / 398 origins | 43.84 → 43.73 | 68.57 → 68.16 | +0.09 |
| Supported close-leader subset, September 14–17 | 20 holds / 39 origins | 52.17 → 51.01 | 66.55 → 62.37 | +0.90 |
| All reused September 18 | 17 holds / 78 origins | 66.39 → 68.67 | 105.19 → 112.06 | −1.23 |
| Supported close-leader subset, reused September 18 | 8 holds / 20 origins | 63.79 → 72.69 | 78.86 → 105.65 | −4.80 |
| All fresh extension | 8 holds / 26 origins | 47.19 → 46.99 | 60.45 → 59.87 | −0.09 |
| Supported fresh subset | **1 hold / 4 origins** | 48.37 → 47.07 | 34.46 → 30.67 | −0.60 |

The tiny overall gate improvement on older dates cannot be treated as meaningful window tightening. Even within its intended close-leader subset, the gain reverses on reused September 18. Within older dates, primary gate WIS improves on September 14 and 17 but worsens on September 16; September 15 has no eligible gate sample. The 120-second sensitivity has a stronger older-date gain, but its reused September 18 close-leader subset worsens WIS 47.49→58.21 and MAE 44.18→75.20. That is not merely a single tiny tail crossing.

Fresh gate results at +120 seconds improve all-origin WIS 47.19→46.67, but again only one hold is affected, now at two landmarks. It would be misleading to describe four or two observations of one hold as replication. The fresh close-follower origins stay exact control because their regime lacked training support.

The compact-spacing arm does not give a stable alternative. Older-date WIS slightly worsens (43.84→43.95 at +15 seconds; →44.31 at +120), despite modest median-error improvement. On reused September 18 its WIS worsens at +15 seconds (66.39→68.21) but improves at +120 (→62.60). On fresh holds it slightly improves at +15 (47.19→46.92) but worsens at +120 (→49.60). That sensitivity matters because true receipt/progress is only approximated by stop anchors.

## Prespecified subsets and tails

The control-predicted ≤3, 3–8 and >8 minute bands are valid descriptive subsets because the control prediction, not the future observed wait, defines them. They do not provide a promotion exception here:

- The close-leader 3–8 and >8 minute gate subsets improve on older dates but both regress on reused September 18, at both delay assumptions. Their fresh counterparts each represent the same one hold.
- The ≤3 minute gate subset has just one older-date observation and no fresh affected observation. It supplies no reliable “short waits only” candidate.
- Compact spacing's 3–8 minute band has some primary-delay gains, but the fresh gain reverses under the alternate delay. Searching or selecting only that favorable line after inspecting all arms/bands would require new validation, not immediate promotion.
- Close-follower and co-anchor samples are too sparse for the declared learned correction; exact fallback is an honest no-effect policy, not evidence that bunching is irrelevant.

Gate early/late miss counts are unchanged in these aggregates: older dates 23/13, reused September 18 1/23, fresh 1/0. Compact spacing creates more older-date early-bound crossings: 23→26 at +15 seconds and 23→29 at +120, affecting 20→22/23 distinct holds. It also removes some late misses. These tradeoffs must be judged with proper scores and shortfall magnitude, not dismissed because any miss increased or praised because coverage rose. Neither arm has been shown to let a rider safely leave later: these labels are Winchester departures, not connected Division arrivals, target dwell or door closure.

An additional reporting issue was identified and sent to the analysis owner: `util.metrics` uses each row's original inverse number of eligible landmarks for the label `visit`. After filtering to a regime/band/age, that is not equal-visit weighting within the selected subset; at a single age it downweights longer holds. The primary checkpoint values above are unaffected, and fixed-age checkpoint results already give each eligible hold one vote. Preserve the original files and either relabel that secondary weighting precisely or add separately identified within-subset equal-visit summaries. No fit change is needed or authorized by this finding.

## Limits and recommendation

No full continuous pickup replay, boarding-policy simulation, target-arrival/departure linkage or new raw validation of the largest model regressions was completed for this screen. The separate runtime comparator retains the actual nine-feature model and fallback; the matched ten-feature landmark control is not today's exact production forecaster. Substantial live integration questions remain, including changing neighbor eligibility and support boundaries. The current data do not justify that engineering step for any of the predefined bands.

Keep all valid short and long outcomes and the original frozen scores. Do not remove a regression because it contradicts a proposed anti-bunching rule. The useful conclusion is narrower: this stop-anchor spacing representation does not yet produce a sufficiently consistent, materially useful conditional waiting improvement. It neither proves nor disproves an operational release rule based on richer current progress or dispatcher information. Publish the complete negative/mixed result and retain the service's existing ETA model.
