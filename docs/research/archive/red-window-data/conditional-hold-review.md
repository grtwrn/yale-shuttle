# Conditional hold component screen: independent review

> Follow-up correction (September 17 full-path audit): this component used previous modern departures. Production lap ages actually use legacy `arrivals` departures, and live pricing uses filter `restSince`, not necessarily the modern pin. Its arithmetic remains reproducible, but it is not an exact live-feature-contract validation. See [full-path review](../conditional-replay-data/full-path-review.md).

**The normalized candidate is promising, and its reported arithmetic is reproducible; it is not ready for rollout.** It improves point and proper scores while narrowing Winchester's broad baseline intervals. The accompanying increase in interval misses is an expected tradeoff when reducing overcoverage, not by itself a failure. Union's larger improvement reflects a substantial upward shift in forecast location, not merely less dispersion. A bounded full-route diagnostic is reasonable if it preserves pass behavior and causal inputs; effects on actual departure responsiveness and rider missed connections remain unmeasured.

Reviewed `conditional-hold-prepare.py`, `conditional-hold-screen.mts`, their input/output, the prior model patch, production distribution/table/lap functions, and the subsequently added matched-cohort control and clock-pair audit. I did not edit app code or publish coefficients.

## Independent checks

[conditional-hold-review.py](conditional-hold-review.py) independently checks cohort IDs, time boundaries, baseline raw-table quantiles, all reported overall scores, finite ordered bounds, and exact baseline fallback. Results and input hashes are saved in [conditional-hold-review-audit.json](conditional-hold-review-audit.json).

- The September 14 midnight Eastern baseline has **168 Winchester records, including eight pinned passes**, and **180 Union records, including seven pinned passes**. Reapplying the current completion-bound SQL to the read-only DB reproduces both ten-knot quantile vectors exactly. Their latest contributing departures are on September 11. No test visit contributes to these tables.
- I also independently called `loadLapFits` with the same prior cutoff. It exactly reproduces Winchester `{b:-0.00095,m:3035,n:3331}` and Union `{b:-0.0010265,m:2825,n:25668}`. The fit query excludes later departures. This removes the specific test-label leakage demonstrated in the earlier no-ratchet screen.
- Exact historical ingestion availability is still not proved. Modern inputs assume at least 120 seconds plus the available confirmation delay; production table loaders enforce known evidence bounds; legacy lap labels lack exact receipt metadata. The weekend gap before these test dates makes immediate-boundary contamination less plausible, but does not create missing provenance.
- Winchester has 102 training, 58 calibration, and 58 test stopped visits; Union 112, 61, and 62. All tests are September 14–16. Normalized shapes use 139/154 prior valid-lap stopped visits. Additive coefficients use September 3–9, with residuals from September 10–11. Normalized and baseline tables may use all available pretest dates: this is allowed for this frozen comparison, but the arms do not have identical estimation procedures or training sample sizes.
- The saved four-arm outputs contain 892 Winchester and 972 Union prediction records, all checked. These are **120 distinct test visits**, repeatedly scored at survivor checkpoints, not 1,864 independent outcomes. At 600 seconds only eight Winchester visits across two dates and eleven Union visits across three dates remain.

## Scoring and survival are implemented as stated

For each fixed elapsed clock, the script retains every true stopped visit with duration greater than that clock, and evaluates all arms on identical IDs. This is a valid component-level survivor comparison. It is not the full live population, because whether the visit eventually qualifies as stopped is known retrospectively.

The script reconstructs a complete ten-knot duration distribution and calls production `residual` after scaling/translation. It does not subtract elapsed time from only two endpoints. The resulting CDF interpolates log survival and extrapolates an exponential tail; it is a modeled distribution, not a purely empirical histogram or a guarantee of conditional calibration.

The WIS formula is correct for a median and one nominal central 80% interval: `(0.5*absolute_median_error + 0.1*interval_score)/1.5`, with a factor of ten for each interval-tail penalty. `early` means the actual departure occurred before the lower bound; `late` means after the upper bound. Beware the point-field labels: **`earlyPoint120` means the prediction overestimated the wait by more than 120 seconds**, so the actual bus was early relative to the point. This is the dangerous direction for a rider delaying their walk to pickup.

Fewer than five surviving source values triggers exact baseline fallback, as specified. This prevents silently dropping difficult tests. It does not make five values adequate for reliable tails. `minTailSupport` includes fallback cases and becomes JSON `null` for the baseline's Infinity sentinel; report it as candidate support, not a confidence level. The additive support check can be zero, while its output remains baseline because of fallback.

## Decision-relevant results

Current scaled marginal → normalized shape:

| Component/checkpoint | n | MAE seconds | Mean width seconds | Early / late interval misses | WIS |
|---|---:|---:|---:|---:|---:|
| Winchester, 0 s | 58 | 138.4→116.0 | 477.4→378.8 | 0/2→5/6 | 78.2→67.4 |
| Winchester, 60 s | 55 | 131.6→113.8 | 449.1→375.4 | 1/1→2/4 | 74.2→65.9 |
| Union, 0 s | 62 | 185.6→116.9 | 430.4→404.9 | 1/25→9/4 | 110.8→74.9 |
| Union, 60 s | 56 | 174.9→106.8 | 365.2→373.3 | 4/24→5/3 | 103.1→69.9 |

Winchester at 0 seconds moves from 56/58 (96.6%) covered to 47/58 (81.0%), close to the nominal 80% target. Requiring the candidate to retain 96.6% coverage would unfairly reward a needlessly broad baseline. Better WIS provides positive evidence that the observed width/error tradeoff is worthwhile. This small inspected cohort still does not establish conditional calibration. Point overprediction by more than 120 seconds rises from 3 to 9 Winchester visits and 7 to 18 Union visits. Those are component forecast errors, **not measured missed connections**: they identify a consequence to assess in rider replay, not a reason to declare the candidate unsafe.

Winchester also varies by date: normalized 0-second MAE improves September 14/15, but worsens September 16 from 116.2 to 134.5 seconds; its WIS worsens that day too. Union improves both measures on all three dates at that checkpoint. The additive arm has a larger shift toward early misses at Winchester (eight at 0 seconds and ten at 60 seconds) and a particularly poor September 16 result. Its imbalance warrants investigation without treating any increase from the baseline's zero early misses as inherently unacceptable. Selecting the best arm/checkpoint after seeing these dates would make a new hypothesis, requiring new confirmation dates.

## What the normalization is changing

Initially, the comparison changed several things simultaneously: baseline includes pinned pass zeros and unsupported-lap visits and shrinks toward a class pool; the candidate uses valid-lap stopped records without class shrinkage. The **post-result** `matched_marginal_control` is correctly labeled exploratory and matches those cohort/construction changes. It confirms that normalization still narrows Winchester by about **62 seconds at 0 seconds and 65 seconds at 60 seconds** beyond that control. Tail losses also persist: at 0 seconds the control has 2 early/2 late misses versus normalized 5/6; at 60 seconds, 1/1 versus 2/4. Cohort selection is not the whole explanation.

Normalization is nevertheless not a pure spread correction. The independently checked modern prior eligible-lap medians are **3,217.5/3,159.4 seconds**, compared with legacy pivots **3,035/2,825**. Median factors are approximately **0.828/0.657**. Modern pooled stopped-duration medians are **337.6/410.4 seconds**, whereas the normalized shape medians are **429.8/634.6 seconds**. Applying a legacy relative correction to a newer, differently centered marginal can systematically shift its level; dividing prior outcomes by their factors re-estimates that level as well as its spread.

The clock-pair diagnostic supports part of this explanation, with important selection limits. At Winchester, 155/160 modern prior visits uniquely match overlapping legacy visits; modern pin is typically 15 seconds later, departure 15 seconds earlier, and paired hold about 34.8 seconds shorter. Paired lap difference is about +34.8 seconds on 134 eligible comparisons. Union matches only **114/173** visits, with lap about +150.1 seconds on 97 comparisons and hold about 145.1 seconds shorter. These are selected paired medians, not an exact decomposition of the full 182/334-second pivot differences. Different seasonal cohorts, coverage, eligibility, and previous-visit selection remain possible contributors. The current pair script matches the current visit but does not independently pair every previous departure; its lap comparison excludes large differences and uses different legacy/modern prior-visit rules. Do not attribute the entire effect to one clock bug without matching those previous occurrences too.

## Requirements for a full-route prototype

1. **Preserve stopping probability explicitly.** `arrival.ts:261` samples future `tables.stops[s].stand` directly; retaining the separate `pStop` field alone does not preserve the future hold distribution's zero mass. Replacing all q vectors with stopped-only normalized shapes changes future pass behavior as well as conditional hold duration. Either construct the appropriate zero-plus-positive mixture for future visits or limit the first experiment to an already established positive hold, with that narrower scope clearly recorded.
2. Keep baseline state and presentation unchanged for the first arm, then separately inspect unclamped current-distribution output. A component distribution can alter departure hazard if also used by the filter; explicitly distinguish a pricing-only arm from a joint state/pricing arm. Otherwise an apparent duration improvement may introduce a new departure delay or shuffle response.
3. Use prior-only empirical tables throughout and continuously warm beliefs at the real observation cadence. Observe original visit/track identity, clocks, early tails, first departure fix and +5/+15/+30/+60-second errors, reversals, and missed connections. Test all targeted journeys, not only completed stopped visits.
4. Do not tune this prototype on these same three dates and then call them confirmation. The normalized candidate has not received separate final-output calibration. Final selection and any widening need independent calibration/test blocks and the existing grouped-data promotion gates.

The component evidence earns a further **candidate experiment**, alongside diagnosis of mixed clock/cohort centering. The normalized shape has a useful improvement in WIS and deserves testing beyond this component. It does not yet establish narrower reliable rider windows or a remedy for report 115's standing-mixture ratchet. Judge the next experiment by calibrated width/error tradeoffs and actual departure/rider outcomes, not by requiring it to preserve the broad baseline's overcoverage.
