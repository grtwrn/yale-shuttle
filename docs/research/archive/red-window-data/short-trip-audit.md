# Audit of short Red journeys

**Do not remove the short tail on the evidence from this audit.** The shortest Division/Prospect waits have coherent travel and stop records; much of their shortness comes from measuring the remaining wait after the bus has already spent nearly seven minutes at Winchester. There are narrower quality concerns: upstream stop detection at Rosenkranz and imperfect matching of the historical bus's exact resting state. Those deserve explicit quality flags and better matching, rather than deleting trips based on duration.

## Selection and reproducibility

The read-only [script](short-trip-audit.py) combines the 75 Division trips in `history-sample-data/expanded-production-fixture.json` at 55 seconds elapsed and 37 in `wait-route-data/rosenkranz-compact/result.json` at 405 seconds elapsed. There are 78 distinct physical source/target journeys in that union. When the same journey appears at both elapsed clocks, the audit retains the shorter displayed remaining wait and reports its clock explicitly; it does not treat the two observations as independent trips.

Despite its name, the compact Rosenkranz fixture contains only a query for Division stop 48. To inspect dropoff stop 4, the script extends those same 37 source visits through exact legs and visit endpoints. Thirty reach a qualifying stopped endpoint; six fail that endpoint requirement and one lacks an unambiguous matching arrival visit. Those seven are not included as valid dropoff histories. No missing segment is imputed or prorated.

The selected sample is the five shortest distinct Division journeys and five shortest eligible dropoff journeys. It represents ten source/target journeys, seven physical source visits, and six dates. IDs below are `route:source_visit_id:target_visit_id` in `red-eta-data/replay-lap.db`; the JSON also preserves bus names and exact epoch times as portable identifiers.

The script opens both SQLite databases read-only and streams existing raw archives/captures only to retain these bus/time windows. It writes [short-trip-audit.json](short-trip-audit.json), including full source/target evidence, intermediate visits, exact leg IDs, GPS windows, source clocks, archive coverage, and rejected extensions. Run `python3 red-window-data/short-trip-audit.py` from the workspace root. No app, model, recording, or production service was changed.

## Ten shortest selected journeys

Times are Eastern. "Elapsed" is the matched historical Winchester pinned clock, not added travel. "After departure" includes travel and any intervening stops.

| Journey ID | Bus; date and matched time | Target | Elapsed s | Remaining s | Residual Winchester wait s | After departure s | GPS coverage |
|---|---|---|---:|---:|---:|---:|---|
| 3:6354:6371 | #304; Sep 4, 10:01:15.598 | Division | 55 | 90.123 | 30.142 | 59.981 | Yes |
| 3:1806:1819 | #316; Sep 3, 11:45:26.712 | Division | 405 | 108.094 | 21.914 | 86.180 | Yes |
| 3:29811:29835 | #316; Sep 10, 10:45:45.111 | Division | 405 | 110.039 | 20.052 | 89.987 | Yes |
| 3:17163:17185 | #306; Sep 8, 09:45:09.759 | Division | 405 | 115.022 | 34.992 | 80.030 | No |
| 3:17847:17861 | #304; Sep 8, 11:04:10.189 | Division | 405 | 115.023 | 15.174 | 99.849 | No |
| 3:53030:53076 | #316; Sep 15, 12:00:30.943 | Rosenkranz/130 Prospect | 405 | 350.171 | 75.013 | 275.158 | No |
| 3:29811:29886 | #316; Sep 10, 10:45:45.111 | Rosenkranz/130 Prospect | 405 | 365.222 | 20.052 | 345.170 | Yes |
| 3:58061:58110 | #316; Sep 16, 09:44:07.083 | Rosenkranz/130 Prospect | 405 | 375.105 | 120.072 | 255.033 | Yes |
| 3:17163:17224 | #306; Sep 8, 09:45:09.759 | Rosenkranz/130 Prospect | 405 | 390.045 | 34.992 | 355.053 | No |
| 3:17847:17881 | #304; Sep 8, 11:04:10.189 | Rosenkranz/130 Prospect | 405 | 395.045 | 15.174 | 379.871 | No |

## What is supported

All ten have exact, increasing departure/arrival timestamps along the correct route occurrences. Each Division path has three one-hop legs, 11→146→49→48. Each dropoff path continues 48→104→113→4, with matching intermediate arrival and departure records. There is no gap-confirmed visit in the selected paths, missing link, bus-ID switch, or jump to a later lap. Intermediate pass-throughs are retained as observed links, not misrepresented as stops. All selected targets have a detector-classified stopped visit within 75 metres.

There is no evidence of impossible travel. In the five GPS-supported journeys, maximum observed consecutive-fix speeds are 14.4–16.0 m/s. Maximum observation gaps are 5.35–16.59 seconds; the two older cases have gaps above the usual five-second cadence but no long tracking break or teleportation. Their exact seconds therefore should not be treated as more precise than the polling evidence.

The three GPS-supported Division targets rest within 3.1, 11.5, and 9.4 metres of the mapped stop, respectively. Their target stands are 15.025, 30.293, and 60.283 seconds. The two Division cases without raw data have recorded closest approaches of 5.3 and 3.8 metres, and stands of 49.991 and 45.073 seconds. That is affirmative evidence supporting the short arrivals, with the raw-data limitation for the latter two.

The 90.123-second case is especially informative: its full Winchester pin-to-departure duration is 85.142 seconds. At the matched 55-second clock, 30.142 seconds remain, followed by 59.981 seconds through three linked legs. No implausibly short total hold needs to be invented to explain the observation.

## Concrete quality limitations

### 1. Rosenkranz's recorded arrival can be upstream of the mapped stop

- **3:29811:29886, #316, September 10:** arrival is recorded at 10:51:50.333 on a repeated coordinate approximately **56.0 metres north** of stop 4. It remains there until 10:52:15.194. The first observation within 25 metres of the mapped point occurs at 10:52:20.276, **29.943 seconds later**; closest subsequent passage is about 14.7 metres away. The feed then continues past the stop coordinate. There is no observed rest right at that closer passage.
- **3:58061:58110, #316, September 16:** arrival is recorded at 09:50:22.188 on a **72.7-metre upstream** plateau lasting 14.999 seconds. The first observation within 25 metres occurs at 09:50:47.214, **25.026 seconds later**. It continues through that location.

These are real tracked journeys, but the recorded arrival is a geofence/rest proxy, not independently verified boarding or alighting. GPS alone cannot tell whether doors opened at the upstream location, whether it was a traffic queue, or whether the mapped stop coordinate is offset. The 25-metre threshold is an audit diagnostic, not a proposed new exclusion rule. Both cases meet the existing 75-metre detector definition. Calling them confirmed measurement errors would exceed the evidence.

Two further dropoff records without GPS have 50.6- and 57.5-metre closest approaches with approximately 15-second stands (3:53030:53076 and 3:17163:17224), so they deserve the same **spatially approximate** label pending inspection. The fifth has a 34.3-metre closest approach and a 25.020-second stand. A near-15-second stand is accepted intentionally by the detector's one-second cadence-jitter tolerance; it is not an arithmetic defect.

### 2. A surviving source visit does not guarantee the same resting phase

All seven selected source visits include recorded shuffles (one to four). The pinned/arrival clocks remain tied to the original visit while the bus repositions. The four source visits with raw GPS briefly reach about 80–99 metres from Winchester before their final departure. There are no separate prior Winchester visit records in the preceding 20 minutes; the evidence is consistent with one yard visit containing movement and later rest, not a duplicated or reset visit.

In source **6354** (Sep 4), the last coordinate available **as of** the synthetic matched instant has an age of only **5.030 seconds**, failing the live ten-second rest requirement. In source **29811** (Sep 10), the corresponding age is **9.983 seconds**: a cadence-boundary case, not a robust separate failure. Source 29811 supplies both target journeys, so there is **one clear mismatch and two borderline journeys**. The next fresh fixes arrive 7–20 milliseconds after these synthetic matched clocks; using the nearest poll without an availability cutoff would incorrectly give the historical calculation future data. The script preserves both measurements explicitly. The trip durations remain real; `source.departed_at > matched_time` alone cannot establish that their resting phase matches the live predicate.

The Sep 3 matched source has already held the same coordinate for about 20 seconds; the Sep 16 source for about 355 seconds. This variation should be modeled or disclosed, rather than rejecting whichever observation produces a short remaining wait. Replaying the same detector state at the matched historical instant is the principled way to enforce live-state parity, including shuffles, last movement, and stop-pin resets.

### 3. Raw archival coverage is incomplete

Five of ten journeys have matching GPS windows; five do not. The missing windows belong to three physical source visits on September 8 and 15. The corresponding local archives exist but start later that day, after these journeys; same-day capture files do not recover those intervals. Those five remain supported by connected visit/leg records, but independent checks of their GPS path, repositioning, and exact target plateau are unavailable.

Three malformed lines were found in the legacy plaintext capture files; the script records their line numbers. The complete compressed archives supply the corresponding selected September 4/10 windows. No selected journey is rejected because of those lines. Missing raw data is an evidence limitation, not proof that a short trip is wrong.

## Disposition

- **Confirmed corrupt or physically impossible selected journeys: 0/10.** No duration-based removal or quarantine is supported.
- **Structurally connected: 10/10. GPS-supported: 5/10.** The other five should retain an explicit validation limitation if used as precise evaluation truth.
- **GPS-confirmed upstream arrival proxies: 2/10**, both dropoff cases. Keep the historical journeys; mark their arrival timing as approximate. Do not use them as unquestioned exact boarding/alighting ground truth. A narrowly scoped quality flag or separate timing-sensitive evaluation stratum is justified; blanket exclusion of all short journeys is not.
- **Historical resting-state mismatch: one clear case and two cadence-boundary cases**, sharing two physical source visits. Improve matching through detector replay where GPS is retained. Do not silently reinterpret visit-survival matching as continuous stillness or use a future nearest GPS poll as if it were already observed.

Recent weighting can be applied transparently to descriptive history, but it is not a measurement-quality repair. Keep real observations visible, disclose the effective weighted sample, and avoid implying that weights create calibrated forecast probabilities. The immediate measurement priorities are a defensible stop-service arrival definition at stop 4 and parity between historical and live resting states.
