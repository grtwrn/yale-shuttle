# Brown handoff findings

Hosted audit35686521295 atda2129a passed7 classification/clock fixtures and
exact parity with the previous9 frozenK8 and18 rollingK5 handoffs. All protected
forecast/label/score/action bytes and original raw hashes are unchanged. No
September21 or later outcomes were opened, and nothing was fitted or deployed.

Every one of the27 records pairs the same physical pickup visit with snapshots
at most30s apart. All27 have continuous same-route/same-provider GPS both between
snapshots and through the observed pickup departure, under the existing60s gap
and22m/s checks. This does NOT mean every snapshot met the stricter15s feature
freshness limit. There are28 additional excluded transitions:11 without labels,
2 snapshot gaps,15 different pickup occurrences. These exclusions are identical
to the preceding study.

The10 freshness edges represent only THREE GPS-delay episodes, shared between
arms, not ten independent incidents. Retained observation age was17.424–22.119s;
bracketing GPS gaps were20.556–25.656s. All were fresh again at the next logged
snapshot15s later. No provider switch occurred inside an audited interval.

| Cause | FrozenK8 / rollingK5 edges | Chronological first, ET | Largest additional bound movement relative to deployed |
|---|---:|---|---|
| Confirmed wait departure | 0 / 1 | Sep17 08:30:45, #126, Divinity | Same case: lower+129s, upper+60s; actual lower+114s, upper−22s |
| Freshness loss/recovery | 4 / 6 | Sep17 11:06:15, #126, State St Station | Sep17 15:10:30, rollingK5 #126 Divinity: upper+318s additional, +300s actual on recovery |
| Whole-group countdown expiry | 0 / 1 | Sep17 09:31:00, #126, Humphrey/Whitney | Same case: lower+263s, upper+73s additional; actual lower+297s, upper+91s |
| Source first becomes causally known | 0 / 5 | Sep17 11:00:45, #126, State St Station | Same case: upper−244s additional, −258s actual |
| Fixed45-minute source-age expiry | 3 / 0 | Sep17 08:28:45, #126, Divinity | Same case: lower+109s, upper−470s additional; actual lower+122s, upper−468s |
| Progress-only release, no retained completed wait departure | 0 / 5 | Sep17 13:19:00, #126, Divinity | Sep18 10:14:45, #304, Divinity: upper+266s additional, +253s actual |
| Pickup-before-wait activation change | 2 / 0 | Sep18 10:14:45, #304, Divinity | Same case: upper+261s additional, +248s actual; reentry10:17:15 upper−116s additional |

All point-clock changes are exactly the deployed point changes; additional
point movement is zero. Absolute bound jumps include elapsed time: an ordinary
countdown loses15s over15s and therefore has zero absolute-clock movement.
Additional movement is hybrid absolute-clock change minus deployed change.
No arbitrary cutoff labels a jump bad. For scale, the Sep17 11:47 source expiry
changes the upper clock by only+9s versus deployed+1s (additional+8s), whereas
the first source-age expiry changes it−468s versus deployed+2s.

## Interpretation

One confirmed wait departure supplies actual new departure information, and
five entries have a newly known source departure. These are legitimate model
state changes, though the resulting bound movements still need coverage review.
The five other released/live transitions are phase/progress evidence (index4
drive→index6 drive), not proof of a recorded stop/departure at Union Station5.
Their causal emissions for stop6 have no completed departure. Do not upgrade
them to confirmed departures or infer a long GPS gap.

The15s freshness gate explains the brief fallback/recovery pairs. Withholding
the hybrid when current tracking is stale is defensible; the size and direction
of the interval change are not implied by that evidence loss. For example,
rollingK5's Sep17 15:10:15 stale fallback SHRINKS the upper clock by300s; recovery
15s later EXPANDS it by300s, with deployed upper changes−34s and−18s. Other stale
fallbacks correctly widen the upper bound. These opposite directions follow
from switching between differently calibrated intervals, not changed point
predictions or measured five-minute changes in the bus's travel.

The45-minute source-age cliff is an existing feature-eligibility rule, separate
from the90-minute Brown training-path cap. At the largest case, the bus remains
in hold at index5, GPS age is0.063s and no visit is emitted; source age alone
crosses2700s. The countdown-expiry case likewise has fresh GPS, no phase change,
and withdrawal of a whole target group when a model point countdown reaches60s.
Neither is physical departure evidence.

The two frozenK8 pickup-before-wait edges also deserve an occurrence-state
review: index4→6 causes fallback, then index6→5 reactivates the SAME retained
source. There is no completed wait departure to confirm that the bus truly
passed/returned. The modulo progress rule at K=n−1 cannot alone prove which
source lap remains valid. The audit reports this ambiguity, not a fabricated
physical return or a proposed release-rule fix.

## Leads and next question

Retain BOTH Brown frozenK8 and rollingK5. On the same18-visit common cohort,
they narrow77s and85s, preserve99.19% coverage and add no late-tail error.
Source support is9 and13 journeys respectively across2 dates. Both widen on
Sep17 and narrow on Sep18. At a3-minute walk,13 common rendered-reminder pairs
show zero additional misses and mean extra waiting0.85s /0s respectively;
7 of20 deployed rendered actions are censored. Neither is deployment-ready.

A principled next experiment would distinguish uncertainty withdrawal from
physical release, rather than average away jumps. In particular, test a
separately preregistered conservative interval envelope on TEMPORARY freshness
loss: combine the last causally accepted absolute bounds with current deployed
bounds, keeping the deployed point unchanged, and reset only on explicitly
defined causal evidence. Such an arm must use no future connectivity checks,
must keep route/provider/source identity and existing expiry limits explicit,
and must report added width/waiting. This is an UNIMPLEMENTED research proposal;
no holding, smoothing, freshness extension or threshold change occurs here.
Source-age expiry and possible source-occurrence reactivation need separate
experiments, not silently expanded scope in that temporary-freshness arm.

Record-level clocks, original snapshots, causal emissions, adjacent occurrences
and raw continuity evidence are in artifact35686521295/handoff-records.jsonl.gz.
The prospective protocol below keeps both current leads unchanged while the
transition questions remain unresolved; numerical leads are not promotion flags.
