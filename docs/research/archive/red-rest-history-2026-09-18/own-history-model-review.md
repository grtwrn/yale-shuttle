# Independent own-history model review

**Recommendation: run one bounded continuous Division pickup replay of the frozen simple previous-Winchester-history candidate, with its existing lap/clock/Union-age controls and production fallback. Do not deploy it or raise the pickup lower bound from this component screen.** The combined-history arm should remain research pending the prior-Union fragmentation issue documented below. No model was fitted or production code changed by this reviewer.

Reviewed `own-history/{PLAN.json,TIMING_AMENDMENT.json,screen.py,extend.py,cohort.json,extraction-audit.json,fits.json,predictions.jsonl,scores.json,extension-meta.json,extension-scores.json}` plus the saved unchanged-runtime comparison. Independent measurement evidence and its reproducible script are in `own-history-measurement-review.{md,py,json,log}`.

## Causal and statistical checks

- The two original control arms exactly retain the preceding survival screen. Each of160 training holds contributes one event-history likelihood; 15second bins and the1800second right-censoring/tail rules match that screen. There is no repeated-landmark weighting in fitting, residual trimming, or refitting on the later outcomes.
- History is fixed at current Winchester pin. Candidate visits must have already observable anchors, valid Red stop occurrences, the same local day, and bounded recency; a known intervening other-route assignment resets eligibility. Every duration/clock used is checked against the chosen completion-availability proxy. Passed records are retained and the latest unknown/invalid record becomes missing rather than being skipped for an older favorable duration.
- Current-lap rest begins after the prior Winchester departure; it does not include that previous Winchester hold or any part of the current target hold. No future peer observations enter these own-history arms.
-65237 remains the latest previous Winchester record for focal65720, with **duration missing and departure usable**. This correctly separates its proved truncated origin from its valid departure. All selected prior histories were checked independently against raw or stored clock evidence.
- Earlier120second and primary confirmation proxies produce identical history values. The600second-plus-confirmation sensitivity changes one focal episode,48783; its separate prespecified results are retained. These are observation-availability proxies, not proof of actual receipt time.
- All seven arms were fixed in advance. Coefficients were saved before the five new completed episodes were opened for scoring, and the extension script uses those coefficients unchanged. The five are from the same already-inspected Sep18 service day, so they are a useful chronological extension, not independent-day confirmation.
- Scores correctly distinguish fixed-age equal-visit comparisons from visit-balanced sampled-landmark summaries. WIS80 includes interval width, early/late shortfall, and median absolute error with the stated weights. Counts of bad checkpoints are not counts of independent buses or days.

## Benefit is modest but more useful than Union age alone

The following is the supported-lap component comparison. All history arms extend the Union-age control. Lower WIS and MAE are better; width need not shrink for accuracy to improve.

| Evaluation | Supported visits | Union-age WIS → +previous Winchester | MAE change | Window width change |
|---|---:|---:|---:|---:|
|Sep14–17 reused dates|100|43.85 →43.07|69.18 →67.64s|292.55 →289.41s|
|Sep18 earlier observations|9|57.35 →53.20|80.51 →72.89s|373.50 →378.62s|
|Sep18 later frozen extension|5|54.74 →49.47|88.9 →81.3s|about311 →317s|

Thus the stronger improvement on Sep18 comes chiefly from better forecast placement and fewer late misses, **not consistently narrower windows**. On the five later holds, late checkpoints fall8→3 and early checkpoints remain zero. These five visits cannot establish a population coverage guarantee.

On reused dates, the previous-Winchester arm improves WIS on Sep14,16,17, with a small Sep15 regression34.03→34.11. The bus breakdown is also mixed: it improves four of five bus names on the reused dates, while #308 worsens by0.63 WIS across18visits. Sep18's earlier gain is concentrated in #306 (−10.74 WIS,3visits) and #309 (−4.03,3visits); #316 worsens by2.31 across its three visits. These are descriptive strata with strong day/vehicle overlap, not grounds for outcome-selected bus gating.

The prior-Winchester coefficient is negative in the departure-hazard model: longer earlier standing predicts a somewhat longer current hold, conditional on the modeled lap, current age and clock. This supports a **persistence association**, not a simple deduction of the previous break from a fixed rest budget. It may reflect operating rhythm, traffic, vehicle/driver assignment, or unmeasured common causes. Neither bus ID nor bus name identifies a driver or a shift change.

## Genuine lower-tail regressions remain

Newly affected67621 is a valid245.342second Winchester hold. At elapsed180 it has65.342seconds left; adding prior Winchester raises q10 from62.595 to69.866seconds, producing a4.524second early-bound miss. Its previous Winchester67188 is also a valid long hold:640.019seconds standing,130 raw fixes,529.875second coordinate plateau, maximum raw gap5.218seconds and matching inbound leg62275. Current67621 preserves its inbound pin (leg62713) through a25.478second mid-visit gap and moves4.994seconds after the recorded final-rest endpoint. There is no evidence to remove either record.

The earlier important cases remain imperfect:64318 at elapsed60 has a lower-bound error increasing from35.14 to38.96seconds;65347 at elapsed480 increases from31.15 to37.94seconds. The worst old supported lower shortfall increases from39.71 to46.50seconds, despite a lower overall early-checkpoint count23→21. These are expected possible tradeoffs of a changed distribution, not automatic disqualifiers. They matter for a rider leave-by policy and must be carried into endpoint replay with target-arrival and target-departure margins.

## Input-quality limits of the other history families

The160 fitted focal episodes have140 known prior Winchester durations,149 prior Union durations,143 Gilbert/Cedar durations and140 Amistad/Cedar durations. Only **two** of the Gilbert/Cedar histories and **one** of the Amistad/Cedar histories reach120seconds. Therefore the mostly weak/mixed Cedar arm cannot settle the hypothesis about genuine multi-minute Cedar breaks.

Two specific prior-Union records are incomplete fragments: training focal25064 uses24868 after unresolved24861 and a provider-ID change; development focal60263 uses60020 after unresolved59983 and another ID change. For60020, raw GPS proves a319.993second same-zone plateau before its4.946second recorded fragment. For24868, raw is unavailable locally, so completeness is uncertain rather than an exact repaired duration being known. The partial-current-lap flag notices unresolved history, but standalone prior-Union and the combined arm still receive the latest fragment's numeric duration. Preserve original screen results; any measurement-quality sensitivity must mask these inputs on provenance grounds while retaining focal outcomes and valid departures.

The simple previous-Winchester candidate does not use those Union-duration columns. A metadata check across250 distinct usable previous Winchester durations found no additional earlier unresolved/gap same-stop anchor within20minutes without an intervening Union anchor, after the existing65237 mask. This is supportive provenance, not exhaustive raw verification. The broader measured clock and sum remain observed stop history, not an inventory of driver breaks.

## Neighbor-screen cross-check

The corrected `neighbors/screen.py` uses the latest **unconditional** anchor from every other bus, with current all-route assignment checks,15/120second visibility sensitivity, staleness limits and explicit co-location/tie uncertainty. No eventual pin outcome or future departure is used in selection. Equal-landmark fitting avoids the earlier outcome-dependent fit-weight problem. At70927, the15second contract correctly identifies #316 at Division ahead and #306 at Rosenkranz behind;120seconds yields unknown order because the older Winchester anchor is still co-located. Identity differs from the old departure-order proxy at237 of1022 snapshots under15seconds.

The measurement repair is valuable, but its simple predictive additions remain inconsistent: both-neighbor Brier improves0.105961→0.104248 on reused dates and worsens0.050700→0.051926 on Sep18; the120second contract worsens both periods. These are topological stop gaps, not exact distance or live minutes-to-stop. This does not disprove a real dispatch trigger, but it supports prioritizing the simpler own-Winchester full-path experiment now.

## Full-replay acceptance requirements

Freeze the simple arm and history availability contract before replay. Preserve current tracking and departure evidence, use only history actually available at each replay timestamp, and preserve production fallback for unsupported or untrustworthy history. A component prediction at an oracle pin is insufficient: test entering/exiting Winchester, shuffles, departure responsiveness, forecast pooling, Division's first and subsequent occurrence, and completeness/availability.

Report all valid journeys, fixed waiting/departure checkpoints, per-day and bus strata, proper scores, upward/downward arrival-time jumps and lower-bound misses relative to both target arrival and departure. Retain64318,65347,67621 and every other valid early release. A modest rare-tail tradeoff may be acceptable, but that judgment must be based on rider-facing endpoint behavior. The current evidence supports this bounded replay; it supports neither further tightening of the displayed minimum nor a claim of calibrated safe departure time.
