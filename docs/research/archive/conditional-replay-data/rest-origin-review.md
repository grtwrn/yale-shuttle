# Rest-origin audit: four Winchester visits

**Three differences reflect substantial real waiting before the 75 m stop boundary; one is a reproducible restart-related truncation of the stored visit. None of the four supports resetting the rider's waiting clock to the late pin.** The current model nevertheless conditions a pinned-duration table with a broader rest clock, which is not the same statistical quantity. Repairing the truncated data and aligning the model's duration definition are separate tasks.

This is a targeted audit of IDs 59602, 59805, 65237, and 66278, not an estimate of how common such cases are. [rest-origin-review.py](rest-origin-review.py) exports the raw GPS plateaus, recorded clocks, inbound legs, legacy arrivals, and actual watcher evidence to [rest-origin-review.json](rest-origin-review.json). [rest-origin-replay.mts](rest-origin-replay.mts) reproduces the restart case with the actual reducers; its [output](rest-origin-replay.json) retains both continuous and restarted results. No application files, database records, or production models were changed.

## What the GPS actually shows

Times are Eastern. A plateau means repeated identical provider coordinates at successive fresh collection times; motion within the feed's spatial deadband is unobserved. These lengthy plateaus, plausible intervening movements, and correct stop sequence support genuine waiting rather than invented elapsed time.

| Stored source visit | Bus, date | Live rest origin → stored pin | Longest recorded plateau | Stored pinned→departure | Live origin→same departure |
|---|---|---|---|---:|---:|
| 59602 | #309, Sep 16 | 12:55:20 → 13:00:40 | 230 s, 137 m from stop | 165 s | 485 s |
| 59805 | #308, Sep 16 | 13:19:11 → 13:28:11 | 485 s, 140 m from stop | 200 s | 740 s |
| 65237 | #316, Sep 17 | 10:38:41 → 10:45:25 | 335 s, 9 m from stop | 35 s | 439 s |
| 66278 | #309, Sep 17 | 12:51:15 → 12:59:15 | 385 s, 142 m from stop | 120 s | 600 s |

**59602, 59805, 66278:** the bus waits outside the 75 m pin radius, then moves to the marker and waits/repositions again before leaving. Their stored pin and duration are consistent with the narrower definition. They are not erroneous merely because their remaining pinned hold is short. For 59805 and 66278, however, the filter's retained origin precedes the first sustained plateau by approximately 35 and 30 seconds: those seconds include roll-in, not stationary dwell. The appropriate broad quantity is an observed service episode, not literally “seconds motionless.” The GPS does not establish how much of the off-marker wait is scheduled layover, a queue, or another operational cause.

`filter.ts:799–834` deliberately keeps an existing layover rest when it closes from the approach zone into the marker, preserving the earliest rest origin. This avoids charging a second whole layover upon reaching the marker. `departure.ts:47–58` instead defines the pin and first resting plateau within 75 m; the earlier stop belongs to the inbound leg. These are different partitions of the same elapsed journey.

## 65237: a concrete duration error, reproduced

This bus was already inside the stop boundary at **10:38:41.359**, then held at a coordinate 9 m from the stop from **10:39:21 to 10:44:56**. It repositioned at 10:45:01. After a **24.436 s** gap, the next collected fix was 10:45:25.854; the bus remained within the stop area and refroze through 10:46:00.839.

Independent stored evidence agrees:

- Inbound **leg60404** reaches Winchester at 10:38:41.359, with `to_pinned_at` at that same instant.
- Legacy **arrival716559** begins at 10:38:26.550 and remains open. Another same-bus, same-stop **arrival716638** begins at 10:45:25.854; other Red buses also create new legacy arrivals at this exact instant. This is strong evidence of a collector restart/re-anchor, rather than a new lap. No deployment log was required to infer the observation discontinuity.
- Actual `watcher17.jsonl` payloads preserve `stationary_since=10:38:41.359` before and after the interruption. This is not merely a clock invented by the continuous replay.
- The stored modern visit begins at the second arrival and records only **30.011 s of plateau-to-departure**, or **34.985 s pinned-to-departure**. It omits approximately 6 minutes 45 seconds of the already observed visit.

The mechanism is explicit in code. `seedStationaryFromHistory` correctly returns the earlier pin and first rest, but `restSince=null` because the restart's current fix is fresh. `collector.ts:1075–1079` then skips `resumeArrival`. `departure.ts:401` consequently does not resume the old visit. A fresh fix can be an ongoing shuffle or departure candidate; it is not evidence that the earlier visit never happened.

The bounded reproduction resets the reducers exactly at the first post-gap fix and uses the production seed branch. It reproduces **all 18 checked stored visit fields exactly**, including clocks, 30.011 s duration, zero shuffles, and departure evidence, plus the 49.962 s duplicate legacy dwell. The same observations processed continuously produce **439.480 s** for the visit and three shuffles, with the **same final departure instant**. That is concrete causal evidence of truncation, not an outlier-removal judgment.

The raw full-path replay intentionally carries state across this short gap; therefore its source65237 “pin +0” evaluation checkpoint is actually about 404 seconds into the observed service episode. The target arrival and outgoing chain can remain useful, but that checkpoint must not be interpreted as a freshly arriving bus. The fixed prior table predates this September 17 record, so this example does not itself explain the candidate's trained coefficients.

## Principled production alignment

**First repair restart completeness, independently of ETA tuning.** Preserve or reconstruct the entire detector/visit state from a causal raw prefix, including the prior resting plateau and any pending departure candidate. Replaying the same reducers from a trusted checkpoint or a sufficiently early connected observation prefix is preferable to simply removing the fresh-fix guard. A genuine departure immediately after restart must keep its original candidate endpoint; treating every fresh fix as a continued stationary state would delay departures. Replayed historic events must be reconciled by identity rather than reinserted, and unobserved gaps must remain incomplete. Add a regression for this exact fresh-fix case plus genuine departure, route/ID change, and a gap that must not be joined.

Flag this stored duration as **left-truncated** for fitting and empirical residual-hold comparisons until an audited derived replacement exists. Retain the original record, raw positions, provenance, valid departure endpoint, and outgoing travel observation. A short value by itself is not an exclusion rule. Earlier unclosed same-stop arrival + incompatible inbound pin + continuous raw evidence is a defensible repair signal; absence of an inbound leg alone is insufficient.

**Then choose one duration definition and use it consistently in training and serving.** Two defensible architectures exist:

1. Keep the current leg/pinned-stop partition. Price off-marker waiting as part of the inbound phase, and condition the remaining pinned hold on how much pre-pin waiting has already occurred, along with lap/progress. Do not subtract off-marker minutes directly from a pinned-duration CDF. This requires a joint or stage-conditioned model because pre-pin and post-pin waits may trade off.
2. Define a causal layover service episode spanning the attributed approach rest through confirmed departure. Reconstruct and version the same episode origin used at forecast time, fit its total duration, and use its elapsed time for survival. Remove the corresponding waiting contribution from inbound-leg pricing so it is not charged twice. This is broader than replacing a timestamp: uncertain approach attribution, initial roll-in, pass mass, and confirmed departures all need consistent handling.

The second fits the present rider clock's intent; the first fits the existing statistical tables. Neither should be implemented as an arbitrary `min(pin, anchor)` rule. The origin must be established from observations available by that forecast, not retrospectively from which earlier pause eventually turned out to precede a stop. Uncertain or incomplete origins should use an explicit fallback or be retained as censored/incomplete training observations, not relabeled as full short holds.

A new production implementation should log episode ID, origin, origin-definition version, first-known-at time, stop/approach phase, and completion/confirmation time. This makes as-of joins and temporal validation possible. This review identifies a reproducible path to alignment; it does not establish that changing the live tracking clock would improve accuracy.

## Scope decomposition follow-up

I checked the new current-only and future-only score artifacts at the same 600 s warm cutoff. Current-only pricing preserves the Winchester +60/+180 gains while leaving Union near baseline; future-only reproduces the longer Union bias (departure MAE **212.5→266.0 s**, median error **171.7→239.6 s**). This usefully localizes the bias to future terms. The current-only switch also raises Division upward jumps above 60 s from **16 to 76**, so it is a diagnostic, not a deployable fix.

Sample-wise future lap conditioning is a defensible next experiment: earlier simulated arrivals can receive a longer regulated hold and later ones a shorter hold. It must use only as-of departure clocks, preserve stop/pass mass, and handle uncertain projected lap outside support. The four-case clock audit remains relevant: sample-wise dependence cannot correct a duration whose origin is defined differently from the data. Do not infer guaranteed narrower or safer intervals before full-path scoring.
