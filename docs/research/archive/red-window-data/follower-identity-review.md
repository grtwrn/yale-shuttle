# Independent review: the bus behind

The new follower-progress experiment is justified. Earlier work screened geometric ahead/behind spacing with a fixed 3,035-second lap conversion; it did not test the explicitly identified follower's stop progress interacting with the 15-minute departure clock. A weak additive spacing result does not rule out that interaction.

This review tests **identity feasibility**, not predictive gains. `follower-identity-review.py/.json/.log` reproduce the audit using the old development database only, ending September 17 at 17:14:00.913 UTC. No reserved-afternoon observations, application changes or production fitting were used.

## Causal identity contract

At focal pin, choose this bus's latest already-known departure from the same regulator on the same local date, within 90 minutes. Among already-known other-bus departures after it, latch the first distinct bus. Current or future completion of the focal hold must never determine the identity. Use an intervening already-known opposite regulator as a support check, and do not use future records to fill missing identities.

This is a **follower in recorded departure order**, not guaranteed current physical order. Overtaking, missing visits, new service assignments and a long hold can change the physical relationship. Keep the identity latched during the hold so an observed change of neighbor cannot masquerade as the selected bus reaching a landmark. Missing/unavailable identity should fall back rather than be redefined using eventual next arrivals.

The independent sensitivity takes each bus's latest unconditional anchor plus 15 seconds, regardless of whether it eventually pins or stops. The latest anchor across all routes is checked before requiring Red, to avoid treating a bus last seen on another route as still Red. It must have a valid route occurrence and a physical anchor timestamp within the freshness limit. Minimum positive backward modulo **stop-index** displacement defines the comparison identity. This is not metric distance or exact synchronized GPS. Co-located and tied cases are recorded, not silently assigned.

## Observed support and agreement

| Old development sample | Winchester | Union |
| --- | ---: | ---: |
| Focal completed holds | 99 on 4 dates | 103 on 4 dates |
| Modern departure-order follower known | 87 | 92 |
| With known intervening opposite regulator | 86 | 92 |
| Follower is also latest predecessor | 28 | 32 |
| Only one fresh other bus in 10-minute anchor view | 33 | 35 |
| Departure-order and sparse-anchor agreement, both available | 84/85 | 90/92 |
| Modern/legacy departure-order agreement, both available | 85/85 | 91/92 |
| Sparse follower available with 5 / 10 / 15-minute freshness | 93 / 96 / 98 | 96 / 100 / 100 |

The two identity definitions usually agree, supporting a bounded screen. However, the follower equals the predecessor in roughly one-third of visits with a known follower. These are cases with one distinct other bus observed departing after the focal prior departure; they do not by themselves establish a two-bus fleet. A follower effect there cannot be distinguished from a predecessor effect. Report same-versus-distinct identity strata and fresh observed fleet counts.

The all-route reassignment check found **zero** contradictory route anchors at pin or during the hold across all 473 selected modern departure-order followers in training, calibration and development. `follower-route-reassignment-check.json` and the main script preserve that check. Restricting the parent's anchor source to Red is therefore a prospective caveat, not a demonstrated contamination in these data.

Concrete disagreements are preserved with exact event IDs in JSON:

- Winchester source57581: order selects #309; the 10-minute anchor rule selects #308 because #309's last anchor is 650 seconds old. A 15-minute rule restores #309. This is a freshness/missingness sensitivity, not evidence of an overtake.
- Union source47850: order selects #316, but only #308 has a sufficiently recent anchor. The sparse rule's fallback to that sole bus is not verified physical follower order.
- Union source65927: modern order selects #300, whereas legacy order and recent anchors select #309. The modern record stream lacks the intermediate #309 Union completion. The same absence makes Winchester source65852 fail the modern opposite-regulator guard although legacy evidence passes it. These are identity-provenance differences; none invalidates the focal wait outcome.

## Review requirements for the predictive screen

Use the existing elapsed-age + own-lap + clock hazard as the baseline and fixed chronological fit/calibration/development partitions. Predict departure in the next 15 seconds using follower evidence available at the **start** of that bin. Observed-reached flags must begin at the latched follower's selected source departure; an absent observed flag is not proof that the bus physically has not reached the stop. Include identity availability and progress staleness, retain legitimate long/short holds, and report all predefined families rather than choosing a stop from development outcomes.

Joint regularization across all supported stops and fixed clock interactions is preferable to testing each stop for significance. Support and duplicate-column removal must be learned from training only. Report sequential log loss per hold, Brier scores, date-level differences, identity-known/missing strata and follower-equals-predecessor strata. Calibration from two dates is a separate sensitivity, not a guaranteed probability correction.

If the follower family improves against the basic hazard, that does not yet establish gain **beyond** predecessor progress: compare the distinct-neighbor subset and eventually a fixed combined model on new dates. Hundreds of risk bins are dependent observations within relatively few bus-day cycles.

One-step gains are an operational lead, not an ETA gain. Integrating this time-varying hazard into a remaining-wait CDF cannot use the follower's realized future path: it needs a causal forecast or jointly simulated future follower movement. Another valid approach would train a remaining-time distribution directly at fixed checkpoints using only the currently observed follower state, implicitly averaging over future evolution. Either approach needs full continuous arrival replay, movement/shuffle transitions and rider endpoint checks. This new screen should remain separate from the already validated Winchester release change.

## Parent screen code inspection

Reviewed `follower-progress-screen.py` while its predefined models were fitting. It correctly latches identities at pin, uses only events already known at each risk-bin start, rejects intervening observed focal source returns, and requires an already-known opposite anchor for departure-order selection. It uses the selected follower's latest already-confirmed source departure at pin as its history origin. The stop-order sensitivity rejects an episode's identity if any peer is co-located, which is stricter than this audit's positive-distance ranking and should reduce support slightly.

All seven feature families, both identity definitions, both event-latency contracts and raw/calibrated scores are retained. The separate fixed predecessor-interaction offset and same-as-ahead/distinct-neighbor strata address overlap with the earlier finding. An assertion requires the reused predecessor offset to reproduce its saved prior score exactly. I found no blocking feature-time leakage in this implementation.

## Completed result review

Independently checked the saved results and parent report. `follower-results-review.py/.json/.log` preserve the numerical audit, paired episode identities, raw unknown-identity fallback assertions, and date-by-identity tables. The saved predecessor baseline is reproduced exactly. Primary identities match this audit for every development episode. The parent's observed-opposite-anchor guard is slightly more permissive than requiring an already-completed opposite visit; its same-stop ambiguity rule is stricter than the positive-gap comparison here. These explain the support differences.

Under the arrival-known proxy, Winchester progress×clock changes raw per-hold log loss from 3.1923 to 3.1738 (about 0.6%). After the existing predecessor model, the incremental change is only 3.0649 to 3.0616 (0.1%); reached×clock slightly worsens that comparison. There is little demonstrated additional Winchester information in these follower features.

Union has a modest exploratory signal: progress×clock / reached×clock change 3.3729 to 3.3379 / 3.3318 (1.0–1.2%). After predecessor adjustment, 3.3585 becomes 3.3172 / 3.3130 (1.2–1.4%). Both improve on three development dates and worsen on September 15. Sparse-identity and conservative-availability sensitivities broadly retain the small signal, rather than locating a single decisive trigger.

The Union proper-score evidence is not uniform. After predecessor adjustment, mean per-hold Brier is 0.075169 at baseline, 0.075373 for progress×clock and 0.075227 for reached×clock: effectively flat or slightly worse despite better sequential log loss. These metrics weight the hold's risk sequence differently; neither supports a probability-calibration claim.

The Union distinct-follower subset has 60 episodes on only three dates and 3.2–3.7% incremental log-loss improvement. Within those three dates, improvements remain: progress×clock 3.90%, 2.69%, 3.49%; reached×clock 3.86%, 2.89%, 5.79% for 18 / 30 / 12 episodes. However, September 15 has **zero** distinct-follower cases, 21 same-as-predecessor cases and two unknowns. The same/distinct contrast is strongly confounded with date and operating conditions. It is not evidence by itself for enabling the model only with three buses or for discarding the September 15 regressions.

The parent's six reviewed September 15 regressions (51469, 54002, 52633, 52168, 54777, 53429) all have the same selected follower and predecessor. Their reported holds range from 30 to 550 seconds, with completed non-gap rest evidence. This limited record audit is not a new GPS verification, and none should be excluded simply because the model scores it worse.

**Final recommendation:** retain follower progress×clock as a small Union research lead; Winchester gains mostly overlap with information already supplied by the predecessor. Do not change production from this screen. Preserve all arms and legitimate regressions, and use new dates to evaluate a fixed, causally implementable remaining-time model before claiming improved rider ETAs. The hypothesis is now explicitly investigated; these results still do not exhaust every operational rule or covariate interaction.
