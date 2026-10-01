# Red 344 Winchester hold: covariate screen against production (2026-10-01)

**Question** (Garrett, 2026-10-01 11:39 ET): the wait at 344 Winchester (Red stop 11) varies a lot. Which covariates explain that spread? Do they also improve the pickup forecast at Division / Prospect (stop 48), two stops downstream? Do any of them beat what production already predicts?

**Short answer.**
- Most of the spread is already explained by the two covariates production uses: the bus's own lap and the 15-minute clock phase. None of the untested families (weather, class-change times, active fleet, shift or service entry, the operator's own ETA, co-presence) passes the frozen rule out of sample. The interaction (INT) and penalised all-family (ALL_R) arms do improve the score but fail the rule: INT's Bonferroni CI crosses zero, and ALL_R raises late-tail misses from 7.2% to 9.2%, past the frozen 2-pp limit.
- One demand/delay proxy passes the frozen rule: how long the bus has spent stopped at ordinary stops since leaving Union Station. Its gain is small: weighted interval score 38.2 → 37.3 s, better on 7 of 8 test days, with tail misses within the 2-pp tolerance (below q10 4.6 → 5.3%, above q90 7.2 → 7.6%).
- A model combining every family gains more (−2.2 s, 7 of 8 days). It misses the frozen late-tail limit by 0.02 percentage points, so it is not a candidate.
- The largest gap is not a covariate. Production's logged Division pickup scores about 24 s worse (weighted interval score) than its own departure-hazard component plus an empirical drive time. Its window is 418 s wide against 275 s, with 89% vs 86% coverage of the nominal 80% interval. That comparison is selective: 64 holds on mostly three days. Production also keeps early misses lower (1.2% vs 6.5%).

Nothing here is ready to ship. The demand proxy, and the production pickup gap, are leads for a full production-estimator replay.

## Design (pre-registered)

- **Freeze.** [PLAN.json](PLAN.json) and the analysis code (`lib.py`, `model.py`, `screen.py`) were frozen at 2026-10-01 12:09:52 ET. Commit `3fcccc6` on `ys/redexp20261001` was pushed before any test-period hold duration, residual, pickup outcome or score was computed. PLAN.json sha256 is `e3e1a8f749673d713abfbd619889442865e5e25c196fde106f8a5a41f9868347`. File hashes are in [FREEZE.json](FREEZE.json), and `runner.py` re-checks them on every run. The plan's `seen_before_freeze` field lists what was seen before the freeze: development-period outcomes and, for test days, only counts and weather. A gateway restart interrupted the first session. It had started the baseline check, and that check was redone on the development cutoff.
- **Data.** The nightly production archive, 2026-09-03..09-30, now on the Mac (`/Users/grtwrn/shuttle-archive`). It is read only through each day's selected manifest, with SHA-256 verified. 2026-09-30 is the complete Mac copy; the Pi copy was all-401. Hourly Open-Meteo reanalysis supplies weather. Class times are the Yale FAS/SEAS Fall 2026 standard meeting times. Red runs on weekdays only, which gives 19 service days and 525 Winchester holds.
- **Labels.** Production's own cohort (`releaseFit.ts`): stopped, pinned Winchester visits, closest approach ≤75 m, with only the audited restart truncation excluded. Hold = departure − pin. Pickup truth is the same vehicle's next Division arrival (`arrivals`), production's pairing truth.
- **Baseline B0** is production's form exactly. It is the nine-feature 15-s discrete-time departure hazard: elapsed-wait terms, own lap, and the 15-minute clock harmonic. It uses L2 = 4, censoring at 1,800 s and an exponential tail. Refit at the documented 2026-09-17 13:14:00.913 ET cutoff, it reproduces `release-integration-data/runtime-fits.json` exactly: n = 259, 10 dates, reference lap 3210.248 s, and all nine coefficients to 4 decimal places.
- **Splits.** Development is ≤ 2026-09-18. The test period is 2026-09-21..09-30: 8 service days, 221 holds, 188 of them with a supported lap. One fold per test day. Each fold trains on holds whose outcome was available before that day, pinned within the previous 30 days, which is production's rolling window. All centring constants come from training only.
- **Arms.** B0 plus 11 candidate arms, each adding one family to B0 (definitions in PLAN.json):
  - W (weather), C (class-change clock), FS (active fleet ≤2)
  - SH (first loops, time in service, recent service entry or exit)
  - LL (own hourly-slot slack, a dispatcher-intent proxy)
  - DM (stand time and stop count at ordinary stops since the last Union departure)
  - UE (operator ETA to Division at pin), CP (co-presence and recent Winchester departure)
  - INT (lap × phase, fleet × phase)
  - ALL, and ALL_R (all families with penalty 20 on the added terms)

  An added column is used only with ≥20 training holds on ≥3 dates. The new-bus, fleet-drop, ≥900 s operator-ETA and Winchester co-presence flags never reached that support.
- **Primary metric.** The 7-quantile weighted interval score (WIS) of the remaining hold at 0/60/180/300/480 s after pin, over supported holds (694 checkpoints, 188 holds). Uncertainty comes from a bus-day cluster bootstrap (23 clusters).
- **Decision rule (frozen).** An arm is a candidate only if all of these hold:
  - its Bonferroni CI (11 arms) is below 0
  - it is better on ≥75% of test days
  - neither the below-q10 nor the above-q90 miss rate worsens by more than 2 percentage points
  - its log score is not worse

## Results: remaining Winchester hold (test period, supported holds)

| Arm | WIS (s) | Δ vs B0 [95% CI] | Bonferroni CI | Days better | Below q10 / above q90 | Log score | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| B0 (production form) | 38.24 | | | | 4.6% / 7.2% | 3.033 | |
| W weather | 38.48 | +0.24 [−0.27, 0.73] | [−0.50, 0.94] | 1/8 | 4.5% / 8.8% | 3.029 | not supported |
| C class-change clock | 38.32 | +0.08 [−0.23, 0.35] | [−0.40, 0.48] | 3/8 | 4.6% / 7.9% | 3.037 | not supported |
| FS active fleet | 38.58 | +0.34 [−0.16, 0.89] | [−0.33, 1.08] | 3/8 | 5.0% / 7.2% | 3.041 | not supported |
| SH shift / service entry | 37.92 | −0.32 [−0.68, 0.05] | [−0.84, 0.23] | 4/8 | 4.9% / 6.6% | 3.024 | not supported |
| LL hourly-slot slack | 37.97 | −0.27 [−1.49, 1.68] | [−1.90, 2.68] | 7/8 | 5.2% / 6.5% | 2.998 | not supported |
| **DM demand / en-route stops** | **37.29** | **−0.96 [−1.47, −0.41]** | **[−1.67, −0.23]** | **7/8** | 5.3% / 7.6% | 3.022 | **candidate** |
| UE operator ETA | 38.22 | −0.02 [−0.24, 0.18] | [−0.39, 0.26] | 4/8 | 4.6% / 6.8% | 3.033 | not supported |
| CP co-presence | 37.81 | −0.43 [−1.25, 0.39] | [−1.65, 0.86] | 4/8 | 5.8% / 6.8% | 3.006 | not supported |
| INT interactions | 36.86 | −1.39 [−2.51, −0.14] | [−2.87, 0.62] | 7/8 | 4.2% / 7.8% | 3.011 | not supported |
| ALL | 35.89 | −2.35 [−4.58, −0.20] | [−5.47, 0.77] | 7/8 | 4.5% / **12.5%** | 2.934 | not supported |
| ALL_R (penalty 20) | 36.00 | −2.24 [−3.61, −1.04] | [−4.15, −0.46] | 7/8 | 4.9% / **9.2%** | 2.951 | not supported (late tail +2.02 pp) |

The DM coefficients are stable across all eight folds. More time spent stopped at ordinary stops since Union raises the departure hazard: the bus leaves Winchester sooner (stand term +0.51…+0.57 per 300 s). That is consistent with the Winchester hold absorbing schedule slack: time lost to passenger stops is recovered by holding less. It adds information beyond lap because lap counts all elapsed time, while DM isolates time lost at stops. The gain is about 2.5% of WIS, and it shrinks with hold age (−1.3 s at pin, −0.45 s at 480 s). The operator's ETA to Division sits at 274–298 s at pin whatever the hold, so it carries no hold information.

## Results: Division / Prospect pickup

*All checkpoints* (619 checkpoints at 60/180/300/420 s into the hold). Each arm's hold distribution is convolved with the training drive-time distribution. Only DM (−0.87 s, unadjusted CI −1.58..−0.09; Bonferroni −1.88..+0.19) and ALL_R (−2.31, unadjusted CI −3.82..−0.83) improve on the B0 hazard, which mirrors the hold results. DM's pickup gain is not significant after the multiplicity adjustment.

*Against production* (checkpoints where production logged a rider-surface prediction to Division in the preceding 30 s). There are 169 checkpoints over 64 holds: 09-21 11, 09-22 12, 09-23 41, 09-24 52, 09-25 49, 09-28 0, 09-29 2, 09-30 2. They come from 9 client builds. Predictions are only logged while someone has the trip open.

| Forecast | WIS80 (s) | Δ vs P0 [Bonferroni CI] | Median error MAE (s) | 10–90 width (s) | Coverage | Below / above |
|---|---:|---:|---:|---:|---:|---:|
| P0 production (logged) | 66.3 | | 106.7 | 418 | 89.3% | 1.2% / 9.5% |
| RCAL (P0 point + training residual quantiles) | 68.7 | +3.3 [−2.6, 10.3] | 106.7 | 311 | 74.1% | 20.3% / 5.7% |
| H_B0 (production-form hazard + drive) | 42.4 | −23.9 [−36.1, −9.5] | 65.5 | 275 | 86.4% | 6.5% / 7.1% |
| H_DM | 40.7 | −25.6 [−37.3, −12.0] | 62.4 | 268 | 89.9% | 5.9% / 4.1% |
| H_ALL_R | 38.8 | −27.6 [−38.1, −15.6] | 60.9 | 251 | 86.4% | 5.9% / 7.7% |

Read this with care:
- P0 is the full served estimator, with mixture pooling and a deliberate lower-side margin. It is up to 30 s stale (median 9.6 s) and was logged only when a client was watching.
- The H forecasts are component forecasts at the exact checkpoint, and they assume the drive time is independent of the hold.
- Production's lower margin buys fewer early misses: a bus arriving before the window, which a rider can miss. That rate is 1.2% against 6.5%.

Even so, production's point error is ~40 s larger and its window ~140 s wider at similar upper-tail coverage. That points to the step that turns the hazard into the displayed pickup, not to missing covariates. It needs a full production replay at Division with rider-relevant early/late costs before anything changes. Simple recalibration of P0 (RCAL) does not help.

## Where the spread comes from (descriptive, in-sample)

- **Hold size.** Hold SD is 204 s (median 370 s; 10–90% 120–640 s), similar in the development and test periods.
- **What explains it.** A linear decomposition of hold seconds gives R² 0.65 for lap + 15-min phase. Shapley shares are LAP 0.21, PHASE 0.19, LL 0.14 (overlaps both), DM 0.075, SH 0.04, CP 0.03, UE 0.01, W 0.007, C 0.003, FS 0.001.
- **What the new families add.** Over lap + phase, every new family adds ≤ 2.7 pp: DM 2.7, LL 1.8, CP 1.6, SH 1.3, all others ≤ 0.3. Day fixed effects explain 7% and bus fixed effects 1%.
- **What stays unexplained.** About 30% of the variance is left. That residual is consistent with driver and dispatcher discretion that this archive does not observe.
- **Pickup spread.** The pin-to-Division spread is almost entirely the hold: hold variance 41,205 s² against drive 883 s² (drive median 70 s, 10–90% 55–105 s). Improving the pickup forecast therefore means improving the hold forecast, or how it is served.

## Rider data (dedicated Red rider, since 2026-10-01)

`rider_extract.py` parses the dedicated Red rider's artifacts (`scripts/.rider-watcher-red/`) into one row per 10-s waiting sample. Each row holds the displayed "Board in" window, the followed bus and its Winchester stand timer, and how the window compared with the rider's boarding time. When the archive day exists, the production arrival at stop 48 is joined as well.

On 2026-10-01 there were 3 journeys, 2 of them boarded (#316 at 15:47:21Z after a 6:38+ Winchester stand, and #317). All 17 scored waiting samples were inside the displayed window. That is far too little to conclude anything. Samples within one journey are strongly correlated, so journeys are the unit.

The rider is itself a client watching Division. It should therefore also give production (P0) predictions at Division on every service day from now on, which the runner's extension folds will score.

## Limitations

- The pre-registration covers one 8-day test period, and the effects are a few seconds. A single bad week could flip DM.
- The extension folds are the confirmation path.
- Weather in the frozen run is reanalysis, which is not available live. Only 09-28 had rain in the test period, so a rain effect is essentially untestable. Extension days use Open-Meteo forecast-API past hours, fetched daily by `runner.py`; the frozen weather files are hashed in [WEATHER-INPUTS.json](WEATHER-INPUTS.json), and the runner fails if a scored day lacks weather.
- CP's recent-Winchester-departure count (`win_dep_10`) uses a 60 s availability delay where PLAN.json says 120 s for departures. It affects 3 test holds and does not change CP's verdict; the frozen code is left as run.
- The weekend regime is not testable, because Red runs weekdays only.
- The demand proxy uses stand time at stops, not boardings. There is no passenger count in the data.
- Component forecasts are not the served ETA: there is no position uncertainty, pooling or display rounding. A candidate needs the production replay of `docs/red-current-release.md` before it can ship.
- Sample counts in the descriptive decomposition are in-sample and linear. They show where the variance sits, not forecast gains.

## Next steps (for ys-lead / Garrett)

1. **Keep the runner going.** `runner.py` runs daily after the 03:40 archive, and `runner.py --rider` runs hourly. Re-read DM and ALL_R on the extension folds once there are ≥5 new service days. Runs from 2026-10-02 on carry the weather hashes and gap check; read W, ALL and ALL_R only from those. The P0 comparison there will have the dedicated rider's coverage.
2. **Investigate the production pickup gap at Division.** This is the larger lever. Run a replay that scores the served Division window against the hazard + drive component, with early-miss cost made explicit. It would show where the 140 s of width and the 40 s of point error come from.
3. **If DM holds on the extension,** build it into the production replay as one added column. The support gate and fold-local centring are already defined.

## Reproduction

```
cd docs/research/archive/red-winchester-covariates-2026-10-01
PY=/Users/grtwrn/.openclaw/yale-shuttle-team/red-experiments/venv/bin/python   # python 3.9, numpy 2.0.2
$PY screen.py --dev-smoke --out /tmp/dev      # development folds only (09-14..09-18), exit 0, 7.7 s
$PY screen.py --out <dir>                     # frozen screen, exit 0, 12.7 s; writes screen-full.json + screen-summary.json
$PY runner.py                                 # daily: freeze check + screen over all archived days + rider extraction, exit 0
$PY runner.py --rider                         # hourly: rider extraction only, exit 0
```

[screen-summary.json](screen-summary.json) is the frozen run's summary (plan hash inside), and [dev-smoke-summary.json](dev-smoke-summary.json) is the pre-freeze development run. Per-row scores (`screen-full.json`, 8 MB) stay local under `red-experiments/results/`. Re-running the frozen screen reproduces the headline exactly (checked with run 20261001T121400). On macOS's numpy 2.0 Accelerate build, matmul emits spurious RuntimeWarnings; fits are checked finite.
