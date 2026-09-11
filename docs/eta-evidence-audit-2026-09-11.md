# ETA uncertainty: audit the instrument before choosing a model

PR-only investigation, September 11. No runtime ETA, model, serving gate, merge or deployment changes. The accompanying change repairs one rider-simulator attribution error and preserves unattributed drops as a separate diagnostic.

## Findings

1. The original PR #184 zero-hit criticism was a replay-input error. Its follow-up supplied production split calibration and observed positive-weight activations. The later September 10 baseline/candidate metadata have identical production calibration cutoff, topology and payload hashes; the candidate records positive-weight activation. The zero-hit criticism does not invalidate this later comparison.
2. The later instrument has another defect: it can combine a **second-slot** ETA drop with the **first bus's** arrival, and even compares the second-slot drop against the first-slot remaining minutes. It also accepted a first-slot drop when the observed arrival was a different bus. That is insufficient evidence for the stranding proxy.
3. Lap time still explains substantial variation in historical Red layovers under a chronological split with training-only loop estimates. The previously departed shuttle's time gap adds little. This does not measure actual road distance to a following bus.
4. The uncertainty is reduced, not closed. Arrival-label validity, stand-label validity, whole-trip accuracy and stability are separate checks.

## Repair and saved-data audit

`strandAttribution` requires a primary-slot drop, consistent named vehicle before/after, and that vehicle's observed arrival within the existing two-minute window. Second-slot or unmatched-vehicle candidates remain `unattributedStrand`, are counted separately in summaries, and retain their original catastrophic transitions/reversals. These are proxy labels; no simulated flag establishes that a real person missed a bus.

`audit-strands.ts` first reproduces **every old saved stranding flag exactly**, then changes attribution. It rejects duplicate wait IDs and malformed/non-monotone transition clocks. Comparisons use identical request IDs, arrival times and arrival vehicles, exclude unobserved arrivals and already-at-stop waits symmetrically, and retain exclusions. It does not rerun the estimator or change the predictions.

| Saved comparison | Valid paired waits | Old fixed / introduced proxy flags | Attributable fixed / introduced | Primary catastrophic waits, base → candidate | Secondary catastrophic waits |
|---|---:|---:|---:|---:|---:|
| PR #184 Red, Sep 10 morning | 378 | 9 / 8 | 0 / 1 | 10 → 17 | 0 → 28 |
| Blue Night lap extension, Sep 6 | 1,195 | 0 / 74 | 0 / 0 | 278 → 277 | 16 → 634 |
| Blue Night lap extension, Sep 8 | 1,044 | 0 / 39 | 0 / 0 | 261 → 261 | 62 → 381 |

“Unattributed” means missing evidence, not a clean pass. The Red primary jumps still worsen; Blue Night's secondary jumps still worsen substantially. A corrected stranding score alone does not justify shipping either candidate. These counts are waits containing events, not independent bus visits or individual transition totals.

The raw September 10 capture contains 50,116 records. Its SHA-256 matches the baseline's recorded input hash. A separate Python audit checks Red GPS validity and duplicates, then checks saved arrival labels against exact captured polls, a preceding gap no greater than 30 seconds, distance no greater than 45 metres, and the feed's served-stop transition within the existing -120/+300-second corroboration window. **All 242 distinct scored arrival events (405 waits) pass.** Thus the broad Red result is not explained by corrupt arrival labels under those checks. Multiple synthetic riders share these events; 405 is not 405 independent outcomes. GPS and served-stop assertions come from one provider, not independent ground truth.

## Lap and headway experiment

Input: the existing 3,752-row Red closed-arrival export at Winchester and Union Station, June–September. It has no timestamp-invalid rows, exact duplicates or overlapping visits within the same bus/cell under this audit. **These checks do not validate the physical standing clock.** This older table measures geofence visits, not the modern pinned standing clock; the export lacks censoring/receipt-time metadata and its upstream selection cannot be reconstructed from the file alone.

The comparison is deliberately a component experiment, not a production A/B:

- Fit only visits completed before August 15 Eastern.
- Calibrate each model's 10th/90th residual interval on August 15–28 completed visits.
- Score all available August 29 onward closed visits: 197 Winchester and 212 Union, eight service days each. This archive was previously inspected; chronological holdout is not untouched prospective confirmation.
- Derive the loop period from training only. An earlier exploratory `r184data/lap90.mjs` derived its period and eligibility band using the full corpus before splitting, so its holdout was not fully isolated.
- Require a previous same-day own-stop departure and an intervening departure at the other Red layover before using the lap. First visits/missing loops/out-of-band loops use the pooled fallback and remain in the test denominator. No observed long-stand rows were removed by this script.
- Compare pooled median, a fitted lap slope, and fitted lap plus elapsed time since another bus's prior departure at the same stop. Departure features are built chronologically; the target visit's eventual departure is never used as its own feature. Physical-event availability is assumed; receipt-time causality cannot be established from this export.
- The 0.65–1.65 loop band is inherited from existing work, not optimized on this test. Residual quantiles are calibrated separately from the test. Day-block bootstrap uses 400 deterministic resamples.

| Stop / model | Stand MAE (s) | Mean 80% interval width (s) | Test coverage |
|---|---:|---:|---:|
| Winchester pooled | 228.2 | 538.5 | 75.6% |
| Winchester lap | 151.1 | 407.7 | 80.2% |
| Winchester lap + prior-departure headway | 146.6 | 418.7 | 79.7% |
| Union pooled | 253.6 | 655.7 | 83.0% |
| Union lap | 158.8 | 381.6 | 77.4% |
| Union lap + prior-departure headway | 158.9 | 381.6 | 77.4% |

The fitted slopes are -0.475 at Winchester and -0.764 at Union: a minute of additional lap time predicts approximately 28 or 46 seconds less standing, not an automatic minute less. Loop periods are approximately 59.8/59.9 minutes. Lap versus pooled paired MAE changes have day-bootstrap intervals [-90.7, -64.3] and [-118.9, -69.6] seconds. Headway's extra change at Winchester is -4.5 seconds with interval [-10.5, +0.3]; at Union it is +0.08 seconds [-0.02, +0.16]. Neither establishes an additional benefit. The older pooled clock and seasonal shift make these absolute errors unsuitable for comparison with production ETA scores.

A separate sensitivity run delays every departure's availability by 120 seconds while preserving its physical timestamp. Winchester lap MAE is 151.0 s and lap+headway is 148.9 s; the incremental interval is [-4.8, +0.1] s. Union lap stays 158.8 s and headway is 159.0 s. The main lap result persists, and headway's small gain remains uncertain. This assumed delay is not proof of actual publication latency. [Delayed-history results](data/eta-evidence-audit/lap-headway-delay120.json).

## Validation

The saved scores reproduce exactly before reattribution. The raw Red capture hash matches the recorded replay manifest. All three transition audits and both chronological component runs completed. Thirty-two rider-simulator regression tests pass, including preserved primary drops, secondary-slot rejection, mismatched/missing vehicle rejection, non-finite values and visible unattributed counts. Full backend/frontend typecheck passes. No browser, model fit service or full-day ETA replay was launched; checks ran one at a time with low priority and capped Node heaps.

## What this supports next

The existing continuous lap correction is a better-supported starting point than reviving #184's full-compensation step. The experiment does not establish that replacing current production lap arithmetic with this OLS component is beneficial. PRs #217/#218 already investigate the departure transition and route-13 rollout; this audit does not duplicate or approve them.

For actual spacing, measure **directed time or distance along the route to identified preceding/following buses**, not nearest straight-line distance. Require synchronized, fresh GPS, route/direction/occurrence matching and a clear neighbor ordering; mark crossings, repeated-stop ambiguity, missing neighbors and stale positions unavailable. A future following-bus arrival is not a permissible feature. The 90-day closed-visit export cannot supply these features; this report does not claim they were tested.

Before a runtime change: verify modern physical stand labels and availability, test the full current client including second-slot identity and next-lap arrivals, separate eventful corrections from unexplained jumps, and require interval coverage/width and overprediction tails alongside first-ETA error. No reduction in a misattributed flag is a substitute for that validation.

## Reproduction

From services/shuttle-v2 (original immutable files remain local):

```sh
node --import tsx scripts/eta-replay/rider-sim/audit-strands.ts A.waits.jsonl B.waits.jsonl
python3 scripts/eta-replay/rider-sim/audit-capture.py CAPTURE BASE_WAITS SNAPSHOT_DB OUTPUT_JSON
python3 scripts/eta-replay/rider-sim/audit-lap-headway.py RED_ARRIVALS_JSONL OUTPUT_JSON
```

[Red transition audit](data/eta-evidence-audit/red-0910.json), [raw capture audit](data/eta-evidence-audit/red-capture.json), [Blue Night Sep 6](data/eta-evidence-audit/blue-night-0906.json), [Sep 8](data/eta-evidence-audit/blue-night-0908.json), [lap/headway experiment](data/eta-evidence-audit/lap-headway.json). Files record inputs and hashes. Original measurements remain unmodified.
