# ETA investigation — September 17, 2026

Two changes have been merged:

- PR279, `47a76b99e63b1075c86b5f6478e838ffdb725b9f`: recover complete detector/visit state across supported fresh-fix restarts. Deployed and health-verified. Actual Red #316 record 65237 had been shortened from 439.480 s to 30.011 s; raw observations reproduce the defect exactly. Future recovery is fixed; original historical records have not been overwritten.
- PR280, `a5ac85abb0f47928b7dfbae0e63a31408ee22dea`: joint sampled travel/lap paths on Red using existing marginal tables. Deployed and health-verified. Longer Union→Division/Rosenkranz windows narrow about 13–14%, with modest typical-error gains. This does not fix the long-Winchester-wait floor.

The Red watcher, monitor timer and worker timer were all active, with fresh rider status and no supervisor error at 19:57 UTC.

## Evidence

The final recorded-GPS replay has 12,654 polls and 117,149 outputs across September 16 and partial 17. Prior tables predate September 14; estimator parameters are the already-published September 15 version. No scored outcomes train the tables. Collector reconstruction uses the actual legacy departure-event lap contract. It begins without prior-day seeds, so this is retrospective development evidence with a 10-minute warm cutoff, not prospective calibrated coverage.

See `joint-release-score.json`, `joint-next-occurrence-review.md`, `joint-next-occurrence-review.py`, and `sampled-marginal-results-review.md`. The final replay includes both target occurrences and separately counts availability at the 90-minute limit. Paired first-arrival scoring now includes Union→Rosenkranz, which the earlier <20-hop run omitted.

The independent next-arrival audit links a full 29-hop lap. It has 574 paired checkpoints over 49 physical next arrivals. Typical errors and interval scores improve; some new interval misses occur. Lower-bound jumps increase, so there is no claim that every visible bound becomes smoother. Static boarding-policy diagnostics add no after-departure commitments on 445 paired stopped-target checkpoints; these are not actual rider catch simulations.

!Historical longer-window comparison (`joint-lap-results.png`; historical input/reference, see publication manifest)

Full-server benchmark: 200 scored polls per arm, 100 warm-up. Mean 12.7→16.9 ms, p95 16.4→22.2 ms, zero failures. Local full regression: 2,724 tests for recovery, 2,721 for the separately based ETA branch; CI checks both against current master. Both server/web typechecks pass.

## Experiments not promoted

Normalized conditional hold tables improve Winchester waiting errors, but systematically make longer Union forecasts too late. Current-only normalization avoids most future bias but sharply increases entry jumps. Future-only explains the long-route bias. Sample-wise future propagation helps, but adding those conditional tables still leaves the bias. Only marginal-table propagation is in PR280.

The unbounded removal of the standing display floor improves ongoing waits but worsens departure forecasts. No blanket clamp removal, EMA, Kalman filter, age-based outlier deletion, or interval-width cap was deployed.

## Remaining issue

Report 115's low point estimate during a long Winchester wait is still unresolved. The old running-minimum display rule can lock in a low mixture estimate and shift the band down. Additionally, historical dwell quantiles use pin→departure while the live filter can retain an earlier approach-rest origin. Three audited examples are real off-marker waits; one is the proven restart truncation. These are distinct problems.

Next work should align historical/live duration definitions using causal reconstructed state, preserve uncertainty about shuffles versus real departures, and evaluate an updated standing forecast separately from the now-improved future-hold propagation. The original raw and visit records remain available. Relevant reviews: `rest-origin-review.md`, `full-path-review.md`, `sample-wise-review.md`.

Working trees:

- `restart-recovery-2026-09-17`: production restart recovery, branch fix/recover-fresh-stop-restarts.
- `joint-lap-2026-09-17`: production joint Red ETA, branch fix/red-joint-lap-paths.
- `server-eta-2026-09-16`: unshipped conditional-table experiments, branch research/lap-conditional-etas. Do not merge these wholesale.

Production verification: `/healthz` reports build `a5ac85abb0f4`, healthy collection, 17 restored ETA beliefs, zero ETA failures, zero skipped polls and zero dropped observations. Both deploy workflows passed the staged API/browser checks and production verification.

## Subsequent departure-pattern exploration

The September 17 follow-up found repeatable hourly per-bus/day departure phases and tested a clock-conditioned departure hazard. Historical remaining-wait errors improve materially; e.g. Union after five minutes waiting, MAE86.1→57.5seconds in the calibrated component comparison. The improvement also exists before calibration. Separate per-age calibration is not a coherent live survival distribution; a single-CDF calibration sensitivity fixes coherence but has mixed accuracy.

A causal recorded-wire prototype at Winchester improves standing forecasts, but a direct model switch increases Division upward jumps and responds too late at departure. It is explicitly rejected for deployment. No further production changes were made. The complete evidence, scripts, figures, and independent review are linked from [release-investigation.md](../red-window-data/release-investigation.md). This strengthens the case for integrating a departure hazard with the existing movement mixture and future-stop pricing, rather than replacing forecasts only after pinning.
