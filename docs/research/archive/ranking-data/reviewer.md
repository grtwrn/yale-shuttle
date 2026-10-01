# Independent route-ranking review

Reviewed the uncommitted `fix/useful-route-ranking` tree at base `0d41e47`, including the final refinements, on 2026-09-17. This is a bounded read-only algorithm, UX, and release review; the reviewer did not change application code or deploy.

**Decision:** no unresolved release-blocking ranking defect found. The identified runtime dependency omission is repaired in source; release remains contingent on the maintainer's actual container build/import check and normal CI. This approves the route-preference change, not ETA calibration or the separate no-ratchet experiment.

## Findings addressed

1. **Runtime dependency omission — release blocker, repaired.** The server planner now imports shared `web/src/walk.ts`, but the original runtime Docker COPY list omitted it. `services/shuttle-v2/Dockerfile:44` now copies it, and `src/server/serverEta.closure.test.ts:26,69` checks the closure of both server estimator and planner. Parent reports the expanded closure test passed; actual container import was still underway at review completion.
2. **Unknown destination window with a long known pickup wait — repaired.** An unconditional `[0, Infinity]` fallback could rank a short ride with a 40-minute pickup wait before an evidently earlier alternative. `web/src/tripRanking.ts:13–20` now uses `max(walkToSec, pickupLowSec) + walkFromSec` as a conservative lower bound, with no finite upper bound. This uses the ordering implication that destination arrival cannot precede pickup and final walking, without inventing ride uncertainty. Regression: `tripRanking.test.ts:37–43`.
3. **Too little walking saved on long trips — repaired.** Saving two minutes from a 30-minute walk previously passed the filter. `web/src/walk.ts:90` now requires `min(20% of direct walk, max(120 seconds, 10% of direct walk))`; 28 of 30 minutes fails and 27 passes. Regression: `tripRanking.test.ts:103–106`. This is an explicit rider preference, not a statistically estimated optimum.
4. **GPS jitter could restart the persistence clock — repaired.** `web/src/TransitMap.tsx:2340–2346` identifies a current-location origin by its source rather than the exact changing GPS coordinates. Destination, explicitly selected origin, planned time, and refresh still reset the order.
5. **Caption overstated interval comparability — repaired.** `TransitMap.tsx:3770` now says, “When arrival timing is unclear, shorter walks and rides come first.” This also describes absent windows, without falsely claiming all displayed windows are similar.

## Algorithm assessment

- `web/src/planner.ts:472,759–760` preserves a planned ride duration for route quality while live displayed forecasts remain free to change. This directly prevents a noisy difference between pickup and destination ETAs from being treated as a different physical route.
- `web/src/tripRanking.ts:27–45` chooses from the routes with no clearly earlier predecessor, then compares planned walking plus riding. Valid finite intervals induce an acyclic precedence relation. This is preferable to sorting by an overlap comparator, which can be non-transitive; the overlap-chain regression exercises the distinction.
- `tripRanking.ts:57–73` requires a new order to persist for 30 seconds, while roster and availability-tier changes take effect immediately. It stabilizes placement without freezing the ETA shown on the card. A wait increase can still change order when destination windows become clearly separated.
- Comparing total walking across near-best boarding/alighting choices, sharing the walking-benefit rule between planners, and using planned commute for the third-route visibility rule are consistent with the requested preference for less walking and riding.

## Remaining limits, not release blockers

- Non-overlapping model windows are a preference heuristic. They do not establish a validated probability that one route arrives first: the existing interval calibration limitations and common traffic dependence remain. Do not label this order “most likely on time,” a guaranteed fastest route, or a calibrated confidence ranking.
- If both pickup and destination timing are unavailable, the shortest planned commute can still rank ahead of a longer commute with better known timing. No finite arrival guarantee is manufactured. The separate class-time recommender must continue rejecting unavailable destination windows, as it currently does. Future schedule-only planning likewise has less evidence for ordering by arrival uncertainty.
- The 90-second separation, one-minute commute tie, 30-second persistence, and walking-saving thresholds are transparent UX settings. They have not been optimized on independent rider outcomes. Persistence deliberately permits a short lag before an otherwise preferable route moves.
- Planned riding cost is stable route context, not a replacement for current travel-time estimates. Walking is still modeled using the existing effective straight-line-distance approximation, and ranking cannot correct bad route geometry or inaccurate ETA distributions.
- The actual route roster and explicit replans can still change order immediately. The new logic prevents within-roster jitter; it does not promise that cards never move.

## Validation provenance

I inspected the final source and targeted regressions above. Parent reports 2,715 tests across 120 files, typechecks/build, recorded phone flows, and six synthetic live ETA swings passed before these final refinements, followed by 124 focused tests plus typechecks/build on the revised tree. These are maintainer-reported results, not independently rerun full CI. The synthetic flow establishes display stability, not forecast accuracy. Actual runtime container imports were still being checked by the parent.

The separate statistical experiment remains unsuitable for model promotion: `../red-window-data/ratchet-screen-review.md` records new upward jumps, worse initial departure errors, and future-outcome leakage in the reused sample tables. This ranking change does not resolve or mask that evidence by changing coefficients or narrowing intervals.

## Maintainer release verification

After the review, the actual backend container imported the server planner and estimator and passed the final walking-policy check. Final-head CI passed all 2,718 tests plus typechecks, build, staged API/browser checks and the accuracy replay. PR278 was merged and deployed as9e7b48b5b060. Five live health polls and recorded/synthetic/live browser verification passed; see production-verification.json and production-* artifacts. These are maintainer checks, separate from the source review above.
