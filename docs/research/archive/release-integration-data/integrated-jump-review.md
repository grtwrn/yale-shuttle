# Integrated current-only release model: upward-jump diagnosis

The new upward jumps have concrete mechanical causes: **switching into conditional release pricing, and changing weights between a near-term departure and a longer continuing hold after the old ceiling is removed.** They are not primarily discontinuities in the conditional release CDF, lap-threshold jitter, or backwards movement of the estimated bus position.

This review uses the completed original four-arm development replay: 12,654 frames, 117,234 rows, prior model tables and fitted coefficients. It does not read the reserved Sep17 afternoon recordings. The parent scorer supplies exact connected source–target journey contexts, deduplicates overlapping source contexts, requires 600s warm-up and adjacent frames at most 15s apart, and scores the first target occurrence. The jump is the change in **absolute predicted arrival time**, including elapsed time between frames.

`jump-belief-trace.mts` reconstructs the original, unchanged movement filter with transition/shuffle experiments explicitly off. It checks lead, rest origin, and rested state against 72,920 available forecast rows. `integrated-jump-review.py` independently checks 197 relevant paired jump calculations and 35 uncapped-pricing checkpoint matches. Evidence is in the adjacent JSON files. No application files were edited.

## Counts and mechanisms

| First target | Baseline rises >60s | Current-only rises >60s | Newly over 60s | Release support entry | Stable-support mixture change | Other priced-rest/state boundary |
|---|---:|---:|---:|---:|---:|---:|
| Division | 19 | 102 | 86 | 35 | 39 | 12 |
| Rosenkranz | 29 | 90 | 63 | 31 | 27 | 5 |

The last three columns partition the **new** large rises; they are not independent ride counts. Some previous large rises disappear, so newly introduced counts differ from the net increase. The two targets can report the same physical transition. Very large rises common to baseline and candidate remain outside the new-model attribution.

**Release support entry:** 25 of 35 new Division entry jumps and 23 of 31 Rosenkranz entry jumps coincide with `belief.rested` becoming true. Eleven and nine respectively change the cached pin; those counts overlap the rested-state changes. **None of these new entry jumps is solely a lap-band threshold change with unchanged pin/rest state.** Caching `lapAtPin` is sensible clock hygiene, but it does not fix this main entry mechanism. Current pricing is still gated by `belief.rested` and matching `restStop`, even though the pin itself is cached.

**Stable-support mixture changes:** all 66 target-level events retain the same support, pin, rest identity, and lead leg. Their conditional rest median's absolute-time change is at most **10.2s**; the median increase in continuing-rest probability share is about **15 percentage points**. The displayed quantile can move much further because the departure-now and continuing-hold distributions have little probability between their modes. This is a property of the mixture and its quantile, not proof that either observation is false.

**Priced-rest/state boundaries:** another 17 newly large target-level rises occur with release support already available, but a different lead situation is selected or priced as a rest. This also changes whether the ceiling bypass applies. The standing and moving hypotheses can share a lead leg; changing the priced mode need not change forward route progress.

## Concrete examples

**Report115 / Winchester65347, Sep17 10:51:42.828 → 10:51:47.954 ET:** pin, lap, rest origin and lead remain unchanged. The continuing-rest share rises **0.568 → 0.715**. Conditional rest median falls 524.4→520.2s over the 5.126s step, so its absolute predicted departure changes only **+0.95s**. Current-only displayed ETA nevertheless rises **228.1→527.6s**, an absolute-arrival jump of **304.6s**. Baseline and the clamped candidate each change only by the elapsed **5.1s**.

When the moving part is mostly below the standing part, this weight change moves the approximate within-standing quantile needed for the mixture median from the 12th to the 30th percentile. With a clock-related low-density region between release modes, that can span minutes. It does not require crossing exactly 50% standing probability. The 256-sample approximation may add granularity, but it cannot explain the small CDF change versus the large observed mixture change by itself.

**The same visit at 10:50:57.917 and 10:51:12.761:** the cached pin already exists, but `rested=false → true` activates conditional pricing and changes the approach/repositioning situation to a continuing hold. New absolute-arrival jumps are **234.4s** and **244.7s**, including with the ceiling retained. Thus keeping the old ceiling alone cannot remove model-entry discontinuities.

**The same visit at 10:58:22.924:** support and clocks remain valid, but the priced rest share rebounds **0.209→0.914** during a shuffle. Current-only rises **179.4s**, versus baseline43.1s and clamped57.4s. The retrospective final departure does not occur until 10:59:12.981. This is a real shuffle previously verified against raw GPS, not a reason to discard the record.

Some parent score rows describe a jump as “departure” relative to an earlier Union source, while the bus is now arriving at Winchester. The JSON includes the physically active source episode separately. For example the #316 Sep16 09:38:17 jump is in Winchester58061, despite an earlier-source context of57806. Also,65237 has a known truncated stored pin: its jump is still a real forecast transition in the continuous raw replay, but the stored “approach” phase must not be interpreted literally.

## Why the intervals remain broad

At the 47 Winchester→Division standing+60s checkpoints:

| Quantity | All47 | Supported release41 | Fallback6 |
|---|---:|---:|---:|
| Mean shown interval width | 543.9s | 521.8s | 694.8s |
| Mean conditional release-only width | — | 281.1s | — |
| Mean width after conditioning route price on its standing hypothesis alone | 508.6s | 460.4s | 838.5s |
| Point MAE | 120.2s | 90.6s | 322.9s |

For supported cases, mean lead-leg probability is **98.9%**, with standing75.3% and moving23.6%. Unrelated route branches are therefore not the main explanation. Removing the departure mixture reduces the mean shown width by about **61s** in this counterfactual. Downstream uncertainty plus existing route/horizon transformations and widening account for much more of the difference between the release-only281s and standing-only460s. This is a comparison of interval widths, not an additive variance decomposition.

The standing-only counterfactual preserves the current lead's conditional standing position distribution and uses the same route tables/corrections. The “rawPrices” field in the trace means **without the display ceiling**; it still includes the published route correction, horizon correction and widening. For example57463 has a197s release-only width, a357s standing-only route width, and a398s full shown width. Red's1.1 route correction and the old approximately1.4–1.6 horizon widening materially expand the new conditional distribution. Their calibration was for the old forecasting path, so their continued use or removal both need evaluation.

## Bounded corrections and review of the frozen follow-up

1. **Keep the episode clock and covariate fixed once causally available.** Preserve the original pin and matched prior departure through genuine shuffles. Do not use a later current-departure reset as the preceding-lap feature. Do not infer a new episode solely from a single repeated or changed GPS coordinate. Test model support entry/re-entry separately from late-tail survival. This corrects feature identity, without forcing position backwards or ETA to decrease.
2. **Evaluate the display mixture separately from the position filter.** The evidence supports the parent's bounded trial of pooling absolute-time quantiles while the same rest continues, then responding to causal departure evidence. Reinstating a running-minimum ETA would recreate the valid report115 trough. Changing the movement filter is a different intervention; the current jump diagnosis does not establish that its position posterior is wrong.

The frozen follow-up's30s convex pooling of ordered absolute-arrival quantiles preserves quantile order mathematically. The old lower-side widening with an identity transform on the upper side is also a continuous monotone quantile transform when the widening factor is positive. These are coherent distributions/display estimators, **not inherited calibration guarantees** or a posterior obtained simply by conditioning the old model.

Three concrete checks remain important for that frozen arm:

- The smoothing `active` condition currently depends on a saved layover pin and resting belief, **not on release-model support**. Thus it also modifies missing/out-of-band-lap fallback cases. Report that stratum separately and describe the actual scope.
- Releasing the smoothing when `belief.rested` ends is not necessarily responding at the first observed movement. The raw audit shows real departures while the collector pin persists, and the filter can also retain an established rest during movement. Score departure+5/+15 checkpoints and the verified short holds64318/58224; a lower-bound miss is a forecast error, while an actual missed connection still requires a boarding-policy evaluation.
- Verify both target occurrences, model entry/re-entry, lower/median/upper ordering, and agreement with any exported distribution. The current jump review covers the first occurrence only. The memory key is target/occurrence; the existing consecutive-frame, elapsed-time and `stopsAhead` gates should be tested at target passage and service-state changes.

The reserved later recording should evaluate the already frozen candidate, including the explicitly declared refitted variant if any. It must not be repeatedly used to choose a smoothing time constant, which tail to narrow, or which valid difficult records to remove. The verified short and long holds remain in the evaluation. This report diagnoses the development model; it is not a deployment approval.
