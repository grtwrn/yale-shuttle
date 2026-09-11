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
fl`) after the stand estimate moves; the right fix for the degenerate zero is
the chain's pessimism, not a floor on its band. The display prints the median
beside the band, so the degenerate case now reads `in 4 (now-10) min` rather
than a bare `now-10 min` — wrong at one end, no longer silent about the
middle. (That is the standing screenshot in `pr-preview/eta-band/`: #304
standing at 344 Winchester, three hops from the stop.)

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
— note that with calibrated 6-14 min bands past 5 min this fires far more
often than it did on standing-only ranges (measured in the rider-sim gate,
in the PR). The canary parser reads the new forms (`median` beside `first`).

## D. What to measure next

The 0-2 min band, moving: 65% of arrivals come before its low end, median
22 s early on Red. That is not width, it is a centre offset the pooled
horizon bias (b = +1 s at 0-2) cannot see because it pools standing with
moving. A per-mode (or per-route) 0-2 offset is one number, and it is the
bucket every rider is looking at when they decide to run.
