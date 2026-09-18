# Ahead-shuttle trigger investigation

The exact stop-trigger family has now been tested separately from general headways. The strongest new lead is **predecessor progress interacting with the clock at Winchester**. This screen does not establish a single stop at which one bus instructs another to leave. Union results are weak or mixed. No production change or reserved-afternoon feature tuning was performed.

## Design and support

The predecessor is the most recently confirmed **other** bus to depart the same regulator before the focal bus pins there, on the same day and within60min. Its identity is then fixed for the hold. Confirmation must precede pin by the conservative completed-record availability rule. This represents earlier-departure order, not an oracle future order or the nearest physical bus after an overtake.

Models use the existing elapsed-age, own-lap and15min-clock departure hazard as an offset. Training is Sep3/4/8/9; a separate calibration intercept is fitted on Sep10/11; evaluation is the previously inspected Sep14–17 development data, ending at17:14:00.913UTC on Sep17. There are102/112 training,58/61 calibration and99/103 evaluation holds for Winchester/Union. Predecessor identity is available for95/99 and100/103 evaluation holds. The known corrupted source65237 remains excluded by the pre-existing cohort; valid short and long outliers are retained.

Each prediction is the probability of departure in the next15s, using predecessor observations available at the **start** of that risk bin. This evaluates an adaptive departure hazard, not a remaining-wait distribution. Feeding the predecessor's realized future route into a current ETA would leak; this screen does not do that.

Two observation-time contracts are shown:

- **Arrival15/clear30 proxy:** arrival is pin+15s, or anchor+15s for an unpinned pass; clearance is a non-gap departure+30s. Arrival rows include passes and unresolved visits, so presence is not selected only from eventual stopped outcomes. These are plausible live-observation proxies, not exact receipt logs. Some anchor proxies represent an attributed approach rather than reaching the marker.
- **Completed120 sensitivity:** evidence becomes available only at completed departure+120s, or later recorded confirmation evidence. Arrival/clearance notification columns consequently coincide; exact duplicates are collapsed using training features. This is conservative and may erase an immediate real trigger.

All route stops enter jointly with L2=10. Stop columns need exposure in at least5 training holds and2 dates; this support rule does not inspect development outcomes. Initial families were baseline, predecessor availability/headway control, sparse forward progress, all-stop arrival pulses, all-stop clearance pulses, and their joint extension. The pulse window is120s.

After those first results, a separately recorded extension more directly tested the user's **until** wording: persistent already-reached/already-cleared flags since the predecessor's selected source departure, and already-reached flags interacting with current15min clock sine/cosine. These three families are explicitly post-first-screen exploration. No individual trigger stop was selected from evaluation results.

## Every tested family

Mean sequential negative log loss per hold; lower is better. Raw/calibrated columns are both retained because the two calibration dates shift Winchester's departure rate downward and worsen its absolute development scores. This calibration is not an80% coverage or ETA guarantee.

### Arrival15/clear30 proxy

| Family | Winchester raw | Winchester calibrated | Union raw | Union calibrated |
|---|---:|---:|---:|---:|
| Existing lap + clock | 3.1923 | 3.3244 | 3.3729 | 3.3737 |
| Predecessor availability/headway | 3.1728 | 3.3072 | 3.3674 | 3.3678 |
| Known forward stop progress | 3.1729 | 3.3194 | 3.3714 | 3.3709 |
| All-stop recent arrival pulses | 3.1543 | 3.2907 | 3.3699 | 3.3695 |
| All-stop recent clearance pulses | 3.1638 | 3.2960 | 3.3729 | 3.3720 |
| Progress + arrival/clearance pulses | 3.1598 | 3.3012 | 3.3868 | 3.3859 |
| Already reached (extension) | 3.1348 | 3.2802 | 3.3634 | 3.3632 |
| Already cleared (extension) | 3.1436 | 3.2879 | 3.3666 | 3.3655 |
| Already reached × clock (extension) | 3.0643 | 3.2596 | 3.3632 | 3.3661 |

### Completed120 sensitivity

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

For Winchester, the live-arrival pulse family improves raw log loss3.1923→3.1543 (about1.2%). The already-reached×clock extension improves it to3.0643 (about4.0%); raw mean Brier per hold changes0.053278→0.052231. Three dates improve; Sep15 worsens (raw log loss3.0184→3.0462; calibrated3.1625→3.3367). This does not establish a uniform improvement.

Union live arrival/clearance pulses are approximately flat and their joint extension worsens. Completed120 notification pulses show a small improvement (raw3.3729→3.3479), but delayed evidence cannot identify an immediate arrival-based release rule. The persistent clock-interaction extension is approximately flat with fast proxies and worse with delayed ones.

These are four date blocks and dependent holds/buses, not thousands of independent trials just because the hazard has many15s bins. The primary score sums sequential log losses per hold. Per-hold Brier is a descriptive secondary summary; pooled risk-bin Brier and date-specific scores are also saved. Neither provides a measured improvement in pickup timing, missed rides, or full-path ETA stability.

## Event timing and negative controls

The CSV reports **all29 route stops**, both source regulators, training/calibration/development, arrival/clearance events, and both latency regimes. Each event window reports risk exposure, hold/date support, departures and the baseline hazard's expected count. The before-event panel intentionally looks at events that become known in the next120s; it is a descriptive timing control and never enters a predictive feature. Ratios are not causal effect estimates or independent significance tests.

Examples ranked by the training arrival association (at least5 observed departures and2 dates), with every stop still included in the predictive family:

| Focal regulator; predecessor arrival | Training after: observed/expected | Development after | Development before-event control |
|---|---:|---:|---:|
| Winchester; College / George | 12/6.15 (1.95×) | 11/4.83 (2.28×) | 11/5.66 (1.94×) |
| Winchester; College / Crown | 11/7.02 (1.57×) | 12/5.69 (2.11×) | 9/5.63 (1.60×) |
| Union; 130 Prospect Street (N) | 6/3.31 (1.81×) | 5/5.37 (0.93×) | 10/7.14 (1.40×) |
| Union; 344 Winchester | 14/10.29 (1.36×) | 8/5.69 (1.41×) | 7/5.05 (1.39×) |

College/George and College/Crown show Winchester associations after arrival, but development departures are also elevated before those notifications. Union's training-ranked Prospect association fails to persist after arrival. These patterns are compatible with shared operating cycles, correlated route progress or anticipation of a nearby predecessor. They do not prove an exact trigger; the timing proxies prevent treating a lead-window result as definitive disproof either.

## Decision and next useful work

**Keep predecessor progress×clock as a Winchester research candidate. Do not hardcode a stop-trigger rule or add it to the frozen production candidate from these results.** First verify predecessor identity and exact live stop-notification times against continuous GPS, including overtakes and missing/ambiguous buses. Then a prospective shadow can evaluate the already specified feature family on new dates. A full ETA implementation must forecast future predecessor movement and handle stale/missing evidence, rather than condition on its actual future path.

The same-stop encounter/co-presence hypothesis is being studied separately by the parent agent; it is not represented here. Neither these additive/pulse/barrier families nor the earlier hour/headway tests exhaust operational interactions, different landmarks, driver service blocks or alternative fleet-order definitions. Weak tests rule out neither an operational rule nor a better model of it.

Artifacts: `ahead-trigger-plan.json`, `ahead-trigger-screen.py/.json/.log`, `ahead-trigger-barrier-plan.json`, `ahead-trigger-barrier.py/.json/.log`, and `ahead-trigger-event-study.csv`. Database access was read-only and all input/plan hashes are preserved.
