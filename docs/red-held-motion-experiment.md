# Rejected Red held-motion experiment

The September 3 GPS data supports separate probabilities for starting and continuing a reposition within a hold. A frozen candidate combined those probabilities with the departure hazard in one coherent observation model. Its September 4 development replay reduced sampled numeric oscillation, but the accuracy gain was small and existing departure tests regressed. **The candidate was rejected and is not part of the runtime change.**

The comparison used continuous client state, all 21,718 Red fixes, the same September 3 phase fit and fixed calibration, unchanged historical features, and the same reconstructed scoring labels. It compared the current PR phase model with that model plus `held-motion-joint-v2`.

| Measure | Current phase | Experimental motion |
|---|---:|---:|
| Winchester first total estimate MAE, 29 visits | 118.15 s | 118.15 s |
| Winchester hold → Division/Prospect ETA MAE, 28 arrivals | 101.10 s | 97.53 s |
| All Red ETA MAE, 854 arrivals | 70.47 s | 69.75 s |
| Sampled ETA increases >60 s during the primary holds | 17 | 5 |
| Primary ETA overprediction >120 s | 18.95% | 22.04% |

The primary ETA change was −3.57 seconds with a paired target-bootstrap 95% interval of −12.03 to +4.05 seconds. It did not establish a reliable improvement. Both arms retained all original paired first displays and eligible ETA keys. Four existing approach-rest/departure accuracy tests failed (2,281 passed); neither tests nor model parameters were loosened. Sampled numeric changes are not exact rendered `fmtBusRange` reversals. The replay records approximately one query per 30 seconds and can miss shorter oscillations.

After archiving the experiment, the candidate patch was reversed. Runtime source again matches `e332cba`; all 35 tests in the two affected recording suites pass unchanged. The proposal retains the existing phase model.

The complete private local archive is under ignored [store/held-motion-v2](../services/shuttle-v2/store/held-motion-v2/). It contains the [result](../services/shuttle-v2/store/held-motion-v2/replay/result.md), [paired report](../services/shuttle-v2/store/held-motion-v2/replay/scored/report.json), [test failures](../services/shuttle-v2/store/held-motion-v2/replay/test-regressions.json), training observations and both frozen patches. The SQLite snapshot and raw captures remain private local artifacts, not committed fixtures. `archive-manifest.json` hashes the preserved files.

Key provenance:

- Base: `e332cbaa9cfc4911bc97776d8103b64cb5437084`.
- V2 candidate lock: `87b588a970e829db7090d5ff9c2f80a2fa5dff150f3da216272e13bfaa7ff5ee`.
- Replay launch lock: `1f335c20cb1cb509ccb8caa7abdaa9fa6fd7d27052f46c7cd5bbbeaf608c693e`.
- Scoring lock: `ca49135d0f0e304cb4174d003e89034a82abe9e3d68bdff7d52f1dc1e6fb8159`.
- Full-suite failure log: `d0dd5d30096269e643f18121ff73ccaa81c9a51f943a1e6669a0dc888ca8caf5`.

The exact original commands were:

```bash
python3 /tmp/accuracy-followup/shuffle/measure.py
python3 /tmp/accuracy-followup/shuffle/conditional.py
python3 /tmp/red-motion-dev-v2/prepare.py
python3 /tmp/red-motion-dev-v2/launch.py --check
python3 /tmp/red-motion-dev-v2/launch.py
python3 /tmp/red-motion-dev-v2/score_dev_test.py
python3 /tmp/red-motion-dev-v2/score_dev.py
```

The archived `replay/launch-manifest.json` contains both exact per-arm commands, environment overrides, model/calibration inputs and source hashes. The training directory preserves the V1 proposal and V2 eligibility correction. A reproduction requires the recorded base and candidate source, matching private inputs and fresh output paths; the launcher deliberately rejects existing outputs and changed hashes. Preserve the original manifests and record a new launch manifest if paths change.

This is an already-examined development day, not a new independent test. No September 9 outcomes were used to choose or evaluate this motion candidate. No deployment resulted from this experiment.
