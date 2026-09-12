# The countdown's band: calibrated, floored (measured and refused), printed

2026-09-11. The operator, reading a Red card that said `in 10, 26 min` for a
bus ten minutes out and, minutes later, `in 2-9, then 17 min` once that bus
stood at 344 Winchester:

> it only shows a range for red when its at the dwell stop but earlier might
> be helpful … we should show the expected median or average to give user
> more info

Two asks: the range while the bus is still DRIVING toward a layover it has
yet to take, and the most likely time beside the range. Both are answered by
rendering the estimator's own 10-90 band (`eta/arrival.ts` `low`/`high`),
which was computed for every arrival and rendered nowhere — the row's range
came from `standWait.ts`, a second arithmetic over the stand table that could
only exist while the bus stood. Before rendering it more, it was calibrated.

## Instrument

`scripts/eta-replay/gps-replay.ts` writes `dn` (`departNow`) and `fl`
(`lowFloor`, below) beside each pair; `scripts/eta-replay/band-coverage.mjs`
scores a pairs file post hoc — the band exactly as `arrival.ts` prints it
(widened about the shown number per horizon, `widenBand`), optionally floored
— per route × horizon (by the SHOWN number, the scorecard's buckets) ×
standing (feed `at_stop`) / moving, against the detector's arrival. Two
archived days through `archive-db.ts` + `model-patch.ts` off `snap909.db`:
**9/10** (full day, 177,895 positions, 861k pairs) and **9/9** (04:35–09:46
ET, 264k pairs). Params: the served champion `fit-2026-09-09`; its
`CONFORMAL` (`0-2: 1, 2-5: 1.529, 5-10: 1.325, 10-30: 1.376`) is what
production widens by today — the note that "CONFORMAL defaults to 1 (a
no-op)" is stale, the nightly job has been posting it since 9/9.

## A. Coverage and width, today's band (served widening, no floor)

Held-out 9/10, detector truth. `cover` = share of arrivals inside the printed
band; `width` = median band width in seconds; `shown` = median printed width
in whole minutes.

| route | horizon | mode | n | cover % | width s | shown min |
|---|---|---|---:|---:|---:|---:|
| Red | 0-2 | standing | 12,660 | 67.8 | 105 | 1.5 |
| Red | 0-2 | moving | 13,308 | 32.3 | 52 | 0.5 |
| Red | 2-5 | standing | 18,656 | 90.4 | 255 | 4 |
| Red | 2-5 | moving | 17,288 | 88.2 | 232 | 4 |
| Red | 5-10 | standing | 22,567 | 85.5 | 344 | 6 |
| Red | 5-10 | moving | 15,686 | 85.2 | 296 | 5 |
| Red | 10-30 | standing | 10,224 | 87.4 | 699 | 12 |
| Red | 10-30 | moving | 4,087 | 89.5 | 822 | 14 |
| Blue Day | 0-2 | standing | 12,450 | 65.2 | 82 | 1 |
| Blue Day | 0-2 | moving | 11,805 | 34.0 | 60 | 0.5 |
| Blue Day | 2-5 | standing | 20,667 | 88.4 | 233 | 4 |
| Blue Day | 2-5 | moving | 19,230 | 82.3 | 233 | 4 |
| Blue Day | 5-10 | standing | 20,234 | 86.6 | 300 | 5 |
| Blue Day | 5-10 | moving | 8,895 | 81.4 | 262 | 4 |
| Blue Day | 10-30 | standing | 12,473 | 89.1 | 929 | 15 |
| Blue Day | 10-30 | moving | 1,861 | 89.1 | 962 | 16 |

9/9 (the other day) reads the same way: Red 2-5 83.0/79.9 (standing/moving),
5-10 76.3/77.1, 10-30 92.4/90.8; Blue Day 2-5 93.2/89.9, 5-10 89.1/84.9,
10-30 94.0/93.9. Unwidened (`w = 1`) the same cells are 56–80%, which is the
46.8% baseline the handoff quoted, measured before the widening was served.

So on the two lines riders use the served band is at or a little over its 80%
claim from 2 min out, and the width is what a rider would expect: ±2 min at
2-5, ±3 at 5-10, ±6-7 at 10-30. **0-2 min is not a band at all** — 32-34%
coverage on a moving bus with 65% of arrivals EARLIER than the band's low end
(median `det − eta` on Red moving under 2 min: −22 s, p25 −48 s). The nightly
fit asked for `w = 4.76` there and its range refused it. No band that narrow
prints anyway (below).

**No per-route or hand refit was made.** The nightly job owns `CONFORMAL`,
fits it pooled per horizon to 80% and reproduces 82-91% on Red and Blue Day
held out; a client-side table would be a second calibration the job would
overwrite the next night, and a per-route `CONFORMAL` is a schema change to
put to the operator, not to ship on two days.

## B. The floor: measured and refused

`low` degenerates: after #119's clamp shifts the band down with the held
number it is floored at zero, and on the operator's 2026-09-10 case it read
0 s for twelve consecutive polls — `now-8 min` for a bus 595 m away. The
handoff asked for `low` floored at `departNow`. Measured, two floors, same
days, same widening (coverage %, standing / moving):

| floor | Red 2-5 | Red 5-10 | Red 10-30 | Blue 2-5 | Blue 5-10 | Blue 10-30 |
|---|---|---|---|---|---|---|
| none (today) | 90.4 / 88.2 | 85.5 / 85.2 | 87.4 / 89.5 | 88.4 / 82.3 | 86.6 / 81.4 | 89.1 / 89.1 |
| `departNow` (τ = 0.5 of the rest-less chain) | 47.9 / 31.6 | 53.4 / 36.0 | 63.2 / 37.5 | 42.4 / 30.5 | 55.0 / 31.5 | 73.5 / 51.9 |
| `lowFloor` (q10 of the rest-less chain) | 82.7 / 75.3 | 82.6 / 78.4 | 84.2 / 79.8 | 79.3 / 67.8 | 82.3 / 72.9 | 86.6 / 80.7 |

(9/10; 9/9 agrees: `lowFloor` costs Red 2-5 83.0 → 76.6, Red 10-30 92.4 →
71.2, Blue 5-10 89.1 → 87.3.)

- **`departNow` cannot be a floor.** For a moving bus there is no rest to
  remove, so `departNow` IS `eta` and the floor deletes the lower half of
  every moving band. For a standing bus it is a median, and the truth beats it
  on 35-60% of pairs. Refused.
- **The rest-less chain's q10 is the floor the model itself implies** — the
  lead chain is that chain plus a non-negative residual, sample for sample,
  so in the model `low` cannot honestly be below it. In the world it costs
  3-13 points of coverage at every horizon, because the truth arrives before
  even that q10 on 7-18% of pairs from 2 min out (41% under 2 min): the
  rest-less chain prices the stands ahead at pooled medians and is
  pessimistic where a bus takes them short (the stand estimate is the known
  dominant defect). Refitting the widening with the floor in place buys the
  coverage back only by widening — pooled 5-10 `w` 1.325 → 1.916, Blue Day
  2-5 → 3.36 — i.e. wider bands for the same promise. Refused as a rule.

`lowFloor` is **served on `StopArrival` / `UpcomingArrival` and NOT
enforced**, so the replay can keep scoring it (`band-coverage.mjs --floor
fl`) after the stand estimate moves; the right fix for the chain's low end
is the chain's pessimism, not a floor on its band.

**But a STANDING bus cannot beat its own stand, and coverage cannot see
that.** A too-low low end never costs coverage, so neither measurement above
could refuse `now` for a bus standing three hops out — and that is what the
first cut of the display printed (`in 4 (now-10), 17 min` for #304 standing
at 344 Winchester), a regression against today's card, whose `in 2-9` came
from standWait's own low: `departNow` + the q10 of what is LEFT of the
stand, a number the bus must at least stand and then drive. So the DISPLAY
keeps that floor for a standing pinned bus (`etaBand.ts`
`standingLowFloor`; the card now reads `in 4 (2-10), 17 min`) and leaves a
moving bus's band as measured, where `departNow` is `eta` and any floor
deletes the band. Standing-only coverage with that floor, re-measured on the
same days (`--floor sl`):

| standing pairs, 9/10 | Red 2-5 | Red 5-10 | Red 10-30 | Blue 2-5 | Blue 5-10 | Blue 10-30 |
|---|---|---|---|---|---|---|
| band as measured (cover % / early %) | 90.4 / 2.7 | 85.5 / 2.2 | 87.4 / 2.7 | 88.4 / 5.1 | 86.6 / 3.7 | 89.1 / 0.3 |
| + standing floor `departNow + q10 stand left` | 46.4 / 46.8 | 51.0 / 36.7 | 59.8 / 30.2 | 41.5 / 52.0 | 52.7 / 37.7 | 70.5 / 19.0 |
| median printed width, min | 4 → 2 | 6 → 3 | 12 → 7 | 4 → 2 | 5 → 3 | 15 → 11 |

9/9 agrees (standing, cover % before → with the floor): Red 2-5 83.0 → 41.4,
5-10 76.3 → 41.3, 10-30 92.4 → 31.4; Blue Day 2-5 93.2 → 51.1, 5-10 89.1 →
67.0, 10-30 94.0 → 90.9.

**The premise does not survive the measurement.** `departNow` is the MEDIAN of the rest-less chain, not a minimum drive: the detector's arrival comes BEFORE `departNow + stand q10` on 43-52% of standing pairs, so the floor is not "a low end no bus can beat" — it is a low end about half of them beat, and it halves standing coverage. The reason is the one §B already found: the chain prices the drive and the stands ahead at pooled medians, and a bus that just finished a stand tends to run ahead of them. The floor is shipped as reviewed (`standingLowFloor`, one call in `arrivalBand`), with this table beside it; on the numbers it should be switched off until the chain's median is a floor, and `now-10` for a standing bus is the honest low end the operator's own standWait header asked for ("bounded below by now").

## C. The display rule (`web/src/etaBand.ts`)

Slot 1 prints the band, standing or moving, when its two ends print at least
**3 whole minutes** apart (`RANGE_MIN_SHOWN_MIN`). Measured, 9/10, coverage
of the PRINTED band by its printed width:

| printed width | Red st / mv | Blue Day st / mv |
|---|---|---|
| < 1 min | 61 / 19 | 52 / 25 |
| 1 min | 71 / 60 | 73 / 59 |
| 2 min | 76 / 73 | 79 / 58 |
| **3 min** | **82 / 77** | **78 / 71** |
| 4-5 min | 81 / 77 | 79 / 69 |
| 6+ min | 83 / 77 | 87 / 66 |

A band printed 3 minutes or wider holds its 80% claim (Blue Day moving is the
laggard at ~70%); a 1-2 minute band does not, and is a point wearing a dash.
Under the threshold, and for a bus at the board stop (0-0), the row is
byte-identical to before. Share of rows that print a range under the rule:
Red 2-5 min 86-89%, 5-10 and up 100%, under 2 min 5-35%.

**Wording.** Measured at 390 px in the rendered card (13 px Inter 500,
`pr-preview/eta-band/probe.mjs`; the span beside the widest pills holds
134 px by "Orange Night", 128 px by "Blue Weekend", 160+ by "Red"):

| string | px | verdict |
|---|---:|---|
| `in 10 (6-18) min` | 95 | fits every pill |
| `in 10 (6-18), then 26 min` | 150 | clips beside both widest |
| `in 6-18, then 26 min` (today's form) | 123 | fits |
| `in 23-36, then 35 min` (today, widest) | 133 | already clips beside Blue Weekend |
| `in 6-18 min · likely 10` | 129 | clips Blue Weekend by 1 px |
| `in ~10, 6-18, then 26 min` | 152 | clips |
| `in 10 min (6-18), next 26` | 149 | clips |
| **`in 10 (6-18), 26 min`** | **119** | **fits every pill — shipped** |

So `fmtBusBand`: median first, band in brackets, the second bus after a comma
with no "then" — the brackets do the grouping the word did. A median inside a
minute keeps `fmtBusRange`'s spelling (`now-6 min`). The map's board chip
prints the same three numbers without "in", the expanded card's wait leg the
same band less the walk, and `bunchDecision` reads the printed interval, so
slot 2 inside it folds to `12 (6-20) min · 2 buses` exactly as #216 decided
— measured on the rider-sim below, the fold appears on 2.8% of Red first
sights and 4.8% of Blue Day's (0.8% / 1.4% of distinct tokens), so the
second bus keeps its number on the row 95 times in 100. The canary parser
reads the new forms (`median` beside `first`).

## D. Rider-sim gate

`scripts/eta-replay/rider-sim/run.ts`, Red + Blue Day (Green and Purple as
the default hold-out), 2026-09-10 12:00–13:30 ET, the served params, both
arms from this tree's `run.ts` (which now composes the token as the client
does): **A** = master client and `fmtBusPair` tokens, **B** = this branch.
2,333 paired waits.

| | A | B | paired fixed / introduced |
|---|---|---|---|
| interval coverage (first sight, 10-90) | 75.5% | 75.7% | — |
| Red / Blue Day interval | 76.3 / 77.2 | 76.7 / 77.2 | — |
| pin wrong | 118 | 118 | 0 / 0 |
| dropped while approaching | 129 (0 declined / 129 repriced) | 129 | 0 / 0 |
| strand | 79 | 41 | 43 / 0 |
| jump ≥ 180 s | 188 | 88 | 108 / 1 |
| reversal ≥ 60 s | 362 | 190 | 200 / 15 |
| first sights printing a band | 0% | Red 80.4%, Blue Day 76.5% | — |
| first sights printing the bunched fold | 0% | Red 2.8%, Blue Day 4.8% | — |

Read it the right way round. **The estimator did not move**: interval
coverage, pin-wrong and dropped-while-approaching are identical, because
`eta`, `low` and `high` are byte-identical to master (the floor is served,
not enforced). Every strand/jump/reversal "fixed" is the INSTRUMENT reading
an interval: `parseBusEtaText` reports the smallest movement two intervals
permit, so a countdown that moves inside its printed band is drift 0, and a
bus arriving inside the printed band is not a strand. That is what a rider
reading `in 5 (3-8) min` experiences — no lurch, no broken promise — and it
is not an accuracy claim. The 15 introduced reversals and 1 introduced jump
are bands appearing and disappearing across the 3-minute threshold as the
bus approaches (a `(2-12)` head collapsing to a point), and the 43 / 0
strands are the rider-sim scoring a band whose low end reaches the arrival.
Per route the split is one-directional (Red 11/0, 20/0, 84/8; Blue Day
10/0, 58/0, 89/4).

## E. What to measure next

The 0-2 min band, moving: 65% of arrivals come before its low end, median
22 s early on Red. That is not width, it is a centre offset the pooled
horizon bias (b = +1 s at 0-2) cannot see because it pools standing with
moving. A per-mode (or per-route) 0-2 offset is one number, and it is the
bucket every rider is looking at when they decide to run.

## F. The arrival clock as a promise — "by 2:23p" (2026-09-12)

The operator, reading a card whose countdown had just become a range: *"do we
need ranges on the arrival time too? or just put latest time?"* The answer is
the latest time, and the reason is that the two numbers in the right-hand
column answer different questions. A countdown answers *how long from now*, and
for that both ends of the band matter. An absolute clock answers *do I make my
2:30* — and there only the upper end is load-bearing, because arriving early
costs the rider nothing.

**Where the number comes from.** Not `totalSec` with the board band's high end
swapped in. That would be a ceiling on the WAIT with a mean for everything
after it: `rideSec` is a sum of segment averages (`planner.ts`) and carries no
uncertainty at all, so such a "ceiling" is missed whenever the ride runs long —
which, on a line with a layover between the two stops, is most of the time.
Instead the clock is the SAME bus's own forecast at the ALIGHT stop, an
`UpcomingArrival` the estimator has already priced, whose `high` is the upper end of the band over
the whole chain with the stands in it, plus the trailing walk (deterministic,
`walk.ts`). The estimator pass that produces it is the one the card already
makes: `computeUpcomingArrivals([boardStopId, alightStopId], …)` asks for both
stops, so the alight row is in hand and no second arithmetic exists.

**`high` is NOT a q90, and must never be described as one.** The chain's own
upper quantile is the 90th percentile, but `eta/arrival.ts:779` applies
`widenBand` LAST: the upper half-width is multiplied by the learned per-horizon
`CONFORMAL` factor, which is fitted against what riders were actually shown and
targets EIGHTY percent TWO-SIDED coverage. Production serves `fit-2026-09-11` —
`{"0-2": 1, "2-5": 1.47, "5-10": 1.271, "10-30": 1.251}` — so at every horizon
this clock can print (it declines under a printed minute of margin), `high` sits
25-47% further above the median than q90 does. The direction favours the rider,
which is why it ships without a gate; but the tooltip describes only what the
number is ABOUT — arriving at the destination — and names no percentile, no
frequency, and no other figure on screen. **That sentence has been wrong
twice**: it called the number a 90th percentile (it is not), and then called it
the top of the countdown's range (that range is the BOARD stop's band; this is
the ALIGHT stop's plus the walk, which a Green card printing "in 25-36 min"
beside "by 1:00p" shows plainly). `arriveByClaims.test.ts` now forbids both
retired claims across every file that carries the prose.

**It is a fixed instant.** The seconds are decayed off `computedAtMs` exactly
as the point and the band are (report #48). For an absolute clock that has the
opposite and better effect: `nowMs + sec` comes to `computedAtMs + high + walk`
at every render, so the promise does not creep forward between polls. A rider
can look twice and read the same time.

**It declines rather than degrade** — three ways, each falling back to the
median clock the column printed before, never to a worse promise: no forecast
(walk option, future-dated plan, or a pin whose alight row is absent); a
promised instant EARLIER than the median total, which means the estimator's
chain and the planner's segment-average sum disagree and the ceiling is not one
(this also retires an elapsed promise, since `remainingSec` clamps at zero);
and anything past `RANGE_MAX_SHOWN_MIN` printed minutes beyond the median, for
the same measured reason the band caps there (Green's undecided out-and-back
branch is a 43-minute span, and a preposition does not make it usable). When
the promise would print the median's own minute the word is dropped with it.

**Drawn in exactly one place**, and the exclusions are decisions:

| surface | what it prints | why |
|---|---|---|
| trip card, right column | **"by 2:23p"** (replaces the median clock) | the operator's "the arrival time"; the column is `flexShrink: 0` and already fits future mode's wider range |
| overview map 🏁 chip | unchanged (median instant at the alight stop) | a longer chip label merges with its neighbours and stacks — the operator's "this is an eye sore"; `chipCluster.ts` records that the standing range's wider labels are what made it worse |
| Map tab stop rows | unchanged (10 px grey median clock) | that clock is a BUS reaching that stop, not the end of anyone's trip, and the row's countdown already carries the band |

**Measured on the branch (2026-09-12).** The rendered span was probed in
headless chromium at 390x844 against a staged build: the widest form
`"by 12:58p"` is **60.1 px** on a 304 px row, a single 16 px line, `nowrap`,
with `scrollWidth === clientWidth` at the span's column, the option row and the
document — no overflow and no sideways scroll. The fallback `"12:29p"` is
41.6 px. A screenshot of both branches on one page (a live Blue Weekend card
reading `by 12:15p`, the Walk card's plain `12:28p`, a Green card reading
`by 1:00p`) is committed at `services/shuttle-v2/pr-preview/arrive-by/`.

**What is NOT yet measured, and the exact recipe for it.** The decision set a
gate — *the real arrival beats the printed "by" about 9 times in 10 on the
rider-sim*. It has not been run, and two corrections to how it was framed:

- **The rider-sim is the wrong instrument for it.** The estimator is untouched
  by this change, so strands, reversals and `pessimistic120` are byte-identical
  by construction; a pass there would be a result with no mechanism behind it.
- **The promise is ONE-SIDED** (the bus arrives at or before the printed
  instant). Section A's 82-91% held-out figure is TWO-SIDED interval coverage,
  so it is not the nearest evidence for this and should not be quoted as
  though it were. The statistic that settles it is the **late share** — how
  often the arrival falls after the band's high end — which `band-coverage.mjs`
  already computes and prints, and which section A's table never recorded.

Recipe, cheap, and owed rather than skipped: one `gps-replay` with `PAIRS_OUT`
set, then `band-coverage.mjs` over those pairs, reading the late share rather
than the two-sided coverage.

**And one residual that a free machine does not fix.** Every scorer here pairs
a promise at the BOARD stop; nothing scores a promise at the ALIGHT stop, which
is what this clock makes. Measuring the promise as riders actually see it needs
a scorer BUILT, not merely a slot: pair `high` at the alight stop (plus the
walk) against the detector's arrival there. Until then, treat the in-model
claim as a claim.
