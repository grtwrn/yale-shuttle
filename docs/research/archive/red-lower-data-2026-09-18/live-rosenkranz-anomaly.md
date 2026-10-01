# Live Rosenkranz interval anomaly

Read-only follow-up, September 18, 2026. **This is a real mixture/visit-alignment issue, not a stale wire-schema interpretation. It does not block PR294's narrowly scoped Division lower-bound change, which leaves Rosenkranz unchanged.** Preserve it for the next ETA investigation.

The saved snapshot was computed at `2026-09-18T14:06:52.500Z` and served about 2.2 seconds later. Schema v2 defines the row as `[busIndex, stopId, eta, low, high, stopsAhead, estimated, departNow, lowFloor]` (`src/server/serverEta.ts:48`, `web/src/etaSource.ts:67`). Thus `[4,4,5,3,3813,1,0,5,3]` really reports **5 seconds, range 3–3,813 seconds**, for Red309's first Rosenkranz forecast. The same bus has a separate next occurrence at **3,772 seconds, range 3,255–7,585 seconds**, 30 stops ahead.

The saved 50-point first-arrival distribution is explicitly bimodal: **39 quantile points lie at 1–12 seconds; the remaining 11 lie at 3,062–4,321 seconds**. Those are quantile locations, not 50 independent historical observations or a calibrated 22% probability. The long tail is approximately a whole additional lap, not evidence that this immediate stop's hold itself lasts an hour. Neighboring next-stop42 has a normal first window of 55–222 seconds.

The live tracker names route index19 while its established rest identifies stop4 at index20, about 30 seconds into that rest. Raw GPS also reports `at_stop_id=4`. These are distinct pieces of state; “rested for30 seconds” does not mean every GPS poll was motionless.

The existing pricing mechanism explains the discontinuity:

1. The lead chain is still approaching the target from the preceding leg.
2. In `web/src/eta/arrival.ts:767`, each alternate chain computes `first = ((cur - c.leg) % N + N) % N || N`. An alternate chain already standing at the target gets **N hops**, not its current arrived occurrence.
3. When alternatives carry sufficient mass, `arrival.ts:818` takes the interval from the full mixture. The immediate lead arrival and the alternate next-lap arrival therefore enter the same first-row band. A zero-time at-stop row is separately emitted only when the **lead** itself stands at that stop (`arrival.ts:729`).

`rosenkranz-mixture-repro.mts/.json/.log` contain a small synthetic reproduction using the actual pricing functions. With 78% mass just before the stop and 22% standing at it, the first forecast is about **7.5 seconds with an upper bound1,207.5 seconds** on the synthetic four-stop ring. The approaching-only case has an upper bound below120 seconds; the at-target-only case correctly emits arrival0. The long first-row tail appears when those otherwise immediate-arrival hypotheses are mixed. This confirms the code mechanism without requiring a heavy replay. It is **not** a reconstruction of the unavailable live posterior, so the exact live alternate masses/legs remain to be traced from a warm checkpoint.

This is a known architectural path in the code—the intentionally broad interval over alternative position hypotheses—but the captured current-stop/next-lap semantic mismatch needs a dedicated regression. A mathematically valid mixture over different “next future visit” definitions is not automatically a useful interval for the same physical arrival the rider is watching.

Next work should align each hypothesis to the same physical visit, handling already-at-target versus already-passed evidence explicitly while keeping the following visit separate. Test arrival, departure, uncertain approach, repeated stops and next-lap identity with continuous warm replay. Do not fix this by hiding the large band, capping its upper end, or discarding all alternate position hypotheses. Raw at-stop UI overrides may mask some screens; trace the affected interval/distribution consumers before claiming a particular rider screen or class decision is corrected.

PR294 only changes the lower transform for stop48's first supported Winchester-to-Division forecast. Here the target is4 and the established rest is Rosenkranz, so its activation condition is false. No production/source mutation was made in this follow-up.
