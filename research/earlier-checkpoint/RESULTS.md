# Earlier-checkpoint ETA experiment — September 21, 2026

**Follow-up:** the user requested ten-stop and wait-relative anchors after these results. [The additional experiment](FOLLOWUP-RESULTS.md) finds a more promising width/accuracy tradeoff for ten stops behind the bus. The original results below remain unchanged.

**Latest:** [Wait-relative K, departure switching, and other pickups](HYBRID-MULTISTOP-RESULTS.md) confirms the cutoff concern and compares K=5/K=10 across Red's downstream section.

**The earlier-checkpoint idea narrows Red's arrival windows, but the tested versions do not earn a production replacement.** The simple average is less accurate and can count down to zero while the bus remains several minutes away. Conditioning on unfinished journeys helps with that failure, but its aggregate point error is still slightly worse than production, with inconsistent results across dates. Matching the current phase introduces sparse-history fallbacks and additional jumps.

All work is offline. Application code, model parameters, deployed service and watcher behavior are unchanged. The hosted calculations and checks passed; the candidate performance criteria did not. [Hosted evaluation](https://github.com/grtwrn/yale-shuttle/actions/runs/35635235179), [compact numerical results](published/findings.json), [four vehicle-case traces](published/case-audits.json), [frozen plan](PLAN.json), and [amendment trail](AMENDMENTS.md) preserve the evidence.

The main comparison contains **1,655 matched forecast origins across 36 Division/Prospect pickup visits**: 14 on September 17, 10 on September 18, and 12 on September 21. Each pickup visit has equal total weight, so a long wait with many snapshots does not count as dozens of independent trips. The means below include exact production fallback when a candidate lacks a confirmed origin or adequate history. “Inside window” is the visit-balanced share of forecast snapshots whose later GPS-derived arrival fell within the interval.

| Method | Average absolute point error | Average window width | Inside window |
|---|---:|---:|---:|
| Logged production | 1:56 | 10:04 | 93.8% |
| Earlier fixed-checkpoint mean, minus elapsed time | 2:11 | 7:18 | 86.3% |
| Mean from five stops behind the bus | 2:14 | 6:56 | 84.4% |
| Mean from five stops before pickup | 2:18 | 8:16 | 79.0% |
| Earlier checkpoint, conditioned on not yet arriving | 2:00 | 7:29 | 84.5% |
| Earlier checkpoint plus current progress/history | 2:02 | 7:29 | 79.4% |
| Five-before-pickup checkpoint plus current progress | 2:02 | 8:26 | 83.8% |
| Historical remaining journey from current stage | 2:08 | 7:28 | 78.8% |

Times are minutes:seconds. Historical intervals begin as p10–p90, then receive only the padding determined on September 16. Production is more conservative than a nominal 80% interval on this sample; reducing its observed coverage from 94% toward 80% is **not by itself proof of a bad model**. The decision also uses point error, interval score, early-bound severity, departure margins, availability and stability. The earlier-mean interval score is essentially unchanged (81.69 versus 81.11; lower is better). The survival and progress variants improve that score modestly (77.89 and 78.21), but their all-target paired journey-bootstrap intervals for the score difference include zero, and the gains reverse on September 18. Three evaluation dates are too few for strong day-level uncertainty claims.

The main failure is visible without aggregate statistics. On September 21 at **12:27**, #309 was still at Canal/Munson. The fixed earlier mean predicted **3:59 remaining**; production predicted **7:24**, and the recorded Division arrival was **7:24 later**. At 12:31 the earlier mean reached zero, while the bus still needed **3:24**. Across the 36 pickup visits, the fixed mean produced at least one estimate of 15 seconds or less while actual arrival remained over two minutes away on **14 visits**. Production did so on zero visits in that paired sample. A countdown from a fixed average cannot recover when the whole stretch takes longer than average.

The opposite failure also occurs. On September 17 at 17:55:30, #309 was 44 seconds from Division. Production predicted 32 seconds; the earlier mean predicted approximately 7½ minutes. The raw track is continuous, so this is not a different lap or a deleted outcome. The earlier average does not respond enough when the bus has already cleared the waiting section unusually quickly. Excluding the closing-hour cases is an explicitly exploratory sensitivity, not a reason to discard them; the simple mean still has worse point error before 17:00 (122.87 versus 116.27 seconds).

The Canal/Winchester observation remains useful. It establishes why those waits should be studied together, but comparable complete history is thin: the main earlier anchor has **168 training paths over eight dates, only two with a Canal wait of at least five minutes**. The nearer anchor has 172 paths, only three with such a wait. The progress-matched method therefore falls back during the long noon Canal wait. Relaxing the support requirement after seeing this example would invent confidence rather than validate it.

Testing used completed journeys from September 3–15, with September 16 reserved for interval calibration. The fixed earlier anchor is Whitney/Audubon, before both Canal and Winchester. Winchester/Sachem is the five-stops-before-Division alternative. The trailing-five version uses the actual detector anchor, with an earlier boundary when necessary to cover the waiting section. Empirical forecasts share clock-time weighting; the progress variant additionally matches elapsed approach time and a causally known completed Canal duration. It is a separate richer model, not merely a different average.

Current states were reconstructed using the production detector and departure reducers, with ten minutes of warmup and resets after observation gaps over a minute. An origin departure becomes available only when the reducer actually emits it. Finalized evaluation stop records never enter predictor features. Historical paths use exact connected stop/leg endpoints, or the declared raw-GPS continuity check where fragmented records can be repaired. Repeated Winchester encounters remain part of the elapsed journey. Training raw GPS was added uniformly as an input-quality sensitivity; it recovered additional paths but did not supply enough rare long-Canal examples to change the support conclusion.

The checks covered:

- Seven mathematical and causal tests, including subtracting elapsed time before zero-clipping, unfinished-journey conditioning, sparse-history fallback and rejection of future departure events.
- Prefix replay on all four reconstructed dates: removing later GPS observations leaves earlier features identical. Removing future completed journeys likewise leaves eligible predictions identical.
- Every available input hash, finite ordered forecasts, first-target matching, explicit unmatched/censored counts, raw track continuity and route geometry equality against the earlier capture.
- An extra 15 seconds of input delay, strict-label-only comparisons, and subsets with raw gaps no longer than 15 or 30 seconds. The broad decision survives these checks.
- Raw review of the large September 17/18 fast-pass regressions and both September 21 #309 examples. No valid short or long outcome was removed based on error.
- Stability on exactly the same adjacent logged origins. The fixed mean is smoother, but the progress variant has 49 upward and 75 downward absolute-arrival jumps over one minute, versus production's 11 and 31. A stable but overdue countdown is not sufficient improvement.
- A freshness sensitivity using completed history through midnight before each evaluation day. The same algorithms and calibration are retained. Division point error remains worse overall: 131.33 seconds for the fixed mean and 133.63 for the trailing-five mean, against 116.46 for production. The richer variants remain around 119–120 seconds. This is a sensitivity on reused dates, not a new holdout.

For the 29 pickup visits with a recorded stop, the simple mean has one visit where its lower bound extends beyond the recorded departure; production also has one, with different severity. The progress variant has three such visits. These are GPS timing diagnostics, not observed passenger misses or guarantees about doors. Actual early-tail cases remain scored, including the closing-time visit already difficult for production.

Across both pickup targets, the replay generated 11,605 candidate origins and matched outcomes for 11,039. Fifty origins were already past their target arrival; 516 lacked an unambiguous source/outcome match. These are missing-data limits, not removed forecast errors. The secondary 130 Prospect Street result has only four logged target visits and is not an independent replication of the Division result. Logged production is what the app actually issued on each date, including its contemporary fit/version; this is not a constant-coefficient replay of today's production against every earlier day.

An additional September 21 capture supplied 834 GPS rows and 35 stop visits, but **no new rider forecast-log rows**. It completes some earlier outcomes and extends candidate diagnostics; it does not establish a prospective win against production. Source construction changes, the raw-history expansion and the daily-refresh sensitivity are disclosed in the amendment trail. These dates were already used in other research, and none is represented as a pristine research holdout.

The defensible conclusion is to retain the Canal/Winchester relationship as a modeling clue and **keep the current estimator in service**. Whole-journey history could be useful additional evidence. The tested earlier-average replacements do not yet provide the combination of accuracy, useful ranges, arrival responsiveness and historical support needed to replace it.

To reproduce the hosted experiment from this research branch, install backend dependencies and run these commands on a hosted machine, in order:

```sh
npm ci --prefix services/shuttle-v2
cd research/earlier-checkpoint
python3 -m unittest -v test_experiment.py
cd ../..
TZ=America/New_York services/shuttle-v2/node_modules/.bin/tsx research/earlier-checkpoint/replay.ts
python3 research/earlier-checkpoint/evaluate.py
python3 research/earlier-checkpoint/rolling.py
python3 research/earlier-checkpoint/audit.py
```

The committed inputs contain public vehicle records and vehicle forecasts only. Rider reports, screenshots, personal coordinates, IPs and anonymous identifiers are excluded. Full forecast streams and audit outputs are retained in the hosted run artifact and the local investigation directory; compact results and selected vehicle traces are committed beside this report.
