# The per-horizon bias: what a number on the screen is worth

**Measured 2026-09-09.** Branch `eta/horizon-bias`. The question the operator
asked is the narrowest one there is:

> "Red in <1-8, then 36 min" … *"I just want a narrower range of when we expect
> it to arrive."*

and the measurement that motivated it — a rider-sim replay of Red on 2026-09-04,
scoring each rider's FIRST promise against the moment a bus actually reached
the curb — said the range could not simply be drawn narrower, because most of
its width was **offset**, not spread:

| horizon (as displayed) | n | the band that holds 60% of arrivals | width |
|---|---|---|---|
| under 5 min | 427 | −0:25 .. +9:42 | 10:07 |
| 5–10 min | 287 | −4:05 .. +1:11 | 5:16 |
| 10–20 min | 527 | −7:04 .. +1:00 | 8:04 |
| over 20 min | 390 | −13:33 .. +0:28 | 14:01 |

(sign: truth − promise; negative = the bus came before we said)

Three of the four bands are one-sided: the lower edge runs to −13 min while
the upper edge is within a minute of zero. If that is a horizon-dependent
over-prediction, correcting the centre re-centres the band and the same
coverage fits inside a narrower interval. This document is that investigation.

## 1. Two conditionings, two different answers

The residual can be bucketed two ways and they do not agree, so it matters
which one the correction is fitted to.

**By the PROMISE, per (bus, stop) pair** — every raw position through
`computeUpcomingArrivals`, truth is the first moment that bus's own track comes
within 45 m of that stop (`gps-replay.ts`, the same instrument and the same
truth `docs/route-bias.md` uses). 2026-09-03, the whole archived day, 606,236
pairs:

| bucket | n | median (truth − promise) | mean | sd | p20 .. p80 | width |
|---|---|---|---|---|---|---|
| 0-2 | 98,555 | **−1.0 s** | +40.6 | 243 | −16 .. +33 | 49 s |
| 2-5 | 147,446 | **+7.3** | +45.7 | 187 | −39 .. +80 | 120 s |
| 5-10 | 152,883 | **+17.6** | +57.8 | 227 | −66 .. +145 | 211 s |
| 10-30 | 148,921 | **+1.7** | −15.7 | 330 | −244 .. +215 | 459 s |

Red alone, the same day: −0.3 / +12.0 / +20.7 / +48.4 s.

**Pooled over a whole day the estimator's conditional median is already right
to about ten seconds**, and what sign there is points the OTHER way from the
rider-level table above: the bus arrives a little LATER than the screen says,
not earlier, and the effect grows with the horizon rather than reversing.

## 2. The mechanism: `HORIZON_BIAS`, and why that shape

`web/src/eta/params.ts` `HORIZON_BIAS` · `src/server/modelParams.ts` validates
and stores it · `scripts/reestimate-lib.mjs` `fitHorizonBias` estimates it ·
`web/src/eta/arrival.ts` applies it as the last step of pricing.

```
HORIZON_BIAS = { "0-2": {b, n}, "2-5": {b, n}, "5-10": {b, n}, "10-30": {b, n} }
```

`b` is the bucket's RAW median residual in seconds and `n` the pairs behind it.

- **Raw on the wire, shrunk on the client**, exactly as `q` and the diurnal
  profile are, so the estimate that is published and the estimate that is
  applied cannot drift apart. The client damps by `n / (n + k)`.
- **k is a variance ratio, not a taste**: σ²/τ², σ the per-pair spread of the
  residual inside a bucket, τ the day-to-day spread of the bucket's own
  offset. §3 measures both.
- **A monotone piecewise-linear map, not a step.** The offsets are knots at the
  bucket midpoints (60, 210, 450, 1200 s) plus the origin, forced
  non-decreasing, flat past the last knot; the correction at a promise is the
  interpolation. A step function would move a rider's number by the whole
  difference between two buckets the moment the promise crossed a boundary —
  300 s and 301 s corrected differently — which is a jump the rider sees and
  the strand metric counts. The interpolation also lets the correction VARY
  inside a bucket, which is the only way an offset can remove width rather
  than merely move it (§4).
- **Applied after the #119 floor clamp**, like the route hinge, and for the
  same reason: the map is monotone and time-invariant, so
  `f(min(prev, raw)) = min(f(prev), f(raw))` and "the shown remainder never
  climbs" survives; the floor then stores the uncorrected number, so a
  published set can change between two polls without the floor meaning
  something else. `horizon-bias.test.ts` pins that identity.
- **Degrades to exactly zero.** No key, an unparseable set, a bucket with
  `n = 0`, a promise past thirty minutes: the seconds are returned untouched,
  not multiplied by one. `applyHorizonBias` returns its argument by identity
  when nothing is published.

## 3. The fit, and the shrinkage constant read off the data

Fitted on **2026-09-03**, the whole archived day, 606,242 pairs
(`fitHorizonBias`, truth = proximity), and held out on **2026-09-04**
(`snap-0904-2205.db`, 15:51–22:04 ET, 226,057 pairs) which the fit never saw:

| bucket | 9/3 raw b | n | sd | 9/4 raw b (the check) | n |
|---|---|---|---|---|---|
| 0-2 | **−1.2 s** | 99,017 | 222 | −0.3 | 36,142 |
| 2-5 | **+6.0** | 146,688 | 200 | +8.6 | 52,522 |
| 5-10 | **+15.8** | 152,735 | 228 | +21.6 | 55,883 |
| 10-30 | **−3.4** | 148,895 | 330 | +14.5 | 55,418 |

`k = σ²/τ²`: σ is the pooled within-bucket spread, **250 s**; τ is the
day-to-day spread of the bucket's own offset, taken from the two days above as
the rms of their per-bucket difference over √2, **6.7 s** (the estimation noise
inside it is σ/√n ≈ 0.7 s, so it is real day-to-day movement). **k = 1,390
pairs.** At a day's sample that damps by under a percent; a bucket measured on
a thousand pairs is pulled halfway back to no correction. τ mixes a whole day
with an evening, so it carries the day-part difference `docs/route-bias.md` §8
warns about, and the shrinkage errs toward doing less.

## 4. Held out: the correction is real, tiny, and does not narrow anything

`gps-replay` on 9/4, the published set against the champion, every route:

| bucket | n | median \|err\| | median bias | 10–90 coverage |
|---|---|---|---|---|
| 0-2 | 36,142 | 16.0 → **15.9 s** | +0.3 → **+0.1** | 70.5 → **71.3%** |
| 2-5 | 52,522 | 39.4 → 39.8 | −8.6 → **−3.1** | 81.6 → **82.8%** |
| 5-10 | 55,883 | 70.7 → **69.0** | −21.6 → **−8.8** | 82.9 → **83.3%** |
| 10-30 | 55,418 | 151.0 → **150.9** | −14.5 → **−8.8** | 75.8 → 75.1% |
| **pooled** | 199,965 | **55.7 → 54.9** | **−8.0 → −3.3** | **78.4 → 78.8%** |

Correctly signed, held out, and worth **0.8 s of median |error|**.

**And it does not make the band narrower, because an offset cannot.** The
edges of a residual band are quantiles of `truth − promise`; adding a constant
to the promise moves both edges by the same amount and the width is
unchanged. Only a correction that VARIES with something inside the bucket
removes width — which is why the map is interpolated rather than stepped — and
on this feed the variation it finds is a few seconds. Fixing the coverage
target and asking how wide the shown band must be to reach it (split
conformal, fitted on 9/3, scored on 9/4):

| bucket | factor raw → corrected | median band width | coverage |
|---|---|---|---|
| 0-2 | 1.283 → 1.257 | 93 → **94 s** | 80.4 → 80.4% |
| 2-5 | 1.000 → 0.979 | 159 → **162 s** | 81.6 → 82.0% |
| 5-10 | 0.987 → 0.990 | 319 → **323 s** | 82.5 → 83.0% |
| 10-30 | 1.061 → 1.083 | 750 → **752 s** | 77.9 → 78.0% |

**Same coverage, one to four seconds WIDER.** The operator's ask — the same
coverage from a narrower range — is not answered by re-centring, on this feed,
at any horizon.

## 5. Where the width actually is: the app is counting down the wrong bus

The rider-level table this began with is reproduced here on `origin/master`
(e1435ad) — rider-sim, Red, 2026-09-04, `cap-et-0904.jsonl`, uniform
population, 1,705 waits and **1,466 scored first sights** — and then split by
whether the vehicle the app had PINNED is the vehicle that actually reached
the curb:

| displayed | all (n) | band | width | **pinned bus arrived** (n) | band | width | another bus first (n) | band | width |
|---|---|---|---|---|---|---|---|---|---|
| under 5 | 394 | −0:37 .. +1:08 | 1:46 | **359** | −0:35 .. +1:00 | **1:35** | 35 | −1:55 .. +12:44 | 14:39 |
| 5–10 | 363 | −1:25 .. +1:55 | 3:20 | **340** | −1:10 .. +1:51 | **3:01** | 23 | −4:55 .. +7:38 | 12:33 |
| 10–20 | 457 | −2:41 .. +2:29 | 5:10 | **382** | −1:59 .. +2:29 | **4:28** | 75 | −11:20 .. +2:16 | 13:36 |
| over 20 | 252 | −15:28 .. +3:05 | **18:33** | **177** | −1:36 .. +3:23 | **4:59** | 75 | −17:49 .. −8:12 | 9:38 |

Medians on the pinned-bus rows: **+0:10, +0:00, +0:09, +1:14**.

**The magnitudes in the opening table did not reproduce on master**, and that
is worth saying before anything is concluded from either. On this run the
under-5 band is 1:46 wide against the 10:07 quoted, the 5–10 band is centred on
zero rather than 4 minutes early, and the early/late split of the first promise
is 23.3% / 25.3% rather than 43.9% / 16%. Same instrument, same day, same
capture; a different tree and probably a different scored population (1,466
first sights here). The shape that survives is the over-20 bucket's long early
tail — and the split below is what it is made of.

**When the app counts down the bus that turns up, the band is centred within
about a minute at every horizon and its width does not blow up with the
horizon** — 1:35 / 3:01 / 4:28 / 4:59. The one-sidedness, and three quarters
of the width in the "over 20 min" bucket, live entirely in the **14% of waits
(208 of 1,466) where a DIFFERENT bus of the line reached the stop first**; at
over-20 that is 30% of the waits, with a median of **−15:30**.

So the wide, one-sided range is not a horizon-dependent error in the number.
It is the app naming the wrong vehicle: `stableOptions` holds the bus the trip
was planned against (`o.busName`, the plan-time pin, re-read every poll), and a
rider who opens the app twenty minutes out keeps counting that bus down while
another one of the line arrives first. A per-horizon offset fitted to THAT
residual would move the 86% of promises that are already right in order to
chase the 14% that are wrong for a different reason, and it would have to be
minutes wide to do it.

**This is the lever, and it is not this branch's.** It is the same family as
the tracked `pinChanged` / `droppedApproaching` metrics, and the next
measurement it wants is whether the bus that actually arrived was already on
the payload, with a smaller ETA, at the poll the rider first looked — a
selection defect — or was not yet visible at all, which nothing can fix.

## 6. The gate

**`npm run typecheck` ✅ · `npm test` 2,216 in 83 files ✅ · `npx vite build` ✅**

### The default is byte-identical, proved rather than argued

`gps-replay` on 9/4 from a second worktree at the branch point (e1435ad,
unmodified) and from this branch with nothing published:

```
48b9d322870471b910080a13e6390e49  horizon-base .../base/pairs.jsonl        (e1435ad)
48b9d322870471b910080a13e6390e49  horizon .../g0904champ/pairs.jsonl       (this branch, no set)
155c550a7ec26a5d5437da518f9a919c  horizon .../g0904cand/pairs.jsonl        (this branch, fitted set)
```

**The same md5 over 226,057 pairs**, and the two `gps.json` metric files are
equal on every leaf but `generatedAt`. The third line is the A/B check the
other way: the published set does reach the arithmetic.

### rider-sim, paired, Red

Same capture (`cap-et-0904.jsonl`), same snapshot, same population
(`ROUTES=Red POP=uniform`, 1,972 riders), the arms differing only in
`MODEL_PARAMS`; `pair-by-route.mjs` over **1,693 paired waits**:

```
6ffc6d98efa7aa03f2282a0a0bc3f9b5  champ0904.waits.jsonl
28f8be4454e0a6db87fc28966bc907dd  cand0904.waits.jsonl
route            n            strand       jump>=180        reversal         dropped
                      fixed/intro     fixed/intro     fixed/intro     fixed/intro
Red             1693               0/0            8/12           12/22             0/0
```

**Strands do not rise** (0 fixed, 0 introduced; 1.3% of riders on both arms).
The correction costs a net 4 jumps ≥180 s and 10 reversals ≥60 s on 1,693
waits, and the first-promise |miss| median goes 56 → **60 s** (p90 517.5 →
522). Per bucket, the rider-level band:

| displayed | n | 60% band, champion | 60% band, corrected | width | interval coverage |
|---|---|---|---|---|---|
| under 5 | 394/385 | −0:37 .. +1:08 | −0:40 .. +1:08 | 1:46 → **1:48** | 74.4 → 75.3% |
| 5–10 | 363/353 | −1:25 .. +1:55 | −1:43 .. +1:30 | 3:20 → **3:13** | 79.3 → 80.2% |
| 10–20 | 457/471 | −2:41 .. +2:29 | −2:50 .. +2:30 | 5:10 → **5:19** | 77.7 → 76.2% |
| over 20 | 252/248 | −15:28 .. +3:05 | −15:36 .. +3:07 | 18:33 → **18:42** | 60.3 → 59.7% |

Mixed by ten seconds in either direction on bands three to eighteen minutes
wide. **Nothing narrows.**

## 7. The other fit: the operator's reading, taken at face value

The table in §5 is a distribution of `truth − promise` at the rider level, so
fit the correction to THAT instead — the same estimator, the same shrinkage,
but the residual is a rider's first promise against the first bus of the line
to reach their stop. Fitted on the 9/3 rider-sim (1,165 scored first sights,
`positions-20260903.jsonl`), held out on 9/4:

| bucket | b | n |
|---|---|---|
| 0-2 | +4.8 s | 125 |
| 2-5 | 0.0 | 222 |
| 5-10 | +15.2 | 310 |
| 10-30 | **−43.2** | 508 |

**Even fitted on the rider's own truth the correction is 43 seconds, not
minutes** — because the operator's numbers are the band's EDGES and this is
its middle. The over-20 bucket's median on 9/4 is −0:25 while its 20th
percentile is −15:28: the distribution is not displaced, it is skewed, and
§5 says by what.

Its cost, held out on the 9/4 pairs: pooled median |error| 55.7 → **55.8 s**,
bias −8.0 → −7.9, and the 10-30 bucket it is aimed at gets **worse** on both
(151.0 → 152.5 s, −14.5 → −19.2).

Its rider-level gate, paired against the same champion (`227f472f…` against
`6ffc6d98…`, 1,697 paired waits):

```
route            n            strand       jump>=180        reversal         dropped
                      fixed/intro     fixed/intro     fixed/intro     fixed/intro
Red             1697               7/0           13/18           14/23             0/0
```

**Seven strands fixed and none introduced** (1.3% → 0.9% of riders) — the one
genuine rider-visible gain anything in this document produced, and it comes
from making the far number smaller so the collapse at the end is smaller. It
costs a net 5 jumps ≥180 s and 9 reversals ≥60 s, the first-promise |miss|
median is unchanged at 56 s (p90 517.5 → 525.9), and the interval coverage goes
74.2 → 73.9%. The band:

| displayed | n | width, champion → corrected | interval coverage |
|---|---|---|---|
| under 5 | 394/392 | 1:46 → **1:46** | 74.4 → 74.0% |
| 5–10 | 363/361 | 3:20 → **3:20** | 79.3 → 79.8% |
| 10–20 | 457/457 | 5:10 → **5:10** | 77.7 → 77.2% |
| over 20 | 252/248 | 18:33 → **18:35** | 60.3 → 59.3% |

**Not one second.** Fitted to the rider's own residual, held out, applied
through the rider's own instrument, the band is the width it was. That is §4's
arithmetic showing up at the rider level: the correction moves the middle, and
the width is not made of middle.

## 8. What ships, and what does not

**The mechanism ships. The values do not.** `HORIZON_BIAS` is present on the
wire, validated on both sides, fitted and guarded by the nightly job, and every
bucket is zero — a payload without the key and a payload with the compiled
cells both price byte-identically to master (§6). Nothing is posted to
`/api/model-params`.

That is the same disposition `ROUTE_SCALE` got in `docs/route-bias.md` §5 and
for a better reason: there the fit was refused because the rider simulator said
it cost strands; here it is refused because **it does not buy the thing it was
built to buy.** The correction is real, correctly signed and held out, and it
is worth 0.8 s of pooled median |error| against a p20–p80 spread of 49 to
459 s. A rider cannot see 0.8 s.

**The one result that deserves a follow-up is §7's seven strands.** The
rider-fitted set fixed seven and introduced none, which is the only
rider-visible gain in this document, and it did it by making the far number
smaller so the collapse at the end is smaller. That is a claim about the SHAPE
of the far promise, not about its bias, and it should be chased as such — on
more than one day, on more than Red, and against the pin (§10.1) which is the
same phenomenon seen from the other side. Publishing this set to get it would
be publishing a correction fitted to 508 first sights, whose other three
buckets do not clear the sample floor, and which measurably worsens the
estimator's own accuracy. Not that way.

The guards that go with it, so a future day with more evidence can publish it
without a second argument:

| guard | value | why |
|---|---|---|
| sample floor | 500 pairs in the bucket | below it the shrinkage would damp the number to nothing anyway; the floor makes the refusal auditable |
| range | ±600 s on the raw offset | ten minutes is far outside any honest re-measurement of this feed |
| held-out day | the bucket's own median \|err\| must not get worse | one bucket's refusal never touches another's |
| shrinkage | `n / (n + 1390)` on the client | §3 |

## 9. Reproducing

```bash
cd services/shuttle-v2
# the fit day, whole (an archived day rebuilt by archive-db.ts)
TZ=America/New_York REPLAY_DB=./store/r0903.db PAYLOAD_PATCH=./scripts/.eta-replay/patch-0903.json \
  REPLAY_OUT=./scripts/.eta-replay/fit0903 PAIRS_OUT=./scripts/.eta-replay/fit0903/pairs.jsonl \
  npx tsx scripts/eta-replay/gps-replay.ts
# the held-out day, champion and challenger (MODEL_PARAMS is the published set)
... REPLAY_DB=./store/snap-0904-2205.db PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0904.json ...
# the rider gate, one arm at a time
TZ=America/New_York REPLAY_DB=./store/snap-0904-2205.db PAYLOAD_PATCH=... \
  CAPTURE=$HOME/shuttle-captures/cap-et-0904.jsonl ROUTES=Red HOLDOUT=Red CHAIN=none POP=uniform \
  OUT_NAME=champ0904 npx tsx scripts/eta-replay/rider-sim/run.ts
node scripts/eta-replay/rider-sim/pair-by-route.mjs .../champ0904.waits.jsonl .../cand0904.waits.jsonl
```

`fitHorizonBias`, `horizonBiasEffect`, `horizonCurve` and `applyHorizonBias`
are exported from `scripts/reestimate-lib.mjs`, and
`reestimate-lib.test.mjs` pins the last two equal to the client's own map knot
for knot, so a fit and an applied correction cannot mean different things.

## 10. What this does not answer

1. **The pin.** §5. The measurement it wants next: when a rider's wait ends
   with a bus other than the pinned one, was that bus already on the payload,
   with a smaller ETA, at the poll the rider first looked? That splits a
   selection defect from a bus that was not yet visible, and only the first is
   fixable.
2. **The over-20 bucket is not a bucket the pairs can see.** `gps-replay`
   scores the next 1–5 stops, so a promise past twenty minutes is rare in it
   (13,358 of 226,057 pooled, 145 on Red) while a quarter of rider first sights
   are there. The two instruments do not cover the same population at the long
   end, and the rider-level one is the one that matters for this ask.
3. **Two days of τ.** §3's shrinkage constant is a variance ratio measured
   across one whole day and one evening. It is the right shape and the right
   order of magnitude; the loop will sharpen it as the archive fills.
