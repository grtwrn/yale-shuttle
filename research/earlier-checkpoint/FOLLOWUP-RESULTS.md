# Ten stops back and K stops before the wait stop

**Ten stops behind the bus is the most promising of these alternatives for narrower windows.** Its average window is 3:41 narrower than production's, with essentially unchanged average point error. A modestly padded version retains a 3:12 reduction while covering 88.7% of observed arrivals. The K=1 and K=2 alternatives do less well. These results support continuing with the ten-stop idea, while its overdue countdowns and poor response to fast approaches still need attention.

The user explicitly values reducing window width even at a modest point-error cost. That is a valid tradeoff; point error alone is not the decision criterion. The table includes actual coverage so the cost of a tighter window is visible.

Same comparison as before: **1,655 forecast origins across 36 Division/Prospect pickup visits on September17,18,21**, with equal total weight per pickup visit. Historical means use eight earlier dates; September16 alone determines interval padding. These research dates have been reused, so this is exploratory evidence, not a new holdout or live trial. All rows below include exact production fallback when the requested earlier checkpoint has not yet been observed.

| Method | Average point error | Average window | Arrival inside window |
|---|---:|---:|---:|
| Current production | 1:56 | 10:04 | 93.8% |
| Five stops behind bus, earlier test | 2:14 | 6:56 | 84.4% |
| **Ten stops behind bus** | **1:53** | **6:23** | **84.3%** |
| **Ten stops behind bus, nominal90% padding** | **1:53** | **6:52** | **88.7%** |
| Ten stops before pickup | 2:06 | 6:44 | 83.3% |
| K=1: depart Canal/Munson | 2:16 | 9:26 | 83.9% |
| K=1: arrive Canal/Munson | 2:18 | 8:37 | 78.8% |
| K=2: depart Winchester/Sachem | 2:18 | 8:16 | 79.0% |
| K=2: arrive Winchester/Sachem | 2:19 | 8:15 | 81.3% |

Times are minutes:seconds. Except the explicitly padded row, candidates use the same nominal80% calibration rule as the initial experiment. Nominal coverage is a fitting target, not a guarantee. The ten-stop nominal90% variant adds 20 seconds on each side of supported intervals, clipping the lower bound at zero; fallback forecasts remain unchanged.

**Definitions matter.** The user's K counts backward from the usual significant wait stop before pickup, 344 Winchester. K=1 is Canal/Munson, K=2 Winchester/Sachem. Departure-based K=2 exactly reproduces the initial five-stops-before-pickup result. Ten stops before Division is Wall/Church; ten stops behind the moving bus changes its checkpoint with the bus's detector anchor. At 344 Winchester, that checkpoint is Chapel/Church. Earlier-lap wrapping is not used; missing causal observations fall back to production.

The ten-stop model had its own supported estimate for 91.7% of paired snapshots. Canal-departure K=1 had one for only 48.5%: while the bus is waiting at Canal, its departure is still unknown. Canal-arrival K=1 increases support to60%, but the supported forecasts have worse mean error than production on those exact snapshots (2:18 versus1:42). Starting at Canal's departure also excludes any Canal wait already taken, so it cannot directly learn that a long Canal hold may replace part of Winchester's hold. All K=1/K=2 variants still suffer from only three long-Canal complete paths in training.

The ten-stop tradeoff survives several checks:

- The interval score, which balances width, point error and missed bounds, improves from81.11 to71.71. Its descriptive paired-journey90% bootstrap interval for the difference is −18.03 to−0.82. Point-error change is only−3.28 seconds, with interval−21.03 to+11.45; it is not evidence of reliably better point accuracy. Three dates and repeated model exploration limit both intervals.
- By date, point errors are 2:15 versus2:11 on September17, 1:31 versus1:14 on September18, and1:46 versus2:15 on September21. Width falls on all three dates. Interval score improves on17/21 and is essentially unchanged, slightly worse, on18.
- With history refreshed through midnight before each evaluation date, ten-stop error is1:51 and width6:26, against production's1:56 and10:04. Delaying observations by15 seconds gives1:53 and6:23. Restricting to strict connected labels gives1:47 and6:17, against production's1:51 and9:57.
- On the29 visits with a recorded stop, point error is effectively tied (116.67 versus116.25 seconds), with window width6:32 versus10:28. This supports a width benefit without claiming a point-accuracy gain for boarding visits.

There are still concrete failures. Ten-stop estimates say15 seconds or less while arrival remains over two minutes away on **10 of36 visits**, down from14 for the earlier five-stop version but above production's zero. Widening the interval does not fix the point countdown. On the reported noon #309 case at12:32, it says zero while Division remains2:24 away, though its interval still contains that arrival. The simple mean-minus-elapsed clock has expired.

Once the bus is past Winchester, production's mean point error is19 seconds versus59 seconds for ten stops back. On September17 at17:55:30, the bus was44 seconds from Division; ten stops back predicted7:53 and production32 seconds. The continuous raw track confirms this is a real fast approach. At the other extreme, the largest ten-stop upper-bound miss is2:38 on September18 #306. These outcomes remain in the scores.

For the nominal80% ten-stop variant, arrival is before the lower bound on2.84% of visit-balanced snapshots versus1.94% for production, and after the upper bound on12.87% versus4.26%. One stopped pickup has a lower bound beyond its recorded departure under either method, with worse maximum excess for ten stops back (154 versus122 seconds). These are GPS timing diagnostics, not observed passenger misses. On1,609 common adjacent origins, ten stops back has18 upward and23 downward arrival-time jumps over a minute, versus11 and31 currently. It is not uniformly smoother.

A separate control simply contracts production's existing bounds, using only September16 calibration. It does not generalize well: nominal80% yields a6:46 window with67.0% actual coverage; nominal90% yields8:17 with78.9%. Only nine logged pickup visits supported that calibration, versus63 candidate calibration visits. This narrow control does not establish that every way of tightening production is inferior; it shows that the measured ten-stop benefit is not reproduced by this particular uniform contraction.

All14 mathematical and causal unit tests, four-date prefix replay, input hashes, future-history deletion, and the daily-history deletion checks passed. Expanded checkpoint features did not alter the original outcome cohort. The three original numerical result files are byte-identical to the prior run, and K=2 predictions reproduce the prior model exactly. Raw continuity checks confirm the largest ten-stop and K=1 regressions. The full replay and calculations ran on hosted CI, not the Pi.

**Research conclusion:** prefer the ten-stops-behind-bus direction over these wait-relative anchors for further work. The nominal90% version offers a particularly useful measured width/coverage tradeoff. Treat the three-second point-error gain as a tie, and address overdue countdowns and final-approach responsiveness before treating the whole estimator as a finished replacement. No production changes or deployment were made.

[Hosted test run](https://github.com/grtwrn/yale-shuttle/actions/runs/35637541951), [numerical results and cases](published/followup-findings.json), [verified artifact hashes](published/followup-run.json), and [pre-score follow-up plan](FOLLOWUP-PLAN.md) preserve the experiment. To reproduce it, run the original report's commands, include `test_followup.py` in the unit test command, and then run `python3 research/earlier-checkpoint/followup.py`.
