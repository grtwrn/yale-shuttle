# Wait-relative K, departure switching, and other pickup stops

**The user's cutoff concern is real in this replay. K=5 and K=10 avoid the arbitrary change of averaging origin when a moving ten-stop boundary crosses the wait. Switching to the current estimator after leaving the wait is also useful: it makes that later historical cutoff irrelevant.** K is therefore worth assessing as a rule across pickup stops, not solely by Division's aggregate point error.

K counts backward from the usual major wait preceding the pickup. In Red's downstream section, that wait is344 Winchester. K=5 starts at Whitney/Audubon; K=10 starts at Chapel/Church. These remain fixed as the bus moves or the pickup changes within this section. This differs from both ten stops behind the bus and ten stops before the pickup. The latter changes its origin when the rider changes pickup.

The extension covers14 Red pickup stops from Winchester/Division through Amistad/Church Street South. It does not test a full loop, a different preceding major wait, or other routes.

The moving-boundary result is particularly clear. On **567 matched forecast transitions**, with all three historical methods available on the same records, the moving-ten estimate has149 upward and90 downward absolute-arrival jumps over one minute. K=5 and K=10 have zero. These represent150 bus/time events across315 physical pickup visits; several targets share the same event, so567 is not a count of independent bus trips.

For example, on September18 at07:42:30, #306 was moving from College/Crown toward College/George. Its moving-ten origin shifted from Canal to344. The Gilbert/Cedar prediction changed from1:00 remaining to7:51 while30 seconds passed: a **7:20 backward move of the predicted arrival**, with actual arrival only1:51 away. K=10 counted down from2:39 to2:09. Raw observations show continuous southbound progress at that moment, and the downstream visits confirm the arrival. This is the unwanted cutoff effect the user described.

Changing pickup can cause a separate problem with **ten stops before pickup**. Moving the pickup from College/Crown to College/George shifts its origin from Canal to344. In one retained case, those actual arrivals were35 seconds apart, but the two predictions were8:31 apart. Across the boundary pairs, that method also frequently changes whether a historical estimate is available at all. K=5/K=10 have no such support transitions in this replay. The full dense audit contains50,054 adjacent-pickup comparisons; those are correlated synthetic forecast records, not50,054 independent rides. Only14 boundary comparisons across four physical adjacent-visit pairs have actual production forecasts at both targets, so the logged evidence alone is small.

The departure switch had already activated before **all567 common moving-boundary transitions**. It would therefore use production rather than the historical estimate at that cutoff. No production forecasts were logged at both times of those moving-boundary events, so this is proof of which calculation would be selected, not a measured claim that the production estimate never jumps there. The initial completed-visit-only gate also misses a few visible pass-throughs. A disclosed sensitivity permits the causal current drive from344 or a downstream phase to confirm exit; it does not switch just because the nearest-stop index moves while the bus is still holding at344.

For the original **36 Division/Prospect pickup visits and1,655 logged forecasts**, the results are:

| Method | Average point error | Average window | Inside window |
|---|---:|---:|---:|
| Current production | 1:56 | 10:04 | 93.8% |
| K=5, no switch | 2:11 | 7:18 | 86.3% |
| K=5, observed-exit switch | 2:08 | 7:32 | 84.9% |
| K=10, no switch | 2:14 | 6:09 | 83.3% |
| K=10, observed-exit switch | 2:11 | 6:26 | 82.4% |
| Moving ten, no switch | 1:53 | 6:23 | 84.3% |
| Moving ten, observed-exit switch | 1:50 | 6:39 | 83.1% |

All times are minutes:seconds. These use nominal80% padding fitted on September16, including unchanged production fallback. The moving-ten hybrid's nominal90% version gives1:50 point error, a7:05 window and87.3% coverage. K=5/K=10 require no additional90% padding on that calibration sample, but their later coverage remains below90%; calibration is not a guarantee. The strict completed-visit switch and long-Canal sensitivity remain in the numerical results, rather than being replaced silently by the observed-exit rule.

The switch does what it is meant to do near pickup: after the bus is observed beyond Winchester, all observed-exit hybrids exactly match production's19-second average point error on the original post-Winchester subset. It does **not** fix a countdown that expires while the bus remains at the wait. K=5 still produces at least one15-seconds-or-less estimate while arrival is over two minutes away on14 of36 visits; K=10 and moving-ten hybrids do so on9 each. All these false-now snapshots occur before their switch. This is a separate residual-time problem.

The other **12 added pickup stops** contribute347 logged forecasts across49 target visits. Many share the same bus trips, and most destinations have only3–6 logged visits, mostly on September18. Their pooled, target-visit-balanced comparison is encouraging, but not a broad independent validation:

| Method, with observed-exit switch | Average point error | Average window | Inside window |
|---|---:|---:|---:|
| Current production | 1:47 | 10:39 | 96.4% |
| K=5 | 1:23 | 8:23 | 95.6% |
| K=10 | 1:25 | 7:06 | 91.5% |
| Moving ten | 1:24 | 6:52 | 93.2% |
| Ten before pickup | 1:48 | 9:23 | 92.3% |

Here K=10 keeps almost the same point accuracy as K=5 while saving another1:17 of window width. Moving-ten plus the switch remains competitive on the measured averages. The data support K's consistent origin; they do not establish that K wins every accuracy or interval metric. See the [per-pickup table](published/per-pickup-comparison.md) for every destination's sample size and error/window comparison, and the [numerical results](published/multistop-findings.json) for coverage and support.

The study retains eight earlier training dates, September16 calibration, and September17/18/21 evaluation. Those dates have been reused for research. The original source/outcome cohort is unchanged; the downstream extension matches its own forward visits using the same endpoint and raw-continuity rules. It generated103,128 candidate origins and matched97,789 outcomes;456 origins were already past their recorded target arrival and4,883 had no unambiguous source/outcome match. These are not independent rides. The inherited45-minute source-to-target limit also censors some long paths and limits conclusions about distant pickups. No test-day outcome is used to select the averaging origin or trigger the switch.

The downstream nominal80/90% padding is pooled across its targets, so destination-specific fitted padding does not introduce another discontinuity. Only actual logged forecasts serve as production comparisons. Missing production forecasts after a switch remain missing, and dense historical-only diagnostics are reported separately. The original Division hybrid also passes the15-second input-delay and prior-day-history sensitivities; its K=5/K=10 errors remain around2:08–2:12 and widths around6:26–7:35. The destination extension itself is a frozen-history boundary audit, not an additional daily-refresh study.

All28 unit checks, causal prefix replay on all four dates in both scopes, future-history deletion, and exact-production-after-switch invariants passed. The original four numerical result files are byte-identical to the prior experiment, and all earlier strict-hybrid arms retain their values. All31 artifact hashes were verified. The initial larger export exceeded Node's single-string limit before destination scoring; bounded export and compact unused fields fixed that without dropping cases. Replay and statistical calculations ran on hosted CI.

**Conclusion:** K=10 is a useful fixed-anchor candidate for the narrower-window tradeoff the user wants. Its anchor should stay tied to the relevant wait, and a departure/progress switch can return control to the current estimator afterward. The experiments substantiate that structure and the cutoff problem. Overdue countdowns before departure, sparse cross-destination logs, and generalization beyond this Red section remain limits. Production is unchanged.

[Successful hosted run](https://github.com/grtwrn/yale-shuttle/actions/runs/35642308886), [hybrid results and cases](published/hybrid-findings.json), [destination and common-crossing audit](published/multistop-findings.json), [artifact hashes](published/hybrid-multistop-run.json), [hybrid plan](HYBRID-PLAN.md), and [destination plan](MULTISTOP-PLAN.md) preserve the work. Run the workflow at commit `b4e17bb9c36551450421dab166f45a75b4593f39` to reproduce it; the workflow explicitly runs the original replay and then `REPLAY_SCOPE=downstream` before `multistop.py`.
