# Review of the implemented first-Division pickup policy

September 18, 2026. **Approved from this bounded code/statistical review; no remaining blocking finding.** The narrow change is defensible for normal CI, integration and deployment verification. This approval does not extend to the rejected broad lower-band removal, a calibrated coverage claim, or a promise that no rider can miss a shuttle.

## Exact implementation

Reviewed `red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/arrival.ts` and `releasePickupBand.test.ts`; hashes are in `independent-targeted-provenance.json`.

- `currentRelease` already requires Red route pricing, an enabled validated Winchester fit, matching current rest/pin identity and an in-support lap. The new policy additionally requires stop 48, occurrence zero, and no more hops than the release-stop-to-Division path. The hop guard correctly rejects a first emitted row that is really the next lap after the leading position has passed Division.
- Only that pickup's lower widening is bypassed. The corresponding modeled distribution uses the same transformation. Existing point and upper pricing, unsupported states, other targets and subsequent occurrences retain their paths. The code introduces neither a hard minimum arrival time nor a tracking/filter change.
- I requested two meaningful test refinements: another route with a **supported** lap, so route gating is tested independently of lap rejection; and a leading position already beyond Division with a lagging Winchester rest clock. Both are now covered and pass.

Independently ran the pickup-band, release-distribution and release-smoothing tests: **14 tests passed across three files**. `git diff --check` passed. Evidence: `independent-targeted-tests.log`. The full suite/typechecks/build and deployment checks belong to the parent's integration gate; I did not claim or rerun those here.

## Targeted replay and continuous audit

The targeted implementation preserves all 150,020 old forecast identities and changes 4,035 lower forecasts. The new-date run preserves 18,209 identities and changes 544 lowers. Pair validation confirms exact point/upper, other-target and following-occurrence equality. I separately verified both targeted tracking files match baseline byte-for-byte, and all scored Rosenkranz checkpoints are identical between arms.

Ran the saved-data scorer as:

```
python3 red-lower-data-2026-09-18/independent-continuous.py --targeted
```

Results are in `independent-targeted-continuous.json/.log`. The targeted first-Division continuous summaries exactly match the previously audited broad candidate's first-Division summaries:

- Among **47 affected stopped pickup visits on Sep16–17**, three visits have a raised lower timestamp later than arrival, by at most 23.46, 3.17 and 1.98 seconds. None is later than recorded pickup departure; the smallest remaining observed margin is **22.85 seconds**.
- Among **four affected stopped pickup visits on Sep18 morning**, one arrival precedes the raised lower timestamp by at most **3.23 seconds**. None is later than recorded departure; the smallest remaining margin is **56.64 seconds**.
- The hypothetical 0/15/30-second pre-lower boarding margins all have zero recorded departure misses. Across all correctly matched stopped visits—53 old and seven new-date—neither arm introduces such a miss. Unknown target departures are explicitly tracked; none occurs in this matched sample.
- Four unchanged old rows containing only a next-lap forecast are counted and excluded from the current-arrival comparison. They result from replay omission of at-stop zero-hop rows. No newly changed lower forecast is removed by that rule.

The legitimate early cases and raw GPS/visit evidence remain documented in `independent-review.md` and `independent-cases.json`. They are small enough, relative to the actual observed pickup behavior and improved interval scores/widths, that they are not a reason to reject this narrow change. The repeated Rosenkranz lower-tail regression from the broad experiment is avoided entirely.

## Practical limits to retain in the release description

The displayed interval is a forecast, not an earliest-possible-arrival guarantee. The current catch warning compares walking time to the raw pickup lower bound without a 60-second buffer; it may change. Leave-reminder timing uses the unchanged point estimate minus walking time minus 30 seconds and is unchanged. Recorded curb departure does not prove doors remain open, and walking/reaction errors were not simulated.

The three dates have already been inspected, and the narrow scope was chosen after the broad results. September 18 uses causally prior, frozen historical calibration inputs rather than the exact received production calibration. These are limitations on generalization and coverage claims, not hidden positive results or evidence that the valid short trips should be excluded. After deployment, compare the actual served pickup forecasts and complete arrivals prospectively; retain early arrivals and unavailable/censored outcomes in that monitoring.

No application source, production record, service or deployment was changed by this independent review.
