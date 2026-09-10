# The stand at a layover, conditioned on the bus's own lap

**Status: measured; the client and server halves are built and gated. The
rider-level result is at the bottom and it is the only number that decides
anything.**

The pooled stand table is the dominant ETA defect. 344 Winchester's served
vector is `[14, 116, 140, 180, 267, 334, 387, 450, 554, 701]` — an
unconditional median of 4:43 with a 687 s spread — and every downstream number
inherits it. One covariate splits it: **the bus's own lap**, the seconds from
that bus's previous DEPARTURE from that stop to its next arrival there.

## 1. The covariate, and the window it is only valid inside

Measured over 90 days of `arrivals` (2026-06-12 .. 2026-09-10), 92,119 closed
visits at the 45 (route, stop) cells with n >= 300 and a mean closed visit of
at least 3 min.

**A lap is not any gap, and the estimate is extremely sensitive to saying so.**
Five overnight or depot gaps in ninety flip the sign of the correlation. At
344 Winchester, same 1,858 visits, only the definition of "a real lap"
changing:

| window | n | corr(lap, stand) | OLS slope (s/s) |
|---|---:|---:|---:|
| every gap | 1,858 | **-0.046** | -0.000 |
| 20-120 min | 1,688 | -0.475 | -0.229 |
| 30-90 min | 1,673 | -0.639 | -0.490 |
| 40-80 min | 1,653 | -0.657 | -0.536 |
| 45-70 min | 1,564 | -0.683 | -0.592 |

**The window must be a multiple of the CELL'S OWN LOOP, never minutes.** Loops
differ by a factor of two across the network. The same absolute 40-80 min
window that fits Red's 59.8 min loop keeps **74 of York / Cedar's 2,376 gaps**
(loop 40.3 min) and flips its correlation to **+0.478**, because all it has
left is double laps.

Swept as a multiple of the loop, held out on the last 40% of service days and
scored over EVERY visit in the test period — so a narrower band that corrects
fewer visits pays for the ones it stops correcting:

| band (x loop) | held-out stand MAE | cells improved | visits corrected | corr at 344 Winchester |
|---|---:|---:|---:|---:|
| none | 128.7 s | 25/39 | 97% | -0.029 |
| 0.50 - 2.00 | 117.9 | 23/39 | 79% | -0.624 |
| 0.60 - 1.80 | 116.6 | 24/39 | 74% | -0.638 |
| **0.65 - 1.65** | **116.1** | 21/39 | 72% | -0.651 |
| 0.70 - 1.50 | 116.3 | 25/39 | 69% | -0.655 |
| 0.80 - 1.30 | 117.5 | 23/39 | 62% | -0.659 |
| 0.90 - 1.15 | 121.6 | 26/39 | 48% | -0.672 |

The correlation keeps STRENGTHENING as the band narrows and the MAE does not.
That is the trap: a tighter band keeps a more linear subset, which is not the
same thing as a better estimate. The surface is flat to half a second from
0.60-1.80 to 0.75-1.40, so **0.65 - 1.65 is chosen from the optimum of a flat
region, not from a knife edge.**

**The slope is about -0.5, not -1.** PR #184's phase model is the same
covariate with the slope hard-coded at -1 (`predicted stand = period - lap`).
Fitted per cell over 90 days: -0.50 s of stand per second of lap at 344
Winchester, -0.77 at Union Station (N) on Red. Compensation is partial.

## 2. What it buys on the stand itself

Held out on the last 40% of service days, 39 cells, 23,312 scored stands,
under the exact rule that ships (band, shrinkage, clamp):

**pooled 127.8 s -> lap 113.5 s MAE, -11.2%. 24 of 39 cells improve; 2 are
worse by more than 5 s.**

The two Red layovers are the largest wins on the network:

| cell | route | n test | pooled | lap |
|---|---:|---:|---:|---:|
| 333 Cedar | 13 | 293 | 179.0 | 106.0 |
| 344 Winchester | 3 | 618 | 179.5 | 115.5 |
| Union Station (N) | 13 | 286 | 186.8 | 129.5 |
| Union Station (N) | 3 | 635 | 177.4 | 122.5 |
| York / Cedar | 8 | 854 | 175.4 | 122.4 |
| 333 Cedar | 10 | 1,167 | 216.2 | 168.5 |
| ... | | | | |
| 333 Cedar | 1 | 809 | 183.2 | 189.5 |
| 100 Church Street South | 14 | 371 | 256.4 | 266.2 |

## 3. Two covariates that were measured and are NOT served

### Headway — the gap to the bus in front

Reported at -0.313 on the residual at one stop on 90 stands. Replicated on 90
days across 27 cells with a live bus in front:

- It is real where the cell is genuinely regulated: partial correlation given
  lap of **-0.30** at Union Station (N) route 13, **-0.26** at 333 Cedar
  route 13, **-0.23** at York / Cedar, **-0.21** at 344 Winchester (n=1,635) —
  14 of 27 cells have a day-block bootstrap CI excluding zero.
- **It REVERSES at seven cells** (300 George St +0.25, 100 Church +0.20,
  Building 400 route 10 +0.18), all of them cells where lap itself is flat.
  The n-weighted mean partial is **-0.033**.
- Added to the fit it moves the held-out stand MAE by **0.9 s of 111.8** —
  4.1 s at 344 Winchester, its best cell.

It does not earn a wire field.

### Measuring the lap from a REGULATOR stop instead of the stop itself

The operator asked whether "how long since this bus departed 333 Cedar" beats
"how long since it departed this stop". Swept over every upstream stop on the
route, 90 days, in-band gaps only:

| cell | route | n | own lap | rank | best alternative |
|---|---:|---:|---:|---:|---|
| 344 Winchester | 3 | 1,661 | **-0.640** | 1/13 | Division / Prospect -0.622 |
| Union Station (N) | 3 | 1,669 | **-0.801** | 1/7 | Court / Olive -0.753 |
| 333 Cedar | 10 | 2,992 | **-0.609** | 1/3 | 300 George St -0.520 |
| York / Cedar | 8 | 2,080 | **-0.606** | 1/5 | LEPH / 60 College -0.531 |
| Union Station (N) | 13 | 759 | **-0.656** | 1/3 | 81 George St -0.451 |
| Building 400 | 10 | 3,214 | **-0.513** | 1/2 | Building 800 -0.502 |
| VA Hospital | 8 | 2,112 | **-0.398** | 1/2 | Front / Rt 1 (S) -0.387 |
| 333 Cedar | 1 | 2,072 | **-0.068** | 1/11 | 129 York -0.046 |
| 333 Cedar | 13 | 773 | -0.768 | 3/6 | 180 York (A&A) -0.795 |

**The stop's own lap wins at 8 of 9 cells**, and the one exception loses by
0.027 to a stop three minutes upstream on the same run — a near-collinear
measurement of the same lap, not a different signal. No per-cell regulator
selection is needed. 333 Cedar is not on Red at all.

## 4. Applied CONTINUOUSLY, which is the whole difference from #184

PR #184 read its correction in ONE place — `startChain`, for the stop the bus
is standing at right now — so the whole correction landed in a single poll.
The correction is worth a median **95 s at 344 Winchester and 138 s at Union
Station (N)** (p90 256 and 349 s), so that step is the size of the gain. On
held-out Red it fixed 3 jumps >= 180 s and introduced 43.

A bus's previous departure from a stop is known a mean of 53-56 minutes before
the stand it predicts. So `web/src/eta/arrival.ts` prices the lap of EVERY
stand in the chain, from a nominal walk forward from the lead's own leg:

    lap at stop s  =  (seconds since this bus left s)  +  (nominal seconds until it reaches s)

Both halves move at about one second per second in opposite directions, so the
lap a stop is priced under is near-constant through the whole approach and
there is nothing left to land when the bus arrives. Measured on a synthetic
450 m approach in `web/src/eta/lap.test.ts`, the ratio between the corrected
and uncorrected arrival is steady to under 2% a poll for the whole approach and
0.071 on the single poll where the chain hands over from the whole stand to its
residual — the same poll on which the uncorrected arm itself moves 97 s.

The form is MULTIPLICATIVE on the quantile vector, following PR #164:
`S_scaled(x) = S(x / f)` keeps the residual of a stand given the time already
stood coherent, and leaves the mass at zero (P(stop)) untouched because 0 x f
is 0. Scaling a stand by f multiplies its quantile function by f, so the draws
of the scaled table under a fixed permutation are exactly f x the draws of the
unscaled one — a corrected chain is the shared chain plus a running sum of
`(f - 1) x standDraws`, and no prefix has to be rebuilt per bus.

Shrinkage: `w = n / (n + 19)`, with `n` an EFFECTIVE count the server computes
from a DAY-CLUSTERED standard error, so a cell whose fit is a few good days
rather than a pattern degrades toward 1.0. k = 19 is read off the data
(between-cell variance of the relative slope 0.087 against a mean day-block
sampling variance of 0.0023). At production sample sizes it weighs
essentially 1; it exists for the thin cell.

## 5. The wire

Two additive optional fields, measured against a live `/api/buses` (136,864 B
raw, 17 buses, uncompressed in production), with the **gated** set of 22 cells:

| | raw | gzip |
|---|---:|---:|
| `dwells[route][stop].lapB` / `.lapM` / `.lapN`, 26 fitted keys | +958 B | |
| `buses[].lap`, 27 entries over 17 buses | +379 B | |
| **total** | **+1,337 B (+0.98%)** | +461 B |

Ungated (66 candidates, 58 keys) it was +2,770 B / +2.02%, so the gate halves
the wire cost as well as removing the cells where the correction is wrong. At a
peak fleet of ~50 buses the per-bus half is ~1 KB, so ~2 KB and +1.4%. This
does NOT require the server-side ETA move.

## 5a. The serving gate: a property of the CELL, not a route allowlist

A fit is served only where it measurably beats the thing it replaces.

This is not a formality. Two cells on the 90-day corpus fit a real slope and
still score WORSE held out than the pooled median they would replace
(100 Church Street South on Orange Night, 333 Cedar on Blue Day). Serving a
correction that is worse than what it replaces is exactly how the split stand
tables burned Pink — 11 hops cleared the client's sample gate and the line went
280 -> 431 strands (CLAUDE.md, "The stand/drive split is served"). A route
allowlist is the fragile version of that lesson; the gate is per cell.

**The rule** (`gateCell` in `src/calibrator/lapFit.ts`). Day-blocked 5-fold
cross-validation INSIDE the cell: each fold fits the slope and the pooled
median on the other four folds' SERVICE DAYS and scores this fold's stands with
both, under the exact rule that ships — band, shrinkage weight, clamp. The
per-visit paired absolute-error difference is then bootstrapped BY DAY (400
resamples, seeded on the cell key so it is deterministic across the
calibrator's six-hourly reruns), and the cell is served only when the **upper
end of the one-sided 90% interval is still below zero**. Days are the
resampling unit for the same reason `slopeSE` clusters on them: stands within a
day share a fleet, a timetable and the weather, and the iid interval
understates the noise by an order of magnitude. A cell with fewer than ten
service days is not served at all.

**66 candidate cells -> 22 served.** The head and the tail of the table
(`scripts/eta-replay/lap-fit.ts` prints all 66):

| rt | stop | | n | days | pooled | lap | delta | upper | served |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 13 | 10 | 333 Cedar | 790 | 89 | 226.6 | 105.7 | -120.9 | -109.8 | yes |
| 3 | 121 | Union Station (N) | 1,706 | 62 | 140.8 | 76.8 | -64.0 | -59.1 | **yes** |
| 8 | 149 | York / Cedar | 2,115 | 62 | 174.5 | 113.3 | -61.3 | -59.0 | yes |
| 10 | 10 | 333 Cedar | 3,037 | 87 | 214.7 | 159.2 | -55.5 | -52.2 | yes |
| 3 | 11 | 344 Winchester | 1,705 | 62 | 164.1 | 109.3 | -54.8 | -51.6 | **yes** |
| … | | | | | | | | | |
| 1 | 10 | 333 Cedar | 2,138 | 62 | 174.7 | 174.3 | -0.4 | +0.5 | **no** |
| 10 | 9 | 300 George St | 3,126 | 87 | 77.0 | 79.5 | +2.5 | +3.3 | **no** |
| 14 | 1 | 100 Church Street South | 906 | 88 | 203.1 | 207.7 | +4.5 | +7.1 | **no** |

- **Both cells the ungated fit got wrong drop out**: 100 Church Street South
  (+4.5 s held out) and 333 Cedar on Blue Day (-0.4 s, but its interval crosses
  zero, so the improvement does not survive its own day-to-day noise).
- **Five of the seven cells whose HEADWAY partial reversed sign also drop**
  (300 George St, 100 Church, Building 900/10, Prospect / Sachem/13, VA
  Entrance Outbound/8). The two that survive do so on their own lap evidence,
  which is the right criterion: Building 400 on route 10 at **-17.6 s** and
  Peabody Museum on Blue Night at -1.5 s, both with intervals below zero. The
  gate is about the lap rule, not about headway.
- **The gate is agnostic about the SIGN.** Three of the 22 survivors fit a
  POSITIVE slope — a later bus standing longer, not the slack-discharge
  mechanism — and are served because held out they beat pooled anyway (Phelps
  Gate on route 4 -25.1 s, State St Station on Brown -21.1 s, West Haven Train
  Station on route 9 -1.4 s). Evidence, not mechanism.
- It admits some cells on tiny effects (Canner / Whitney -0.2 s, Peabody
  -1.5 s). That is harmless — a factor of essentially 1 is a near-no-op — and
  an effect floor would be a new dial with no measurement behind it. Not added.

**Red's served set is UNCHANGED by the cell gate**: 344 Winchester and Union
Station (N) both pass, with byte-identical `lapB` / `lapM` / `lapN` before and
after. So the paired day run in section 6 already describes the shipping
configuration on Red, and it was not re-run.

## 5b. The ROLLOUT gate: which routes have been watched

The cell gate proves the fit beats the pooled median on **held-out stand MAE**
at that cell. That is necessary and **not sufficient**, and Pink is the proof:
the split stand tables almost certainly improved the stand estimate there too,
and the line went **280 -> 431 strands** anyway, because replacing a
pessimistic estimate with an unbiased one strands the half of riders whose bus
leaves before the median (CLAUDE.md, "The stand/drive split is served"). A
better point estimate can be worse for a rider, and only the rider table can
say. Red's numbers here look good because the rider table says so — 11 strands
fixed against 5, 43 reversals against 7 — not because the MAE fell.

So `LAP_SERVED_ROUTE_IDS` in `src/calibrator/lapFit.ts` records **which routes
have a paired rider-sim run showing strands and reversals not rising.** Today
that is `{3}`. It is applied AFTER the cell gate and never instead of it, and
`gates` still records the full 66-cell candidate table on every route — which
is what the next route's case is made from.

**It is a rollout ledger, not a tuning knob.** The arithmetic is identical on
every route and every cell; nothing here changes what the estimator does, only
where it is switched on. Adding a route means running the pair and pasting its
numbers beside the id, exactly as `SPLIT_SERVED_ROUTE_IDS` requires; a test
fails if an id has no evidence line beside it in the source.

**66 candidates -> 22 pass the cell gate -> 2 served.** The 20 held back are
held for want of RIDER evidence, not for want of merit. The one most worth
unlocking next is **333 Cedar on Blue Night (13:10), delta -120.9 s held out,
the largest effect on the network** — nearly twice 344 Winchester's.

Wire cost at the rollout-gated set is **+172 B a poll, +0.13%** (2 dwell keys,
3 Red buses x 2 entries on a 17-bus payload). The 22-cell and 66-cell figures
below are what it would cost as routes are added.

## 6. The gate: the paired rider table, Red, held out

`scripts/eta-replay/rider-sim`, ROUTES=Red, ET day **2026-09-04** (the fit sees
only ET days BEFORE it), `snap-0904-2205.db`, both arms through the SAME
harness and the SAME `PAYLOAD_PATCH` — the arms differ in one thing, the client
tree — and the two `waits.jsonl` are md5-different (`780a4617…` vs
`99d0fb11…`, 77% of paired waits show a different displayed sequence, so the
change is genuinely exercised).

**1,664 paired waits.**

| | fixed (base only) | introduced (lap only) | both | neither |
|---|---:|---:|---:|---:|
| **STRAND** | **11** | **5** | 9 | 1,427 |
| **reversal >= 60 s** | **43** | **7** | 64 | 1,338 |
| jump >= 180 s | 25 | 21 | 31 | 1,375 |
| dropped while approaching | 0 | 0 | 45 | 1,407 |
| pin wrong | 0 | 0 | 122 | 1,330 |

- worst drift per wait: **improved 592, worsened 101, same 759** (p50 0, p10 -60 s)
- first promise |miss|: **improved 254, worsened 256** — a dead wash, p50 0 s

Unpaired headlines, for the shape rather than the verdict:

| | base | lap |
|---|---:|---:|
| scored | 1,502 | 1,470 |
| first promise \|miss\| median | 60 s | 55 s |
| early > 60 s — **the dangerous tail** | 22.6% | **14.8%** |
| late > 60 s — the rider waiting | 26.8% | 32.4% |
| interval width / coverage | 364.6 s / 74.6% | **327.7 s** / 73.0% |
| jump >= 180 s | 5.9% | **3.3%** |
| reversal >= 60 s | 7.2% | **4.9%** |
| STRAND | 1.1% | 1.2% |
| worst drift p90 | 160 s | **105 s** |

**Read it this way.** The covariate buys **stability, not accuracy** — which is
the opposite of what an 11% stand-MAE improvement predicts, and the opposite of
what PR #184 did with the same covariate applied as a step. First-sight
accuracy does not move at all. What moves is the SEQUENCE: a third fewer
riders see a reversal, strands fall 20 -> 14, the 10-90 band narrows 10% at the
same coverage, and the worst drift a rider sees improves for 592 waits against
101.

**And it moves the error the RIGHT way, which is the second finding.** Read
`firstSightMissSec` the way rider-sim defines it (`lib.ts`, and its own test
`-339 // promised >= 420 s, came after 81`): **negative means the bus arrived
BEFORE the promised window** — predicted > actual, the bus beat the promise,
the rider strolls down and it has gone. That is `pessimistic120` in
`common.ts`'s vocabulary and CLAUDE.md names it the dangerous tail. So:

- **the dangerous tail falls 22.6% -> 14.8%, 7.8 points.** The arm predicts
  SHORTER, and fewer riders are told a bus is further away than it is.
- what rises is the mild half — riders waiting more than a minute longer than
  they were told, 26.8% -> 32.4%.

That is the same defect the canary filed on Red at 17:48 on 2026-09-10: first
sight "in 13, 44 min" against a bus that took 6.4 min, seven minutes inside its
own promise. It is also why strands fall: a promise the bus can beat is exactly
a strand waiting to happen.

**Cost.** The lap arm is ~28% slower on the simulator (poll 8000 at 1,505 s
against 1,174 s). Most of that is `priceRoute` building its chains TWICE — once
without the correction to find the lead's leg, once with it. That is a
straightforward optimisation and it has not been made.

### What was NOT measured

- Only Red. Every fitted cell on the network carries a fit, and two of them
  (100 Church Street South on Orange Night, 333 Cedar on Blue Day) score WORSE
  than pooled on the held-out stand MAE. The other fourteen routes have not
  been through the paired table.
- The midday slice (445 paired waits) read 2 fixed / 9 introduced on jumps, and
  every one of the eleven traced to **two instants** in the SECOND bus's number,
  both `eventful: false`, where a one-minute difference crossed the canary's
  600 s pairing window. That is why the full day is the number quoted: at
  n=445 this metric is two anecdotes counted eleven times.

## 7. The warm start, and what else a restart loses

`Collector.lapClock` is in-memory and fed only by the detector's dwell events,
so a fresh process knows no bus's lap. Without a warm start a bus carries no
`lap` until it completes a loop AND departs a fitted stop again — on Red up to
an hour, and only at 344 Winchester or Union Station (N). This app deploys
several times a day, so the correction would be INERT for a lap after every
one of them, which is exactly the window a rider is most likely to be looking
at. **Measured in production at 18:26 ET on 2026-09-10, minutes after #206
shipped: `lapB` served on both Red cells and `lap` on 0 of 13 live buses.**

Same class as report #100 (a restart zeroing a standing bus's clock, fixed by
`seedStationaryFromHistory`) and as PR #81 (served, live and inert for a night
because the payload never carried what the client needed). Same fix: the data
is already on disk. `Collector.seedLapClock` runs once at boot, after the first
calibration — the fitted cells are what say which stops are worth seeding — and
takes the last `departed_at` per (bus name, stop) inside `LAP_CLOCK_TTL_MS`,
one indexed query per served cell. Non-throwing: a failed warm start costs the
feature a lap, never the collector.

**Is `lapClock` the only in-memory piece? Yes.** Audited:

| piece | across a restart |
|---|---|
| `Collector.lapClock` | **was lost** — now seeded |
| `Collector.lapFitsCache` | recomputed from `arrivals` on the first `get()`; costs a query, not a lap |
| the network's `lapB`/`lapM`/`lapN` | `start()` calibrates before the first poll, so present at boot |
| the client's factor | recomputed per poll from the payload; nothing is carried |
| `prefixCache` / `termCache` in `arrival.ts` | pure memoisation |

### And the fit itself was 21 seconds on the boot path

Found while checking the seed's cost, and it shipped in #206: `loadLapFits`
took **21,190 ms**, synchronous on the loop that serves `/api/buses`, once at
boot and once every six hours. Nothing to do with SQLite — the candidate query
is 1.3 s. It was `etDay`, i.e.
`new Date(ms).toLocaleDateString("en-CA", { timeZone })`, which builds a fresh
`Intl.DateTimeFormat` every call: **166 us each**, and the fitter asks it once
per in-band sample. One shared formatter plus an hour-bucket memo (rows arrive
in time order) takes it to **0.30 us**, and the window sweep above takes the
whole call to **1,016 ms** for the identical served set.

    loadLapFits:  21,190 ms  ->  1,016 ms
