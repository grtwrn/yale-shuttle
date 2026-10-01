# Ahead-shuttle trigger investigation

**The explicit stop-trigger family is now tested separately from broad headways. The useful new lead is predecessor progress interacting with the clock at Winchester.** This does not identify a single dispatch trigger. Union benefits are small or mixed. No app change, model publication or reserved-afternoon feature tuning was performed.

## Causal contract and chronological evaluation

The predecessor is the most recently confirmed **other** bus to depart the same regulator before the focal bus pins, on the same day and within 60 minutes. Its completed-record availability must precede focal pin, and its identity stays fixed throughout the hold. This is earlier-departure order, not future-defined order or the nearest physical bus after an overtake.

The existing elapsed-age, own-lap and 15-minute-clock departure hazard is the baseline/offset. New coefficients fit Sep 3, 4, 8 and 9; a separate probability calibration intercept uses Sep 10–11; evaluation uses the previously inspected Sep 14–17 development recordings, ending at **17:14:00.913 UTC on Sep 17**. Winchester/Union counts are 102/112 training, 58/61 calibration and 99/103 evaluation holds. Predecessor identity is known for 95/99 and 100/103 evaluation holds. The previously proved corrupt source 65237 is excluded by the existing cohort; legitimate short and long outliers remain.

Each prediction covers departure in the **next 15 seconds**, using neighbor observations available at the start of that risk bin. This is adaptive one-step hazard validation. A current remaining-wait CDF cannot be evaluated by supplying the predecessor’s realized future route: that would leak. No such future-path input is used here.

Two availability contracts are evaluated:

- **Pinned arrival +15s / clearance +30s proxy:** a pin becomes arrival evidence only at pin time +15s, including pinned passes. Unpinned passes are not asserted stop arrivals. Sparse forward progress uses anchor +15s for every visit, regardless of whether it later pins. Clearance uses a non-gap departure +30s. These are timestamp proxies, not exact receipt logs.
- **Completed +120s sensitivity:** evidence is admitted only after completed departure +120s, or later recorded confirmation evidence. This may remove precisely the information an immediate dispatch trigger needs. Duplicate arrival/clearance columns, when present, are collapsed from training features only.

**Correctness repair:** the preliminary “pin if it eventually pins, otherwise anchor” fallback could make early event absence depend on a future pin. It was removed before this final report. All numbers below use the corrected contract; `before-causal-fix` files are archived, superseded diagnostics.

Initial fixed families were baseline, predecessor availability/headway, sparse progress, all-stop recent arrival pulses, all-stop recent clearance pulses, and their joint extension. Pulses last 120 seconds. Stop columns enter jointly with L2 = 10 and need exposure in at least five training holds on two dates; development outcomes do not select supported stops.

A separately documented **post-first-screen extension** tests the user’s “wait until” wording more directly: persistent already-reached/already-cleared flags since the predecessor’s selected prior-source departure, plus already-reached flags interacting with the current 15-minute clock. All three extension families are reported; no individual stop is chosen from evaluation results.

## All tested families

Mean sequential negative log loss per hold; lower is better. Raw and independently intercept-calibrated results are both shown.

### Pinned arrival +15s / clearance +30s

| Family | Winchester raw | Winchester calibrated | Union raw | Union calibrated |
|---|---:|---:|---:|---:|
| Existing lap + clock | 3.1923 | 3.3244 | 3.3729 | 3.3737 |
| Predecessor availability/headway | 3.1728 | 3.3072 | 3.3674 | 3.3678 |
| Known forward stop progress | 3.1807 | 3.3251 | 3.3669 | 3.3663 |
| All-stop recent arrival pulses | 3.1532 | 3.2900 | 3.3695 | 3.3693 |
| All-stop recent clearance pulses | 3.1638 | 3.2960 | 3.3729 | 3.3720 |
| Progress + arrival/clearance pulses | 3.1685 | 3.3084 | 3.3829 | 3.3820 |
| Already reached (extension) | 3.1357 | 3.2860 | 3.3662 | 3.3656 |
| Already cleared (extension) | 3.1436 | 3.2879 | 3.3666 | 3.3655 |
| Already reached × clock (extension) | 3.0649 | 3.2609 | 3.3585 | 3.3615 |

### Completed +120s sensitivity

| Family | Winchester raw | Winchester calibrated | Union raw | Union calibrated |
|---|---:|---:|---:|---:|
| Existing lap + clock | 3.1923 | 3.3244 | 3.3729 | 3.3737 |
| Predecessor availability/headway | 3.1728 | 3.3072 | 3.3674 | 3.3678 |
| Known forward stop progress | 3.1711 | 3.3111 | 3.3644 | 3.3636 |
| All-stop recent arrival pulses | 3.1637 | 3.2957 | 3.3479 | 3.3473 |
| All-stop recent clearance pulses | 3.1637 | 3.2957 | 3.3479 | 3.3473 |
| Progress + arrival/clearance pulses | 3.1619 | 3.2974 | 3.3497 | 3.3485 |
| Already reached (extension) | 3.1379 | 3.2893 | 3.3704 | 3.3691 |
| Already cleared (extension) | 3.1379 | 3.2893 | 3.3704 | 3.3691 |
| Already reached × clock (extension) | 3.0607 | 3.2568 | 3.3914 | 3.3929 |

At Winchester, arrival pulses improve raw log loss 3.1923 → 3.1532. Already-reached × clock improves it to 3.0649, about 4.0%. Raw mean Brier per hold changes 0.053278 → 0.052244. This is a predictive lead, not a measured 4% improvement in rider ETA accuracy.

### Date consistency for the Winchester interaction

| Development date | Holds | Baseline raw log loss | Interaction raw | Baseline calibrated | Interaction calibrated |
|---|---:|---:|---:|---:|---:|
| 2026-09-14 | 28 | 3.4601 | 3.2532 | 3.6315 | 3.5484 |
| 2026-09-15 | 21 | 3.0184 | 3.0449 | 3.1625 | 3.3339 |
| 2026-09-16 | 33 | 3.0264 | 2.9307 | 3.1744 | 3.0649 |
| 2026-09-17 | 17 | 3.2879 | 3.0397 | 3.3095 | 3.0776 |

Three dates improve; Sep 15 worsens. Calibration on the two earlier dates lowers Winchester’s forecast departure rate and worsens absolute development log loss for all families, so it is not a reliable probability-calibration guarantee. Union live-event effects are small, the joint pulse family worsens, and the delayed already-reached × clock family also worsens.

Risk bins share holds, buses and days. Primary scores sum sequential log losses per hold. Per-hold Brier is descriptive; pooled risk-bin Brier and all date/availability strata are in JSON. These scores establish neither a remaining-time interval nor fewer missed buses.

## Event timing and negative controls

The CSV reports every one of the 29 route stops, both source regulators, all three date partitions, both event types and both latency contracts. It includes risk exposure, hold/date support, actual departures, and the baseline hazard’s expected count. The timing control looks at events becoming known in the **next** 120 seconds and is descriptive only; it never enters a predictive feature. Observed/expected ratios are not causal effects or independent significance tests.

Illustrative training-associated stops, with all stops retained in the predictive families:

| Focal stop; predecessor arrival | Training after: observed/expected | Development after | Development before-event control |
|---|---:|---:|---:|
| Winchester; College / George | 12/6.07 (1.98×) | 11/4.83 (2.28×) | 11/5.66 (1.94×) |
| Winchester; College / Crown | 11/7.02 (1.57×) | 12/5.69 (2.11×) | 9/5.63 (1.60×) |
| Union; 130 Prospect Street (N) | 4/2.04 (1.97×) | 5/5.37 (0.93×) | 10/7.14 (1.40×) |
| Union; 344 Winchester | 13/10.17 (1.28×) | 8/5.69 (1.41×) | 7/5.05 (1.39×) |

College/George and College/Crown show Winchester associations after arrival, but development departures are elevated before those events as well. Union’s Prospect association does not persist after arrival. Shared operating cycles, correlated progress and anticipation of a nearby predecessor remain plausible explanations. The event-latency proxies also prevent treating the negative controls as definitive disproof of an operational rule.

## Recommendation

**Keep predecessor progress × clock as a Winchester research candidate; do not hardcode a stop-trigger rule or add this family to the already frozen production candidate from these results.** Verify predecessor identity and exact receipt times against continuous GPS, including overtaking, missing buses and same-stop encounters. A later prospective shadow can test the fixed family on new dates. Full ETA use must forecast future predecessor movement causally and fall back when the evidence is stale.

Same-stop co-presence is the parent agent’s separate investigation. These families do not exhaust conditional dispatch barriers, other landmarks, service blocks or alternate fleet-order definitions. Weak average results do not rule out a real operational rule or a better model of it.

Reproduce with `ahead-trigger-screen.py`, `ahead-trigger-barrier.py`, then `ahead-trigger-report.py`. Corrected plans, JSON/log evidence, all-stop CSV and input hashes are saved alongside this report. SQLite access was read-only; the reserved afternoon and application files were untouched.
