# All-route K10 qualification

Every currently published line was assessed using the same September 3–20
public fleet archive as Blue. The fixed rules and results live on
`research/all-k10-2026-09-21`; hosted export is
https://github.com/grtwrn/yale-shuttle/actions/runs/35675303606.
Training completed before September 16; evaluation uses September 17–20.
Those dates have been inspected in earlier research, so this is a transfer
check, not a fresh global holdout. Target visits on one source trip correlate.

The prespecified promotion gate requires at least twelve target visits on two
later dates; MAE no more than twenty seconds worse; mean width at least one
minute narrower; coverage at least 80% with no loss above ten percentage points;
no added false-now readings and no introduced adjacent-stop reversal over 30s.
The model is not enabled merely because its intervals look narrower.

| Line | Result |
| --- | --- |
| Red, Blue Day, Blue West | Retain the previously qualified exact fits/scopes. |
| Orange Night | Qualifies; added to the default. |
| Orange Day | MAE improves 32s, but width grows 2m12s. Retain live estimate. |
| Gold | Width shrinks, but MAE worsens 66s and coverage falls 11.8 points. Retain live estimate. |
| Orange East | Eight target visits; width grows 32s. Insufficient evidence for promotion. |
| Blue Night, Blue Weekend, Pink, Green, Purple | No forecast group has sufficient qualifying support. |
| Brown | Nine-stop loop needs multiple source occurrences to implement K10; not supported by the single-occurrence clock. |
| Grocery Ham | No training stop meets the major-wait definition. |
| Grocery TJ | No currently published route topology; do not infer an order from partial historical visits. |

Orange Night's replaced subset has 548 snapshots across 24 physical target
visits from thirteen source trips on four evaluation dates. MAE changes from 457.98s to 308.71s, mean width
from 1269.37s to 783.64s, and coverage from 59.9% to 83.3%. Neither arm adds a
false-now reading in that subset. No ordering reversals over 30s occurred in
124 adjacent-stop pairs. Eight observed release handoffs include a maximum
countdown-adjusted downward jump of 518s; entering or re-entering the checkpoint
model can jump upward too. These transitions require production-clock parity
and explicit review; the average improvements do not establish smooth handoff. These counts are implementation/qualification
evidence, not a promise about every future trip.

Orange Night starts at Audubon / Orange (index16), ten stops before 333 Cedar
(index0) on its 26-stop loop. Every subsequent target through the remainder of
the loop belongs to one group. Historical training paths may last 90 minutes;
live source clocks expire after 45 minutes. Support, freshness, ten-minute
continuous GPS warmup, startup recovery, route-occurrence agreement, shared
60-second expiry fallback and exact live handoff after Cedar follow Blue's
already tested numerical implementation. The original Blue model files are
unchanged. There is no model-version banner or chooser in the rider interface.

The frozen Orange Night fit expires September 28 at 00:00 America/New_York.
`SHUTTLE_ROUTE_K10=0` disables the additional route overlay while preserving
Blue's separately controlled defaults. `SHUTTLE_BLUE_K10=0` disables Blue only;
`SHUTTLE_K10_TRIAL=0` disables all checkpoint overlays. Internal API diagnostics
can still request `eta_model=usual`; rider page URLs always use the default.

## Covariate interpretation

The September18 follow-up studied Winchester departure/remaining-rest outcomes.
Own lap and elapsed time since Union were considered, but adding Union age
narrowed supported remaining-rest windows by only 4–6s. That experiment did not
replay a different full checkpoint-to-pickup model. The K10 finding changes the
prediction formulation and joint timing distribution, so the earlier component
search could miss it. It should have included this end-to-end comparison sooner.

Early-break compensation is a hypothesis, not an established driver policy.
A new covariate evaluation should use K10 as its baseline and score incremental
full-ETA gains from causal upstream standing time/location, driving pace and
peer spacing. Training, feature selection and calibration must precede scoring;
actual future holds, future neighbors and selected early cases cannot serve as
features. This rollout includes no new fitted covariate coefficients.
