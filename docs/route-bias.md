# The per-route bias: decomposed, and what of it was real

**Measured 2026-09-08.** The 9/4 gps-replay (226,052 pairs, 205,061 with a
proximity truth) and the 9/3 archive replayed whole (606,236 pairs), both
through `computeUpcomingArrivals` — the ring estimator riders run. Branch
`eta/route-bias`. Everything below is on the replay's **proximity truth** (the
first moment the bus's own track comes within 45 m of the stop) unless it says
otherwise; §4 is about why that qualifier matters more than anything else here.

`docs/display-quantile-sweep.md` §9 ended: *"A single global quantile is being
asked to absorb a per-route bias that ranges from −55 s (Pink) to +113 s
(Green). Fixing that bias per route is worth more than any τ in this sweep."*
This is that investigation. The short of it:

| route | the sweep said | what it is |
|---|---|---|
| **Green** | +113 s, the worst line by far | **not a bias.** Three hops of the repaired ring had no measured drive and priced 21 km of a 29 km lap from the route pace. Give the same replay the drives production had measured by 09-08 and the same day reads **−6.2 s**. Nothing to correct; it corrected itself. |
| **Pink** | −55 s, the most consistently early | **real, and structural.** Pink's published stop list flattens an out-and-back: it names twelve stops for a lap on which the bus passes eighteen. The adjacency times the calibrator can measure sum to 86% of the lap and the served tables to 82%, so every promise that spans the fold is short in proportion. |
| the other ten | −28 to +6 s | a smaller version of the same thing on the other folded lines, and — for a third to a half of the spread — **not the estimator at all** but the route-specific gap between two definitions of "arrival" (§4). |

What shipped is a per-route **scale**, learned through the closed loop's
`model_params` path, defaulting to 1 on every route and refused wherever the
diagnosis says the shortfall is a hole that is still filling.

---

## 1. The decomposition

`gps-replay`'s `PAIRS_OUT` now carries the proximity truth, the target stop,
the poll's clock, the dwell bin and whether the client's own lead leg agreed
with the detector, so the error can be cut by anything without re-running.
9/4, 15:51–22:04 ET, 205,061 scored pairs, error = promise − truth (positive =
we promised later, the bus beat the promise).

### Per route

| route | n | median bias | mean | median \|err\| | p90 | pess ≥120 s | opt ≥120 s | within 120 s |
|---|---|---|---|---|---|---|---|---|
| Blue Day | 12,274 | **+6.2** | +12.9 | 35.3 | 158 | 7.8% | 6.3% | 85.9% |
| Orange Day | 13,982 | +3.8 | +23.4 | 28.1 | 110 | 5.0% | 3.6% | 91.5% |
| Red | 20,972 | −19.7 | −37.3 | 47.5 | 255 | 4.8% | 19.0% | 76.3% |
| Pink | 19,061 | **−54.9** | −104.1 | 106.1 | 455 | 9.4% | 36.4% | 54.2% |
| Green | 22,611 | **+113.1** | +296.3 | 191.3 | 643 | 49.1% | 11.3% | 39.6% |
| Purple | 27,102 | −0.4 | +68.4 | 102.9 | 664 | 25.3% | 22.0% | 52.7% |
| Blue Night | 22,973 | −20.5 | +7.3 | 70.8 | 225 | 13.1% | 18.8% | 68.1% |
| Orange Night | 28,068 | −18.9 | −29.9 | 39.4 | 129 | 3.0% | 9.1% | 87.9% |
| Gold | 6,018 | −27.9 | −46.2 | 55.4 | 220 | 7.4% | 20.9% | 71.7% |
| Blue West | 12,037 | −16.5 | −33.4 | 47.5 | 196 | 4.5% | 16.6% | 78.9% |
| Orange East | 11,656 | −19.9 | −24.6 | 48.1 | 193 | 3.5% | 16.5% | 80.0% |
| Brown | 8,307 | −28.0 | −70.1 | 79.3 | 517 | 12.7% | 27.4% | 60.0% |
| **pooled** | 205,061 | **−7.7** | | 59.5 | 393 | 14.0% | 17.1% | 68.9% |

(The sweep's table, reproduced from this branch to the tenth of a second — the
`PAIRS_OUT` extension changes nothing that is priced.)

### By hops ahead — the shape that decides everything downstream

Median signed bias, k = 1..5 stops ahead:

| route | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Blue Day | +4.5 | +2.7 | +7.0 | +14.5 | +19.1 |
| Orange Day | +4.7 | +3.1 | +2.8 | +1.8 | +5.8 |
| Red | −4.9 | −13.9 | −22.4 | −30.0 | **−40.6** |
| Pink | −32.2 | −44.4 | −53.7 | −96.0 | −66.8 |
| **Green** | +35.0 | +32.2 | **+143.1** | **+175.1** | **+252.0** |
| Purple | +7.7 | −1.5 | +0.2 | −19.6 | −19.6 |
| Blue Night | −4.8 | −23.2 | −32.3 | −46.7 | −16.1 |
| Orange Night | −4.6 | −13.8 | −24.6 | −30.8 | **−40.7** |
| Gold | −22.2 | −27.0 | −26.6 | −29.9 | −33.1 |
| Blue West | +5.6 | −4.7 | −20.6 | −39.4 | −38.1 |
| Orange East | +0.9 | −19.9 | −20.9 | −43.2 | −40.3 |
| Brown | −12.6 | −23.4 | −29.4 | −50.5 | −70.7 |

**The bias grows with the chain on every route that has one.** That is the
signature of a per-hop deficit in the DRIVE/STAND budget, not of a stand at
the current stop and not of an anchor that jumps: an anchor error is a step,
and a stand error is flat in k. Conditioned on the TRUE remaining time — which
does not select on our own noise, as bucketing by the promise does — the same
thing reads as a fraction:

| route | true 0–2 min | 2–5 | 5–10 | 10–30 | as a share of the 10–30 midpoint |
|---|---|---|---|---|---|
| Red | +7.6 | −2.7 | −50.9 | −160.9 | −13% |
| Pink | +18.3 | −0.2 | −47.7 | −153.5 | −13% |
| Orange Night | +2.5 | −10.3 | −52.8 | −116.2 | −10% |
| Blue Night | +6.2 | −2.2 | −30.8 | −111.4 | −9% |
| Gold | +5.5 | −14.0 | −25.5 | −82.2 | −7% |
| Blue West | +11.7 | +8.2 | +7.7 | −87.2 | −7% |
| Orange East | +9.1 | +3.2 | −13.1 | −86.8 | −7% |
| Blue Day | +7.8 | +10.1 | −0.9 | −176.3 | −15% |
| Green | +20.2 | +63.4 | **+268.2** | **+267.2** | +22% |

Two facts fall out. The near number is right on every line (+2 to +20 s inside
two minutes, which is the #119 floor doing its job); and the far number is
short by a route-specific **percentage**, not by a constant. Green is the one
line that is long, and §2 says why.

### Where it is not

* **Anchor.** Where the client's own lead leg disagrees with the detector the
  bias is worse on Purple (−11.6 → +373.8) and Orange Night (−19.0 → +425.3),
  and those are the fold branches `docs/eta-ring-posterior.md` already names.
  But the disagreeing pairs are 2–19% of each route and the bias is there in
  the agreeing ones too (Red −21.1 on 20,032 agreeing pairs; Pink −51.2 on
  17,102). The anchor is a separate, larger, known lever; it is not this one.
* **Standing.** At-stop and moving pairs carry the same sign on every route
  (Red −37.2 / −6.2, Pink −64.6 / −46.4, Orange Night −18.5 / −19.4), and the
  dwell-elapsed bins do not order the error.
* **Hour.** Within a route the hour columns move by ±30 s around the route's
  own level with no pattern that survives the sample (PR #164 already excluded
  hour-of-day at ±6%).

## 2. Green: a hole, not a bias — and it has closed

Green's ring was rebuilt on 2026-09-07 (#160) from the driven stop order. Three
of its hops then had no history at all, because the published order could never
bill them: `81-127` (Bradley (S) → West Haven station, 9,353 m), `26-127`
(2,423 m) and `127-80` (9,214 m). Those hops price from the route's pace over
road metres — 9.3 km at ~0.13 s/m is **1,250 s against a real 535** — and every
chain that crosses one carries the excess.

Splice into the same 9/4 replay the drive quantiles production had measured by
2026-09-08 (`/api/buses` now serves all three: `81-127` dq median 535 s over
19 samples, `26-127` 210 s, `127-80` 485 s) and change **nothing else**:

| Green, 22,611 pairs | 9/4 tables (3 hops from the pace) | the same day, hops timed |
|---|---|---|
| median bias | **+113.1 s** | **−6.2 s** |
| median \|err\| | 191.3 | **71.1** |
| p90 | 642.6 | **509.0** |
| pessimistic ≥120 s | 49.1% | **11.9%** |
| optimistic ≥120 s | 11.3% | 23.9% |
| within 120 s | 39.6% | **63.2%** |
| 10–90 covers | 49.9% | **76.1%** |
| bias by hops (1..5) | +35, +32, +143, +175, +252 | −1, −21, −3, −9, −2 |

**So Green needed no correction.** It needed a day of data, and it has had one:
the collector timed the three hops as soon as the repaired order shipped, and
the +113 s is gone. Fitted on 9/3 — a day with the same hole — the estimator
in §5 asks for a Green scale of **0.759**, and its held-out check prices
exactly what publishing that would have cost: Green's median |error| 71.1 → **118.2 s**, its bias
−6.2 → **−88.4 s**. The guard in §5 refuses it, and this is the measurement the
guard is set from.

Two caveats on the record. The splice **leaks**: those drives were measured on
9/7–9/8 and are shown to a 9/4 replay, which is legitimate for the question
"what does this line do once the hop is timed" and illegitimate for anything
else. And production's own scorecard still reads Green +104 s on 9/8 — on the
**detector** truth, on 188 rider-facing rows, with 86 of them in the 10–30 min
bucket; §4 is why that number cannot be compared with the ones above.

## 3. Pink: the lap the model cannot see

Pink is the VA Hospital line, an out-and-back with a fold. Its published stop
list has twelve stops:

```
149 York/Cedar · 72 LEPH · 43 Congress/Cedar · 44 Congress/Howard ·
60 Front/Rt 1 (S) · 109 Quigley In · 123 VA Entrance In · 125 VA Hospital ·
124 VA Entrance Out · 110 Quigley Out · 59 Front/Rt 1 (N) · 46 Davenport/Howard
```

The bus drives something else. Taking every raw position and every moment a bus
comes within 45 m of a stop marker, the physical lap is **eighteen passes**:

```
46 → 149 → 72 → 43 → 44 → [60 59] → 109 → 110 → 124 → 123 → 125
   → 123 → 124 → 110 → 109 → [59 60] → 46 → 149
```

Three of the pairs are twin markers metres apart — Front/Rt 1 (N)/(S) are 10 m
apart, Quigley In/Out 40 m, VA Entrance In/Out 28 m — and the bus passes both
of each on the way out AND on the way back. The list names each once and puts
one of each pair on the outbound leg and the other on the return. On the
entrance road it also has them the wrong way round: the bus reaches **124
before 123** going in, and 123 before 124 coming out.

The consequence is not that the order is untraceable — it traces fine, which
is why the #160 repair (which fires only on a ring the published line cannot
trace) leaves Pink alone. The consequence is that **the adjacency the
calibrator measures is not the journey the bus makes**, and the samples it does
get are a fast, unrepresentative subset. Three laps compared, all as means so
the terms add exactly, over 30 days of arrivals in the 9/4 snapshot:

| route | hops | Σ served (stand + drive) | Σ observed arrival-to-arrival over the SAME adjacencies | observed lap | served / lap | a2a / lap | n laps |
|---|---|---|---|---|---|---|---|
| Orange Day | 33 | 2,841 s | 3,042 | 3,026 | 0.939 | **1.005** | 498 |
| Blue Day | 31 | 2,875 | 2,748 | 2,690 | 1.069 | **1.022** | 779 |
| Orange Night | 26 | 2,638 | 2,702 | 2,680 | 0.984 | **1.008** | 415 |
| Gold | 11 | 2,196 | 2,313 | 2,336 | 0.940 | 0.990 | 315 |
| Blue West | 11 | 2,361 | 2,299 | 2,340 | 1.009 | 0.982 | 271 |
| Red | 29 | 3,336 | 3,469 | 3,572 | 0.934 | 0.971 | 582 |
| Blue Night | 20 | 3,251 | 3,274 | 3,565 | 0.912 | 0.918 | 263 |
| **Pink** | 12 | 1,960 | 2,048 | **2,387** | **0.821** | **0.858** | 854 |
| Brown | 9 | 2,711 | 2,968 | 3,536 | 0.767 | 0.839 | 298 |
| Orange East | 12 | 1,959 | 1,816 | 2,341 | 0.837 | 0.776 | 262 |
| Purple | 15 | 2,458 | 2,605 | 3,576 | 0.687 | 0.729 | 1,058 |
| Green (3 hops from the pace) | 23 | 1,708 | 2,505 | 3,587 | 0.476 | 0.698 | 901 |

Read the last two columns together. **`a2a / lap` is a fact about the published
stop list alone** — the share of a real lap that its own adjacencies can
account for — and it is 0.97–1.02 on the plain loops and 0.73–0.86 on the
out-and-backs. **`served / a2a`** is how well the tables reproduce the
adjacencies they can see, and it is 0.91–1.08 everywhere, mixed in sign. The
one-sided, route-specific part of the shortfall is the first column, and it is
a property of the topology the estimator is handed.

On Pink the missing 14% has a name. The model bills `109 → 123` at a median
55 s (a hop it thinks is 1,755 m); the bus takes **240 s**, because it drives
109 → 110 → 124 → 123. The only laps that produce a *consecutive* 109 → 123
arrival pair for the calibrator are the ones where the detector missed 110 and
124 — the fast ones — so the hop is measured on its own tail. That single hop
is ~195 s of Pink's ~400 s deficit; stop 123 is the worst-priced stop on the
line (bias −274 s, 90.8% of its pairs optimistic by ≥120 s), and stop 124 is
the worst in the other direction (**+139 s**, because the bus reaches that
marker on the way IN, four minutes before the model has it there).

**The real repair is at the source**, and it is the one #160 already made for
Green: read the stop order — and the stop *occurrences* — off the published
line rather than off the published list. `alignStopsToPath` fires only where
the published order BRIDGES a leg, which is Green alone; Pink, Purple, Brown
and Orange East trace fine and are wrong anyway. Widening that trigger is a
bigger and riskier change than a display correction and it belongs in its own
measurement; §8 records it as the next piece of work. Until then the scale
below is an honest patch over a known hole, and it is labelled as one.

## 4. The confounder that is bigger than the bias: which instant is "arrival"

Every number above is on the **proximity** truth. Score the identical pairs
against the **detector's** arrival — the "nearest stop changed" event, which
`docs/eta-ring-posterior.md` notes fires roughly at the midpoint *before* the
stop — and the picture does not shift, it **inverts**:

| route | median bias, proximity | median bias, detector | median (prox − det) |
|---|---|---|---|
| Blue Day | +6.2 | +20.7 | 10.2 s |
| Orange Day | +3.8 | +16.9 | 10.0 |
| Red | −19.7 | +6.1 | 15.0 |
| Pink | −54.9 | −1.8 | 20.0 |
| Purple | −0.4 | +72.9 | 30.0 |
| Blue Night | −20.5 | +14.3 | 20.0 |
| Orange Night | −18.9 | +12.5 | 20.0 |
| Gold | −27.9 | +34.3 | 59.8 |
| Blue West | −16.5 | +44.9 | 35.0 |
| Orange East | −19.9 | +31.1 | 30.0 |
| Brown | −28.0 | +56.1 | 75.0 |
| **pooled** | **−7.7** | **+29.4** | 20.0 |

**The detector fires 10–75 s before the bus is at the kerb, and the amount is
route-specific.** Fit a per-route scale to each truth and they ask for opposite
things: the proximity truth wants 0.96–1.15 (stretch nine of twelve lines), the
detector truth wants 0.79–1.04 (shrink eleven of twelve). Neither fit helps the
other truth — proximity-fitted scales cost 3.9 s of median |error| when scored
on the detector, detector-fitted ones cost 9.9 s when scored on proximity.

So a large part of what the quantile sweep read as "a per-route bias" is the
per-route distance between two definitions of arrival, and **no estimator
change can be right for both**. This branch takes the rider's side, on the
grounds that a rider at the kerb calls it an arrival when the bus is there and
not when it is halfway from the last stop, and the proximity truth (45 m) is
much the closer of the two: pooled median |error| is 59.5 s against the
proximity truth and 75.2 s against the detector. It is a *choice*, it is the
same choice `docs/display-quantile-sweep.md` made, and it has a visible
consequence: **the production scorecard scores on the detector truth (it is the
only truth the server has — positions are swept after six hours), so a
published scale will read on `/stats` as a route becoming more pessimistic.**
That is the dashboard's truth, not a regression, and anyone reading it should
have this section in hand.

## 5. What was built, and why that shape

### A scale, not an offset — measured, not argued

Fit each shape per route on half the 9/4 pairs by zeroing the median error, and
score the other half:

| held-out half, 102,528 pairs | median \|err\| | median bias | pess ≥120 s | opt ≥120 s |
|---|---|---|---|---|
| champion | 59.2 s | −7.0 | 14.1% | 16.9% |
| **+ b, additive per route** | **60.8 s** (worse) | +0.7 | 14.2% | 15.4% |
| **× s, scale per route** | **54.4 s** | +1.7 | 14.6% | 13.7% |

The additive form zeroes the median and makes the *error* worse, because the
deficit it is correcting is proportional: it over-pays the one-stop-away rows,
where the number is already right, and under-pays the long ones. The scale is
what the hops-ahead and true-remaining tables in §1 describe.

A single GLOBAL scale (1.057, fitted the same way) recovers most of the pooled
median — 55.2 → 52.8 s against the per-route 52.0 — but it is τ in disguise
(it stretches every line by the same factor) and it leaves the per-route bias
where it was, only re-centred: Blue Day +12.9, Orange Day +11.5, Purple +13.8
against per-route's ±6 on every line. **The per-route part is worth ~0.8 s of
pooled median error and ~±14 s of per-route calibration**, which is precisely
the claim `docs/display-quantile-sweep.md` §9 made and could not test.

### `ROUTE_SCALE`, through the closed loop

`web/src/eta/params.ts` grows one key, `ROUTE_SCALE: Record<busRouteId,
number>`, and `arrival.ts` applies it as the **last** step of pricing:

```
eta *= s; low *= s; high *= s;      // then widenBand, as before
```

after the #119 floor clamp, so the floor stores the unscaled number and a
constant factor preserves "the shown remainder never climbs". It defaults to
`{}` — every route 1, and the branch skipped entirely — so a payload with no
`ROUTE_SCALE` prices exactly as master does (§6). It is **optional on the
wire** on both sides, so the set published on 2026-09-07 keeps applying.

Because it is the last step and feeds nothing back, a scaled pair is exactly
`eta × s`: the fit's held-out check needs no second replay, and the challenger
replay is a *check on that identity* rather than the way the number is
obtained. Measured on 9/4: **0 of 226,052 pairs differ from `eta × s`, max
|Δ| 0.00 s.**

`scripts/reestimate-lib.mjs` fits it, on the champion's own replayed pairs from
the archive, as `median(truth / promise)` over pairs promising more than a
minute, shrunk toward 1 by `n / (n + 2000)`. Five guards; three of them fired
on the real fit, and the sample-floor and held-out ones are what the two
cross-validation directions in §8 turn on:

| guard | value | what it caught on the 9/3 fit |
|---|---|---|
| sample floor | 2,000 scored pairs | Blue Weekend (17 pairs — it does not run on a Thursday) |
| **pooled-prior share** | >10% of the lap's road metres priced from the pooled pace | **Green (73%)**, Purple (38%), Brown (23%), Orange East (21%) |
| range | outside [0.75, 1.25] | — (nothing fitted outside it) |
| drift | more than ±0.20 from 1 without `--allow-drift` | — (the largest fit was 1.075) |
| held-out day | the route's own median \|err\| must not get worse | Blue Day (35.3 → 36.5 s) |

The pooled-prior guard is the one §2 pays for. It is not a taste: a route whose
lap is largely priced from the network's pooled pace is not biased, it is
**incomplete**, and its error closes on its own as the collector fills the
hops. On the 9/3 fit it refused four routes; of those, the held-out day says
Green's scale would have been a disaster (71.1 → 118.2 s), Brown's would have
hurt (79.3 → 87.6), Purple's was a no-op, and Orange East's would have helped
by 3.8 s. Refusing a real gain on one line is the price of never publishing a
correction for a hole, and after §2 that is a price worth paying.

## 6. The gates

### The default is byte-identical

`gps-replay` on 9/4 (`snap-0904-2205.db`, one shared payload patch), this
branch with nothing published against `origin/master` (a0fddd5) from a second
worktree into a separate `REPLAY_OUT`:

* **12,671 leaf metrics emitted by the two runs, 12,670 equal** — the only
  difference is `generatedAt`.
* **226,052 pairs, 0 differing** on `eta`, `low`, `high`, `det`, `k`, `atStop`.
* `npm test`: 2,056 tests, 73 files, green (12 new).

`web/src/eta/params.test.ts` proves the same thing by construction: a served
set equal to the compiled one reproduces every cell mass and every priced row,
and an empty `ROUTE_SCALE` leaves the rows untouched.

### The correction, held out

Scales fitted on **9/3** (the whole archived day, 606,236 pairs) and scored on
**9/4** (205,061 pairs with a proximity truth), which the fit never saw.
Published set: `{"2":1.007,"3":1.055,"8":1.075,"13":1.03,"14":1.057,
"15":1.076,"16":1.033}`.

| route | n | s | median \|err\| | p90 | **median bias** | pess ≥120 s | opt ≥120 s | within 120 s | 10–90 covers |
|---|---|---|---|---|---|---|---|---|---|
| Blue Day | 12,274 | — | 35.3 → 35.3 | 158 → 158 | +6.2 → +6.2 | 7.8 → 7.8 | 6.3 → 6.3 | 85.9 → 85.9 | 81.4 → 81.4 |
| Orange Day | 13,982 | 1.007 | 28.1 → 28.0 | 110 → 109 | +3.8 → +4.7 | 5.0 → 5.1 | 3.6 → 3.4 | 91.5 → 91.5 | 83.7 → 83.6 |
| Red | 20,972 | 1.055 | 47.6 → **45.7** | 255 → **241** | −19.7 → **−6.7** | 4.8 → 6.0 | 19.0 → **16.0** | 76.3 → **78.0** | 76.4 → **79.1** |
| Pink | 19,061 | 1.075 | 106.1 → **97.5** | 455 → **418** | −54.9 → **−23.6** | 9.4 → 13.7 | 36.4 → **28.5** | 54.2 → **57.8** | 68.0 → **69.9** |
| Green | 22,611 | — | 71.1 → 71.1 | 509 → 509 | −6.2 → −6.2 | 11.9 → 11.9 | 24.9 → 24.9 | 63.2 → 63.2 | 76.1 → 76.1 |
| Purple | 27,102 | — | 102.9 → 102.9 | 664 → 664 | −0.4 → −0.4 | 25.3 → 25.3 | 22.0 → 22.0 | 52.7 → 52.7 | 76.2 → 76.2 |
| Blue Night | 22,973 | 1.03 | 70.8 → **67.2** | 225 → 225 | −20.5 → **−11.9** | 13.1 → 14.8 | 18.8 → **15.4** | 68.1 → **69.8** | 78.8 → **81.4** |
| Orange Night | 28,068 | 1.057 | 39.4 → **36.7** | 129 → **119** | −18.9 → **−7.6** | 3.0 → 4.2 | 9.1 → **5.6** | 87.9 → **90.2** | 83.4 → **86.6** |
| Gold | 6,018 | 1.076 | 55.4 → **51.6** | 220 → 234 | −27.9 → **+1.3** | 7.4 → 12.7 | 20.9 → **12.6** | 71.7 → **74.7** | 79.8 → **81.1** |
| Blue West | 12,037 | 1.033 | 47.5 → **46.5** | 196 → **175** | −16.5 → **−0.4** | 4.5 → 5.9 | 16.6 → **11.4** | 78.9 → **82.7** | 91.6 → 91.3 |
| Orange East | 11,656 | — | 48.1 → 48.1 | 193 → 193 | −19.9 → −19.9 | 3.5 → 3.5 | 16.5 → 16.5 | 80.0 → 80.0 | 89.9 → 89.9 |
| Brown | 8,307 | — | 79.3 → 79.3 | 517 → 517 | −28.0 → −28.0 | 12.7 → 12.7 | 27.4 → 27.4 | 60.0 → 60.0 | 79.4 → 79.4 |
| **pooled** | 205,061 | | **55.5 → 53.7** | **343 → 333** | **−13.6 → −5.9** | **9.9 → 11.0** | **18.6 → 16.1** | **71.5 → 72.9** | **79.5 → 80.7** |

(The pooled row is on the Green-hops patch of §2, which is why it reads 55.5 s
where §1's table, on the 9/4-as-it-was tables, reads 59.5.)

**Every route it touches improves on median |error|, on the bias and on the
optimistic tail; five of seven improve p90; six of seven improve interval
coverage. The pessimistic tail rises — 9.9 → 11.0 points pooled, and 9.4 →
13.7 on Pink.** That is not a free trade and it should not be presented as
one: removing an optimistic bias necessarily moves some mass across the
promise. What it buys per point given up is better than the display quantile's:
τ 0.50 → 0.55 buys 1.3 points off the optimistic tail per point onto the
pessimistic one and 1.6 s of median (`docs/display-quantile-sweep.md` §2); this
buys 2.3 points and 1.8 s, and unlike τ it leaves nine routes exactly as they
were.

## 7. Reproducing

```bash
cd services/shuttle-v2
# the champion, either day
TZ=America/New_York REPLAY_DB=./store/snap-0904-2205.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0904.json \
  REPLAY_OUT=./scripts/.eta-replay/champ PAIRS_OUT=./scripts/.eta-replay/champ/pairs.jsonl \
  npx tsx scripts/eta-replay/gps-replay.ts
# an archived day, whole
TZ=America/New_York npx tsx scripts/eta-replay/archive-db.ts 2026-09-03 ./store/snap-0904-2205.db /tmp/r0903.db
TZ=America/New_York REPLAY_DB=/tmp/r0903.db MODEL_OUT=/tmp/p0903.json MODEL_NOW=2026-09-04T04:00:00.000Z \
  MODEL_ROUTES=all npx tsx scripts/eta-replay/model-patch.ts
# the challenger: the same run with a parameter file
MODEL_PARAMS=./scripts/.eta-replay/params-candidate.json ...
```

The fit itself is `scripts/reestimate-params.mjs` — it does all of the above on
the last three archived days, fits the scale beside the conformal widening on
all but the last, checks both on the last, and posts one row either way
(`--dry-run` to watch it).

## 8. Caveats, and the one that changes how it is run

### The scale is not stationary across the day-part, and the guard catches it

Run the cross-validation the other way — fit on **9/4** (the 6.2 h evening
window) and hold out on **9/3** (the whole archived day) — and the same
estimator asks for materially larger factors and over-corrects:

| route | fitted on 9/3 (whole day) | fitted on 9/4 (evening) | held out on 9/3: median \|err\| | bias |
|---|---|---|---|---|
| Red | 1.055 | **1.085** | 48.2 → 49.8 s | −11.0 → +7.0 |
| Pink | 1.075 | **1.136** | 98.2 → 103.0 | −27.0 → +16.6 |
| Blue Night | 1.030 | **1.070** | 67.1 → 71.0 | −8.4 → +8.4 |
| Orange Night | 1.057 | **1.094** | 44.4 → 50.0 | −10.8 → +5.6 |
| Gold | 1.076 | 1.053 | 87.9 → 85.0 | −27.4 → −8.6 |
| Blue West | 1.033 | 1.033 | 78.4 → 76.1 | −10.4 → +1.4 |

**The per-route held-out guard refuses all four of the overshooting ones**,
which is the guard working exactly as specified — but the finding underneath
is worth stating plainly: the ratio depends on when you measure it. On the 9/3
pairs, split at 16:00 ET:

| route | daytime ratio (n) | evening ratio (n) |
|---|---|---|
| Blue Day | 0.996 (55,527) | **1.195** (16,074) |
| Orange Day | 1.006 (26,447) | 1.008 (12,141) |
| Red | 1.059 (58,294) | 1.040 (19,011) |
| Pink | 1.052 (38,977) | **1.147** (15,424) |
| Purple | 0.956 (39,228) | **1.080** (30,109) |
| Gold | 1.090 (20,471) | 1.010 (5,635) |
| Brown | 1.047 (19,323) | **1.127** (8,141) |

Evening stands are longer and more variable — `docs/display-quantile-sweep.md`
§11 warned about exactly this window — so a scale fitted on an evening
over-corrects a day. **The job always replays whole archived days**, which is
the fit that generalises here; a partial window must not be used, and the
guard is what enforces it if one is. A per-route × day-part scale is the
obvious extension and is deliberately not taken: PR #164 excluded hour-of-day
for the estimator at ±6%, and doubling the parameter count on one day of
evidence is how a correction becomes a fit.

### The pooled-prior guard reads the PUBLISHED adjacencies

It walks `routes.stops_json` — upstream's list — because that is what a plain
JS job on the archive has. On Green the ring is built on the REPAIRED order,
whose hops are not in that list at all, so the guard reads 73–80% and Green is
excluded whatever its tables say. That is the safe direction and Green needs no
scale (§2), but it is a crudeness on the record: the guard should read the
ring's own adjacencies once `alignStopsToPath` can be reached from the job.

### One day type

Both fits are weekdays. Blue Weekend and the grocery lines never clear the
sample floor on a Thursday and carry no scale; a weekend fit would be a
separate measurement, and the loop will make it on its own as the archive
fills.

## 9. What this does not fix

1. **The flattened out-and-back stop lists.** §3. Pink, Purple, Brown and
   Orange East hand the estimator a lap that is 14–27% shorter than the one
   their buses drive. Extending #160's `alignStopsToPath` to add the
   occurrences the list omits — not only to reorder a list the line cannot
   trace — would remove the cause, and then most of these scales should fit to
   1 on their own. That is the next piece of work, and the scale is explicitly
   a placeholder for it: **when the source is fixed, the fit will walk the
   scales back by itself, and the pooled-prior guard will hold them at 1 while
   the new hops warm up.**
2. **The truth.** §4. Nothing in production records when a bus was actually at
   a stop; the scorecard scores against an event that fires 10–75 s early, and
   the number that decides a per-route correction depends on which of the two
   you believe. Recording a proximity arrival server-side (the collector has
   the positions before it sweeps them) would settle it and would make the
   dashboard and the replay agree.
3. **The anchor**, still the largest lever on record (`docs/eta-ring-posterior.md`).
