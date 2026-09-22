# Fixed 45/90-minute causal source retention — development plan

Pinned before implementation or scoring on a separate research branch from `05e9e3424e3075c416111df28addfb88198e90ad`. **Await root review before implementing or running this study.** Research only: reused September 17–20 development forecasts, original replay lead-in, no new/prospective dates, production changes, schedule changes, or local heavy computation.

The observer-only study (run 35693174975; artifact 10679022575, SHA256 `9357143a640acd569b140b026e74f2e7717e11a7b1f15bf1ee0940427271817c`) established why the original filter rejects sources. It did not establish whether those sources remain applicable, supported, calibrated, or useful. In particular an expired source may already have passed its wait stop or belong to an old lap. The present study must expose those downstream failures rather than counting retained origins as usable predictions.

## Immutable inputs, dates and comparator

- Raw/prediction run 35677536788: SHA256 `3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9` / `5bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de`.
- Canonical run 35684356219: topology, causally emitted training visits, September 16 frozen major waits, occurrence indices, calendar-day embargo and exact deployed checkpoint-overlay comparator. Preserve its first-hour replay lead-in and September 16 feature warmup. Only its existing September 17–20 model forecast keys are evaluated.
- Reuse the exact highway25 primary / highway50 fixed-sensitivity quality policies and labels from run 35688081446, with pinned CTDOT/path geometry. Preserve both full policy labels and the original22 label membership split. No label regeneration, new quality policy, coverage threshold relaxation, path-cap change or label horizon change.
- The 45-minute protected reference is run 35690386363 (artifact 10678003242; SHA256 `3d9efacd609484fce0691deb4074b4c8139018a632f15586cac709342131e63e`). All source reference bytes remain immutable; compare regenerated control rows semantically and verify source hashes before/after.

## Fixed arms and sole treatment

Use source-age caps **45 and 90 minutes**, with every K in **1,2,3,5,8,10,15**, frozen and daily refreshed history: 28 protected arms per quality policy, 56 total. There is no K selection, intermediate cap, optimized threshold or winner chosen from the sensitivity policy. Green (9) and Purple (10) are the only routes with a retention treatment; every other route remains exact deployed in every protected stream.

Keep historical training paths, fixed model configuration, support/date/effective-source requirements, frozen September 16 training cutoff and rolling full-calendar-day embargo unchanged. Reconstruct the same models only as necessary to query previously unavailable causal source times; changing the cap never admits a training visit, changes a fit's training cutoff or retunes any model. Require all 45-minute raw candidates, evidence/reasons and protected forecasts to match the stored references exactly before interpreting the 90-minute arm.

For each Green/Purple candidate apply the already fixed transform:

```
eta  = deployed.eta
low  = min(deployed.low, candidate.low, deployed.eta)
high = max(deployed.eta, candidate.high)
```

Apply this to original unscored streams before joining the same immutable labels. Preserve raw candidates/evidence separately. The deployed point, original 15-second live freshness, 10-minute warmup, 45-minute outcome/arrival horizon, renderer/clocks, and every non-source-age gate stay fixed. A 90-minute **source age** is not a 90-minute prediction or labeling horizon.

## Causal history, resets and one-way release

Replay each cap independently from the same ordered raw observations. Only history entries actually inserted by the original causal reducer may be retained. Require unique strict physical-source provenance: pinned, finite nonnull arrival/departure, non-gap stopped/passed event, correct canonical occurrence and actual emission `known_at <= asof`; departure must precede the current phase start. Do not substitute observer-ledger records for missing model history. Do not insert finalized visits, close EOF visits, bridge any observed reset, recover across names/ambiguous identities, or use later fixes.

The cap parameter changes **both existing source-age checks** coherently: the final origin filter and the source's eligibility for the original release-latch update. Leaving latch observation at 45 minutes while retaining an origin for 90 would miss releases observed between those ages. This is the explicit implementation choice for review: 90-minute history observes the same one-way release conditions until age 90; the 45-minute control retains exactly its original behavior.

Preserve original reset conditions, warmth, track reconciliation, wait selection, occurrence assignment and latch identity `(K, wait occurrence, source departure)`. A known later wait departure, phase progress beyond the wait segment or a departing-wait phase releases that source under the same original conditions. Release never reverses when GPS returns to hold. A fresh physical source replaces the origin by its actual departure identity; an old source must not reappear merely because phase/nearest indices wrap. No recovery of a source after a history reset, and no retention beyond the arm's cap. Preserve the original single-occurrence K/target checks.

Save an outcome-independent gate ledger for every arm: newly retained strict source, still absent/expired/reset, occurrence ambiguity, phase/latch release, pickup before wait, unsupported whole target group (including first unsupported target and support/date/source counts), countdown expired, and usable checkpoint. Record overlaps as flags and preserve the original prediction gate order. Report unique physical source emissions separately from repeated forecast snapshots and destination visit IDs.

## Frozen comparisons and rider-risk reporting

- Full Green/Purple route denominators, and supported/actually changed scopes, are separate. Report original22-membership and highway-added labels separately without changing any label or physical boarding visit.
- Compare each matching K/mode at 45 versus 90 on the union where either protected arm differs from deployed. Also preserve the fixed **45-minute raw all14-arm union** from the prior study and a common **all28-arm raw union** for every comparison within each quality policy. Report zero-change cells; never select a favorable changed cohort or K.
- Report both raw pre-protection and protected numeric windows, actual production-rendered printed windows, deployed comparators, source/visit/date support, and full-route versus union results. Retain every K regardless of result. Preserve the existing visit-weighted coverage, early/late tail, severe-early/false-now, point-error and window-width definitions and gates; snapshot counts are not independent trials.
- Replay the full existing walk/response/action grid, preserving fixed bus/physical boarding visit, attempt eligibility, censoring and outcome quality. Report paired new/existing misses, waiting deltas and censoring for deployed/45/90; verify exact deployed actions and unchanged same-visit point decisions, plus protected no-later-low bounds. Do not hide waiting increases or suppress existing deployed misses.
- Audit changes at the original 45-minute boundary, the 90-minute boundary, warmup/reset, source replacement, wait release, phase change and candidate/fallback handoffs. Report same-pickup jumps in point/low/high clocks and actual displayed spans; preserve unmatched and next-occurrence transitions separately. Include old-lap/source-release examples by predeclared first chronological occurrence, not accuracy.
- Fixed-visit action invariance does not establish whole-app boarding safety: destination bounds affect route ranking, its stability hold and pickup catch-risk behavior. Keep the previously recorded application-scope limitation explicit; no deployment claim without the separate app-selector/ranking review.

## Hosted validity gates before outcome interpretation

1. Verify immutable source/geometry/label hashes, exact original forecast keys, 45-minute feature/reason/raw/protected parity and exact deployed/non-Green/Purple controls. Prove strict provenance validation is a no-op on the 45-minute control; ambiguous/unproven treatment origins cause a failed validity gate rather than silent recovery.
2. Test both cap boundaries, confirmed versus open/unpinned/null visits, known-at chronology, reset/provider/name transitions, repeated occurrences, wait departure between 45 and 90, old-lap non-resurrection, GPS return to hold, source replacement and no EOF closure. Use actual reducer/renderer fixtures where relevant.
3. Repeat three physically deleted future-prefix checks at the existing quarter/midpoint/three-quarter forecast timestamps for both caps, plus existing frozen/rolling training-prefix checks with independent caches. No future observation, emission, label or finalized database visit enters a forecast or fit.
4. Persist all unscored candidate/protected/gate streams before loading immutable labels. Assert complete label equality and exact cohort membership; expose any failure before scores and do not adjust the plan in response to favorable outcomes.

The intended test is whether longer retention of a **still applicable, strictly causal** source changes enough supported forecasts to improve useful protected windows without failing the existing rider-risk gates. A cap-only diagnosis or a larger eligible cohort is not evidence of benefit. These reused dates can reject a candidate or motivate a later prospective test; they cannot supply a fresh-holdout claim or authorize production rollout.
