# Following-shuttle progress: historical screen

**Result:** follower progress adds little at Winchester once predecessor progress is included. At Union, the two clock-interaction families improve raw departure log loss about 1.0–1.2% over lap/clock alone and 1.2–1.4% after including the predecessor. Both follower identity definitions support a small Union signal. This is not a measured ETA improvement, and no coefficients are deployed.

The gain is score-dependent: after the predecessor model, Union mean per-hold Brier is 0.075169 at baseline, 0.075373 with follower progress×clock and 0.075227 with follower reached×clock (slightly worse). The log-loss gain should not be described as a general probability-calibration improvement.

The Union signal is stronger when follower and predecessor are different buses: incremental log-loss gains are about 3.2–3.7% across 60 holds. They improve separately on all three dates where this group appears. However, group membership is strongly tied to the date: September 15 has 21 same-bus cases, zero distinct-follower cases and two unknowns. This is suggestive of an operating-regime interaction, not evidence for a causal fleet-size or driver-dispatch rule.

This tests the following bus’s stop progress explicitly. Earlier work only screened approximate ahead/behind spacing jointly. This analysis is exploratory and does not modify production or supply realized future bus movement to an ETA.

## Design

The baseline is the existing elapsed-wait / own-lap / 15-minute-clock departure hazard. Additional follower features fit before September 10; September 10–11 provides a separate intercept calibration; September 14–17 through 13:14 ET supplies previously inspected development outcomes. All 99 Winchester and 103 Union development holds stay in each comparison. The later afternoon replay is excluded. Risk bins are 15 seconds and share visits, buses and four dates.

Two follower identities are fixed at the focal bus’s pin: (1) the first already-confirmed different-bus departure after the focal bus’s previous departure from this regulator, with same-day and intervening-stop guards; (2) the nearest backward stop-index position among fresh already-observed other buses. The second is sparse topological order, not metric GPS spacing. Same-stop/tied order yields unknown. The first can coincide with the predecessor in a two-bus loop or after changed ordering. Unknown identities retain the baseline in the raw arm; an arm-specific calibration intercept can also change unknown cases.

Progress, arrival pulses, persistent reached-stop flags, and their interactions with clock phase use only events known at the risk-bin start. Arrival+15s and completion+120s are availability proxies. Additional effects are regularized with L2=10, with stop features supported by at least five training holds on two dates. A separate comparison adds follower effects on top of the fixed, training-only predecessor reached×clock model, checking whether the information is additional. Exact reproduction of that prior model’s raw scores is asserted.

## Identity support

| Identity | Stop | Known / all development holds | Same bus as predecessor | Unknown reasons |
|---|---|---:|---:|---|
| departure_order | 11 | 87 / 99 | 28 | {"no prior own confirmed source departure": 11, "no observed intervening opposite stop": 1} |
| departure_order | 121 | 92 / 103 | 32 | {"no prior own confirmed source departure": 11} |
| stop_order | 11 | 95 / 99 | 28 | {"no fresh other-bus stop anchor": 3, "same-stop ordering ambiguous": 1} |
| stop_order | 121 | 100 / 103 | 36 | {"no fresh other-bus stop anchor": 3} |

## Every tested family

Mean sequential negative log loss per hold; lower is better. Values are raw, followed by the separately intercept-calibrated value in parentheses. The calibrated result is not a coverage guarantee. “With ahead” includes the already-tested predecessor reached×clock feature before fitting the follower addition.

### departure_order; arrival15_clear30_proxy

| Follower family | Winchester | Winchester with ahead | Union | Union with ahead |
|---|---:|---:|---:|---:|
| baseline | 3.1923 (3.3244) | 3.0649 (3.2609) | 3.3729 (3.3737) | 3.3585 (3.3615) |
| identity_controls | 3.1897 (3.3195) | 3.0611 (3.2562) | 3.3694 (3.3696) | 3.3523 (3.3553) |
| progress | 3.1880 (3.3095) | 3.0597 (3.2467) | 3.3740 (3.3763) | 3.3540 (3.3587) |
| progress_clock | 3.1738 (3.3004) | 3.0616 (3.2489) | 3.3379 (3.3472) | 3.3172 (3.3250) |
| arrival_pulses | 3.1954 (3.3215) | 3.0661 (3.2607) | 3.3693 (3.3703) | 3.3537 (3.3570) |
| reached | 3.1963 (3.3039) | 3.0683 (3.2456) | 3.3619 (3.3688) | 3.3437 (3.3511) |
| reached_clock | 3.1767 (3.2970) | 3.0703 (3.2529) | 3.3318 (3.3467) | 3.3130 (3.3252) |

### departure_order; completed120

| Follower family | Winchester | Winchester with ahead | Union | Union with ahead |
|---|---:|---:|---:|---:|
| baseline | 3.1923 (3.3244) | 3.0607 (3.2568) | 3.3729 (3.3737) | 3.3914 (3.3929) |
| identity_controls | 3.1897 (3.3195) | 3.0574 (3.2528) | 3.3694 (3.3696) | 3.3857 (3.3871) |
| progress | 3.1841 (3.3115) | 3.0530 (3.2479) | 3.3768 (3.3804) | 3.3900 (3.3934) |
| progress_clock | 3.1736 (3.3038) | 3.0576 (3.2494) | 3.3359 (3.3467) | 3.3531 (3.3602) |
| arrival_pulses | 3.1891 (3.3220) | 3.0514 (3.2531) | 3.3835 (3.3855) | 3.3973 (3.3997) |
| reached | 3.1829 (3.2907) | 3.0482 (3.2299) | 3.3787 (3.3851) | 3.3889 (3.3938) |
| reached_clock | 3.1580 (3.2798) | 3.0498 (3.2398) | 3.3390 (3.3555) | 3.3543 (3.3648) |

### stop_order; arrival15_clear30_proxy

| Follower family | Winchester | Winchester with ahead | Union | Union with ahead |
|---|---:|---:|---:|---:|
| baseline | 3.1923 (3.3244) | 3.0649 (3.2609) | 3.3729 (3.3737) | 3.3585 (3.3615) |
| identity_controls | 3.1904 (3.3213) | 3.0611 (3.2574) | 3.3647 (3.3694) | 3.3517 (3.3558) |
| progress | 3.1852 (3.3131) | 3.0553 (3.2459) | 3.3707 (3.3762) | 3.3549 (3.3610) |
| progress_clock | 3.1715 (3.3088) | 3.0620 (3.2564) | 3.3323 (3.3417) | 3.3242 (3.3317) |
| arrival_pulses | 3.2008 (3.3285) | 3.0652 (3.2623) | 3.3581 (3.3624) | 3.3494 (3.3526) |
| reached | 3.1936 (3.3153) | 3.0616 (3.2478) | 3.3588 (3.3666) | 3.3451 (3.3522) |
| reached_clock | 3.1672 (3.3069) | 3.0597 (3.2580) | 3.3297 (3.3467) | 3.3185 (3.3309) |

### stop_order; completed120

| Follower family | Winchester | Winchester with ahead | Union | Union with ahead |
|---|---:|---:|---:|---:|
| baseline | 3.1923 (3.3244) | 3.0607 (3.2568) | 3.3729 (3.3737) | 3.3914 (3.3929) |
| identity_controls | 3.1904 (3.3213) | 3.0569 (3.2534) | 3.3647 (3.3694) | 3.3842 (3.3866) |
| progress | 3.1845 (3.3145) | 3.0504 (3.2457) | 3.3664 (3.3727) | 3.3861 (3.3905) |
| progress_clock | 3.1667 (3.3040) | 3.0544 (3.2494) | 3.3260 (3.3362) | 3.3540 (3.3602) |
| arrival_pulses | 3.1896 (3.3214) | 3.0482 (3.2486) | 3.3770 (3.3815) | 3.3971 (3.3989) |
| reached | 3.1826 (3.2995) | 3.0446 (3.2316) | 3.3810 (3.3873) | 3.3972 (3.4003) |
| reached_clock | 3.1497 (3.2845) | 3.0414 (3.2413) | 3.3337 (3.3488) | 3.3588 (3.3661) |

## Date and identity-overlap checks

The two clock-interaction families are shown separately; no best stop or best day is selected. Relative improvement compares raw loss to the corresponding baseline for that same group, including the ahead effect where specified. Negative improvement means worse.

| Identity | Stop | Baseline | Follower family | All gain | Date gains (Sep 14 / 15 / 16 / 17) | Distinct-follower gain | Same-as-ahead gain |
|---|---|---|---|---:|---|---:|---:|
| departure_order | 11 | lap_clock | progress_clock | +0.6% (n=99) | +0.1% (n=28) / +0.6% (n=21) / +0.6% (n=33) / +1.2% (n=17) | +0.7% (n=59) | +0.6% (n=28) |
| departure_order | 11 | lap_clock | reached_clock | +0.5% (n=99) | +0.2% (n=28) / +0.3% (n=21) / +1.4% (n=33) / -0.5% (n=17) | +0.6% (n=59) | +0.5% (n=28) |
| departure_order | 11 | lap_clock_ahead | progress_clock | +0.1% (n=99) | +0.4% (n=28) / -0.3% (n=21) / -0.2% (n=33) / +0.5% (n=17) | +0.2% (n=59) | +0.0% (n=28) |
| departure_order | 11 | lap_clock_ahead | reached_clock | -0.2% (n=99) | +0.6% (n=28) / -0.5% (n=21) / -0.4% (n=33) / -0.7% (n=17) | -0.2% (n=59) | -0.2% (n=28) |
| departure_order | 121 | lap_clock | progress_clock | +1.0% (n=103) | +2.6% (n=29) / -2.9% (n=23) / +1.4% (n=33) / +2.5% (n=18) | +2.7% (n=60) | -1.6% (n=32) |
| departure_order | 121 | lap_clock | reached_clock | +1.2% (n=103) | +2.4% (n=29) / -3.6% (n=23) / +1.3% (n=33) / +5.0% (n=18) | +3.2% (n=60) | -2.0% (n=32) |
| departure_order | 121 | lap_clock_ahead | progress_clock | +1.2% (n=103) | +3.1% (n=29) / -3.9% (n=23) / +2.4% (n=33) / +2.1% (n=18) | +3.2% (n=60) | -1.8% (n=32) |
| departure_order | 121 | lap_clock_ahead | reached_clock | +1.4% (n=103) | +3.1% (n=29) / -4.6% (n=23) / +2.3% (n=33) / +4.0% (n=18) | +3.7% (n=60) | -2.3% (n=32) |
| stop_order | 11 | lap_clock | progress_clock | +0.7% (n=99) | +0.6% (n=28) / +0.4% (n=21) / +0.7% (n=33) / +1.1% (n=17) | +0.7% (n=67) | +0.6% (n=28) |
| stop_order | 11 | lap_clock | reached_clock | +0.8% (n=99) | +0.4% (n=28) / +1.2% (n=21) / +1.5% (n=33) / -0.3% (n=17) | +0.7% (n=67) | +1.0% (n=28) |
| stop_order | 11 | lap_clock_ahead | progress_clock | +0.1% (n=99) | +0.8% (n=28) / -0.8% (n=21) / -0.1% (n=33) / +0.3% (n=17) | +0.2% (n=67) | -0.2% (n=28) |
| stop_order | 11 | lap_clock_ahead | reached_clock | +0.2% (n=99) | +0.8% (n=28) / -0.1% (n=21) / -0.1% (n=33) / -0.1% (n=17) | +0.2% (n=67) | +0.2% (n=28) |
| stop_order | 121 | lap_clock | progress_clock | +1.2% (n=103) | +1.8% (n=29) / -0.4% (n=23) / +0.6% (n=33) / +3.3% (n=18) | +1.6% (n=64) | +0.6% (n=36) |
| stop_order | 121 | lap_clock | reached_clock | +1.3% (n=103) | +1.4% (n=29) / -0.9% (n=23) / +1.4% (n=33) / +3.7% (n=18) | +2.5% (n=64) | -0.6% (n=36) |
| stop_order | 121 | lap_clock_ahead | progress_clock | +1.0% (n=103) | +2.1% (n=29) / -2.4% (n=23) / +1.4% (n=33) / +2.8% (n=18) | +1.9% (n=64) | -0.3% (n=36) |
| stop_order | 121 | lap_clock_ahead | reached_clock | +1.2% (n=103) | +1.8% (n=29) / -2.5% (n=23) / +2.0% (n=33) / +3.1% (n=18) | +2.7% (n=64) | -1.3% (n=36) |

## Limits and reproducibility

These scores measure one-step departure prediction, not remaining-wait or rider-arrival accuracy. Integrating this time-varying hazard into an ETA needs a causal forecast of future follower progress, including uncertainty and missing/stale observations. Another option is a separately trained remaining-time distribution conditioned directly on the follower’s currently observed state. Neither approach may use the observed future follower trajectory as a forecast input. No production change is justified by a lucky family or a few development dates alone.

The independently audited short and long focal holds remain. No new residual/outlier exclusions are made. Sparse stop evidence, timestamp proxies and changing fleet order limit interpretation; predictive association does not establish that drivers wait for a following bus. Separate raw and calibrated scores, both identity definitions, both timing contracts and all seven families are retained.

Run `OPENBLAS_NUM_THREADS=1 python red-window-data/follower-progress-screen.py`, then `python red-window-data/follower-progress-report.py`. The frozen plan, input hashes, coefficients, per-visit scores and selection reasons are in `follower-progress-plan.json` and `follower-progress-screen.json`. The independent identity and route-reassignment audits are saved alongside them. Input SQLite is read-only.

## September 15 regression inspection

The six largest Union per-hold log-loss regressions in the departure-order reached×clock arm after the predecessor offset are visits 51469, 54002, 52633, 52168, 54777 and 53429. All identify the same other bus as both predecessor and follower. Their recorded waits are 550, 30, 410, 510, 470 and 505 seconds: the problem is not confined to extreme durations. Each has a completed non-gap stopped visit and recorded rest evidence. No positive measurement-error evidence justifies removing them; they remain in every score. This is a completed-event inspection, not a new raw-GPS verification. Details are preserved in `follower-sep15-regressions.json`.

The independent identity audit checks selected follower assignments against latest known anchors from every route: zero reassignment contradictions were found at pin or through the corresponding holds. The independently guarded Winchester count differs by one because the screen accepts an already-observed opposite-stop anchor while the conservative audit also examines completed opposite-stop evidence.
