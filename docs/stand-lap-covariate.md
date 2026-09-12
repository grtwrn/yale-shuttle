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

## 6b. Route 13 (Blue Night): measured and REFUSED by the rider table (2026-09-10)

333 Cedar on Blue Night (13:10) is the largest lap effect on the network —
delta -115.5 s held out with `FIT_BEFORE=2026-09-06` (upper -104.1), nearly
twice 344 Winchester's — and the cell gate also passes Union Station (N) on
that line (13:121, -55.9, on a THIN effective count of 157) and Peabody
Museum (13:97, -1.5 s, a factor of essentially 1). The fit that was scored is
byte-identical to the one `lap-fit.ts` regenerates from `snap909.db` with
`LAP_ROUTES=3,13 FIT_BEFORE=2026-09-06`, so every evening below is held out
from it. The arms differ in ONE thing — whether the patch carries route 13's
three cells — and share one client tree (master d505923) and one harness, so
this measures exactly what flipping the ledger serves.

Blue Night runs one bus most evenings, 18:00-00:15, on a ~48 min loop: six
stands at 333 Cedar an evening, five of them with a lap. That is the size of
each evening's evidence, which is why three of them are stacked.

### The stand itself, evening by evening

At 333 Cedar the correction moves the RIGHT way on every evening and
UNDERSHOOTS: the fitted slope (-0.5) is partial, and a bus back 1-5 min early
stood 655-945 s against a pooled 591 s.

| evening | bus | stands with a lap | pooled MAE | lap MAE |
|---|---|---:|---:|---:|
| Sat 09/06 | #57 | 5 | 268 s | **175 s** |
| Mon 09/08 | #38 | 5 | 166 s | **152 s** |
| Tue 09/09 | #40 | 5 | 299 s | **244 s** |

The failure case is in there too and worth knowing the shape of: Tue 09/09
#40 came back 7 min early at 20:44 and stood 70 s (predicted 857), then 73 min
late at 23:56 and stood 410 (predicted 207) — an evening the line was not
regulated. The covariate is a tendency, not a timetable.

### gps-replay, three evenings, route 13 only, proximity truth

`archive-db.ts` built each ET day from `~/shuttle-archive`, `raw_positions`
trimmed to route 13, `POLL_STRIDE=1`, both arms into their own `REPLAY_OUT`
with `PAIRS_OUT`, paired row for row. **Tue 09/09 holds positions only from
21:00** (three hours, two lap-corrected stands), so it is the weakest evening
and is reported rather than pooled away.

| evening | rows | median \|err\| | p90 | pessimistic >= 120 s | optimistic >= 120 s | 10-90 coverage | better / worse | jumps >= 180 s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sat 09/06 | 17,788 | 78.8 -> **69.9** | 296 -> 272 | 13.8 -> 13.4 | 24.4 -> 20.1 | 73.9 -> **78.2** | 3,876 / 1,213 | 91 -> 94 |
| Mon 09/08 | 16,119 | 73 -> 72 | 339 -> 338 | 15.5 -> **13.9** | 22.5 -> 22.4 | 75.5 -> 76.3 | 2,617 / 1,703 | 98 -> 95 |
| Tue 09/09 (partial) | 8,447 | 92 -> 90 | 360 -> 321 | 18.2 -> 19.3 | 26.4 -> 24.5 | 71.6 -> 71.4 | 856 / 1,095 | 66 -> 74 |
| **pooled** | **42,354** | **78.7 -> 74.1** | 325 -> 310 | **15.3 -> 14.8** | 24.1 -> 21.9 | **74.1 -> 76.2** (width 347 -> 346) | **7,349 / 4,011** | 255 -> 263 |

Pooled, the standing population — where the correction acts — moves most:
median 95.5 -> 85.7 s, coverage 74.8 -> 77.9%, with the dangerous tail flat
(14.3 -> 14.7%). First sight, taken as the first row for each (stop, arrival)
as the stop enters the 5-stop window (one bus per evening, so the sequence is
one vehicle's): 301 first sights, median |err| 142 -> 131 s, pessimistic
20.6 -> 18.3%, coverage 68.8 -> 71.8%, 62 better / 19 worse. Detector truth
agrees on every column (pooled median 97.4 -> 89.1).

A third arm with ONLY the 333 Cedar cell was run to see whether the thin
Union Station (N) fit costs anything in the chain. It does not: on all three
evenings the full patch beats the Cedar-only one (09/06 median 69.9 vs 73.0,
pessimistic 13.4 vs 14.9%; 09/09 better/worse 856/1,095 vs 358/718). The cell
gate's answer stands; no per-cell carve-out.

**The instrument, not the model, was the first result.** The first two
gps-replay arms came out byte-identical — same md5 — because `gps-replay.ts`
built its payload without `buses[].lap`, so the client's factor was 1 in both
arms. That is the null A/B the standing rules warn about, and it means no
gps-replay number ever measured this covariate before today (#206 was gated on
the rider-sim alone, correctly). The replay now serves the lap age from the
replayed detector's own departures, the same rule `rider-sim/run.ts` uses.

### The gate: the paired rider table

`rider-sim`, `ROUTES="Blue Night"`, `CHAIN="Blue Night:10:6"`, `snap909.db`,
one client tree (master d505923) and one harness; the arms differ only in
whether `PAYLOAD_PATCH` carries route 13's three lap cells. `waits.jsonl`
md5-different (`d3fcf66d…` vs `40e507ee…`). Every number below is the
corrected truth rule (#190).

**Sat 09/06, 1,349 paired waits — REFUSED.**

| | fixed (base only) | introduced (lap only) | both | neither |
|---|---:|---:|---:|---:|
| **STRAND** | **0** | **74** | 9 | 1,112 |
| **jump >= 180 s** | **0** | **555** | 279 | 384 |
| **reversal >= 60 s** | **24** | **556** | 454 | 184 |
| dropped while approaching | 0 | 0 | 133 | 1,062 |
| pin wrong | 0 | 0 | 0 | 1,195 |

- worst drift per wait: improved 83, **worsened 853**, same 259 (p50 +135 s)
- first promise |miss|: **improved 304, worsened 89**, median 110 -> 85 s
- interval at first sight: coverage 74.5 -> 77.6% at a NARROWER width (637 -> 575 s)
- the dangerous tail (`early > 60 s`) 11.9 -> 10.7%; `late > 60 s` 50.2 -> 46.9%

**Mon 09/08, 1,196 paired waits — the same shape, REFUSED.** Arms
md5-different (`a89a846d…` vs `6c9b30ec…`).

| | fixed | introduced | both | neither |
|---|---:|---:|---:|---:|
| **STRAND** | **0** | **39** | 29 | 976 |
| **jump >= 180 s** | 30 | **310** | 263 | 459 |
| **reversal >= 60 s** | 11 | **388** | 476 | 185 |
| dropped / pin wrong | 0 / 0 | 0 / 0 | | |

- worst drift: improved 133, worsened 569; first promise |miss| improved 163,
  worsened 152 (median 105 -> 90 s, a wash); coverage 82.6 -> 82.0% at 699 -> 625 s
- by slot: slot 1 jumps >= 180 s **1,067 -> 967** (one wait introduced), slot 2
  **517 -> 1,175** (448 waits introduced)

So the accuracy the cell gate promised is real — first sight improves for
three riders in four that move, the band narrows and covers more — and the
line still fails the gate that decides, by a margin no accuracy gain could
buy back. Where it fails is specific:

**Every introduced defect is in the SECOND slot.** Parsing the two numbers on
the row apart (`in 3, 64 min` = slot 1 the pinned bus, slot 2 the next
arrival) over the same 1,349 waits:

| slot | jumps >= 180 s, base | lap | waits with one, base | lap | introduced |
|---|---:|---:|---:|---:|---:|
| 1 — the bus the rider boards | 851 | 842 | 420 | 409 | **1** |
| 2 — "then N min" | 269 | **1,628** | 150 | **813** | **696** |

On a one-bus line slot 2 is the SAME bus a lap later, so its chain always
carries the whole 333 Cedar stand as a future stand — 600 s scaled by the
factor — and the `CHAIN` block puts the swing at the poll the bus LEAVES
333 Cedar: displayed drift at the departure poll p50 **+185 s**, >= 180 s on
**184 of 270** chain riders, against p50 0 s on master. A rider one hop past
Cedar read `in 3, 64 min | in 1, 60 min | in 1, 63 min` across three polls
around 00:00:30. The strand rule then fires because a >= 180 s drop lands
inside the minutes before the pinned bus arrives (`lib.ts:680`), and the
reversal rule because the number comes back a poll later.

The mechanism, from the arithmetic in `lapCorrection`: the lap a FUTURE
visit to stop `s` is priced under is `ages[s] + t`, the served seconds since
the bus last left `s` plus the nominal seconds until it is back. At the
departure poll the belief has already released the rest (a fresh fix past the
mask) while the served departure clock has not yet reset (the collector's
at-stop rule clears at 75 m), so for a poll or two the stop the bus is leaving
is priced as a visit ~30 s ahead under a lap of ~3,500 s — inside the band,
and a factor of 0.35 on a 600 s stand. One poll later the clock resets and
the stand is back. Red did not show this in section 6 because slot 2 there is
a DIFFERENT vehicle whose chain rarely carries 344 Winchester in full; the
same window exists on Red for a rider a lap away, and is worth measuring.

**gps-replay cannot see any of this**: it prices the next 1-5 stops, and the
defect is a lap ahead. Its every-column improvement above is real and is not
the number that decides. Both instruments are needed, and in this order.

**Fix before retrying, not a route switch:** in `lapCorrection`, a future
visit to the stop the bus most recently rested at must not take a lap from a
departure clock older than that rest (read the rest identity the #119 clamp
already keys on, or treat `ages[s] > r_rest` as "just left" and price the
factor at 1). Then re-run this pair; the accuracy is waiting on the other
side of it.

## 6c. The departure poll: the belief sees the bus go before the served clock does (2026-09-11)

PR #215 widened the lap cells to Blue Night (route 13), found every accuracy
column improving, and was **refused by the rider table** — strand 0 fixed / 74
introduced on Sat 09/06, 0 / 39 on Mon 09/08, every one in the card's SECOND
slot. Its section 6b names the mechanism; this section is the fix and the
same pair re-run, arm for arm, on the same evenings.

### The mechanism, read off the arms rather than argued

On a one-bus line the "then N min" slot is the same bus a lap later, so its
chain always carries the full 333 Cedar stand as a FUTURE stand, priced under
the lap the bus will have run when it gets back: `ages[s] + t`, the served
seconds since it last LEFT `s` plus the nominal seconds until it is back
(`lapCorrection`, arrival.ts). `buses[].lap` counts from the collector's
departure event, and the belief sees a departure a poll or more BEFORE that:
first the lead switches to the moving variant while the rest is still held
(`rested`, `restStop`), then the fix leaves the 125 m rest radius (`moved`),
and only then does the detector's anchor move on and the clock reset. Through
that window the served age for the stop being left still counts from the
PREVIOUS lap's departure — a lap plus a whole stand old — so the next visit is
priced under twice a lap, OUTSIDE the band, and the correction on that stand
switches off, then comes back when the clock resets. The unfixed arm reads
exactly that against master (Sat 09/06, a rider one hop past Cedar):

    master   22:59:36  in 6, 63 | 23:00:51  in 4, 61 | 23:01:21  in 5, 62
    +13      23:00:36  in 6, 66 | 23:00:51  in 4, 62 | 23:01:01  in 4, 61 | 23:01:11  in 4, 62 | 23:01:21  in 5, 66

The +13 arm sits 3–4 min above master (the bus came back early, so a longer
stand is promised next lap) and collapses to master +1 for three polls at the
departure, then returns. 6b's reading of the same polls — "a visit ~30 s ahead
under a 3,500 s lap, factor 0.35" — was the theory; the arms say the
correction is simply switched OFF (out of band), and the fix is the same
either way.

### The fix (`ownDeparture` in web/src/eta/arrival.ts, `leftStop` in filter.ts)

A served departure that predates the rest cannot be the departure from it — a
bus does not leave before it arrives — so the walk in `lapCorrection` is seeded
with the belief's own departure for that ONE stop: `depT` 0 for a bus departing
its held rest now (the lead is the moving variant, `rested` and `restStop` still
set, served age older than the rest's elapsed), and minus the seconds since the
fix left the radius for a released rest (the belief now remembers the rest it
last ended: `leftStop`, `leftSince`, `leftAt`). A served age younger than the
rest is the collector's own event and is kept; every other stop, a standing
lead (which already seeds its own stop from the residual), and every caller
with no served ages price bit-identically. `lap.test.ts` walks a synthetic
stand → held-rest departure → released → clock-reset sequence and asserts the
correction on the second slot does not step across it, and that without the
memory the released poll prices the stand uncorrected.

**Two cuts were measured and refused on the way.** The first keyed on `moved`
alone and changed nothing (arm C0906 on this branch: departure-poll drift p50
185 s on 184 riders, the same as unfixed) — the step lands one poll EARLIER,
when the lead switches to the moving variant inside the rest radius, which is
why the held rest is keyed first. The second took every named rest as a visit
and was refused by RED: on 9/4 it introduced 13 reversals in 1,374 otherwise
identical waits, all at 13:57:21 ET, where #310 had held short of Union
Station (N) and the belief had attributed the hold to the stop's APPROACH zone;
released, it read as a departure from a stop the bus was about to serve, and
the seed replaced a correct served lap (f 0.59, a long lap) with "departed just
now" (f 1) — +150 s on the second bus for one poll. A hold on the approach is
not a visit, so only a rest in the stop's own zone (`!restApproach`) is taken.

### The three arms, both evenings

Instruments exactly as #215: `rider-sim`, `ROUTES="Blue Night"`,
`CHAIN="Blue Night:10:6"`, `snap909.db`, corrected truth rule (#190),
`pair-by-route.mjs`; gps-replay on the `archive-db.ts` day trimmed to route 13
with #215's `gps-replay.ts` (which serves `buses[].lap`; applied to this branch
as a file, since #215 is unmerged). A = master client (lap cells for route 3
only), B = master client + route 13's three cells, C = this branch + route 13's
cells. B on this harness is **md5-identical to #215's B arm** (`40e507ee92ed`)
and reproduces its table to the row — that is the instrument check.

**rider-sim, paired waits, fixed / introduced** (A → B is #215; A → C is this PR):

| evening | paired | arm | STRAND | jump ≥ 180 s | reversal ≥ 60 s | first promise \|miss\| (p50) | early > 60 s | worst drift p50 | departure-poll drift p50 (≥ 180 s on) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| Sat 09/06 | 1,349 | A → B | 0 / 74 | 0 / 555 | 24 / 556 | 110 → 85 s | 11.9 → 10.7% | 70 → 230 s | 0 → 185 s (0 → 184) |
| Sat 09/06 | 1,349 | **A → C** | **0 / 0** | **0 / 76** | **38 / 101** | 110 → 85 s | 11.9 → 10.7% | 70 → 110 s | 0 → 0 s (0 → 0) |
| Mon 09/08 | 1,196 | A → B | 0 / 39 | 30 / 310 | 11 / 388 | 105 → 90 s | 17.1 → 14.2% | 125 → 185 s | 0 → 130 s (0 → 83) |
| Mon 09/08 | 1,196 | **A → C** | **0 / 8** | **34 / 60** | **22 / 75** | 105 → 90 s | 17.1 → 14.2% | 125 → 130 s | 0 → 0 s (0 → 20) |

B → C directly: Sat 74 strands fixed / 0 introduced, 479 / 0 jumps, 473 / 4
reversals; Mon 31 / 0, 260 / 0, 330 / 1. The first-sight columns are
byte-identical between B and C on both evenings (the fix touches no poll the
first sight is taken on), so the accuracy #215 measured is intact: first
promise |miss| 110 → 85 and 105 → 90 s, interval coverage 74.5 → 77.6% at a
narrower width (637 → 575 s) and 82.6 → 82.0% at 699 → 625 s, the dangerous
tail (`early > 60 s`) 11.9 → 10.7% and 17.1 → 14.2%.

**gps-replay, route 13, proximity truth, paired row for row:**

| evening | rows | arm | median \|err\| | pessimistic ≥ 120 s | optimistic ≥ 120 s | 10–90 coverage | better / worse |
|---|---:|---|---:|---:|---:|---:|---:|
| Sat 09/06 | 17,788 | A → B | 78.8 → 69.9 | 13.8 → 13.4% | 24.4 → 20.2% | 73.9 → 78.2% | 4,624 / 2,508 |
| Sat 09/06 | 17,788 | **A → C** | 78.8 → 70.3 | 13.8 → 13.6% | 24.4 → 20.2% | 73.9 → 78.2% | 4,309 / 2,461 |
| Mon 09/08 | 16,119 | A → B | 72.5 → 71.8 | 15.5 → 13.9% | 22.5 → 22.4% | 75.5 → 76.3% | 3,229 / 2,792 |
| Mon 09/08 | 16,119 | **A → C** | 72.5 → 71.9 | 15.5 → 14.0% | 22.5 → 22.4% | 75.5 → 76.3% | 3,099 / 2,781 |

B → C moves 431 and 153 standing rows (the departure polls, which gps-replay
prices for the next five stops) by +0.4 and +0.1 s of median; the moving
population is byte-identical. A → B here reproduces #215's gps table to the
decimal.

### What is left, and is NOT the departure — CORRECTED in 6d below

**This subsection is kept as the record of a wrong reading.** The Mon episode
was at 22:59:59–23:00:14 Z, not 02:59:59 Z (the 03:00 window was traced and
held nothing, which is what "not reproduced" measured); both episodes ARE
the departure poll — the bus's FIRST departure from 333 Cedar of the
evening, when the served lap clock has no age for the stop at all. Section
6d has the per-poll dump and the fix.


The residual introduced jumps (76 on Sat, 60 on Mon) are each ONE episode:
Sat 23:00–23:01 Z (70 of 76) and Mon 02:59:59–03:00:09 Z (60 of 60), the
second slot dipping ~4 min for two readings and returning, with the bus at rest
at 333 Cedar and NO fresh fix (the trace shows #38's first movement at
03:00:21 Z). A named-rider trace of the same client over the same capture from
01:40 Z does not show the dip, and a full-population run of the window from
01:40 Z has 0 of 74 riders spanning that instant with a jump — so it depends on
belief state older than 80 minutes, not on the departure. It is the open item
for the route-13 widening; strand is at master's own 1.0% on Sat and 3.7%
against master's 4.1% on Mon.

### Red, where #206 is live

Held-out ET day 2026-09-04, 13:00–19:00 UTC, `ROUTES=Red`, `POP=uniform`,
`CHAIN="Red:11:6"` (the 344 Winchester chain, so the departure polls are
watched), `model-patch-0904-lapS.json`, 1,374 paired waits, master client
against this branch: **STRAND 0 / 0, jump ≥ 180 s 0 / 0, reversal ≥ 60 s
0 / 0, dropped 0 / 0; 1,373 of 1,374 sequences byte-identical**, the one
difference a single reading's second slot 80 → 81 min for a rider at
Winchester itself. First-sight miss identical on every wait. Red's second
slot is a different vehicle, so the held-rest path has nothing to correct
there; this is the fix costing Red nothing, measured rather than argued.

### 6d. What was left: the FIRST departure, and a served age that does not exist (2026-09-11)

The residual two-reading episode was traced with a per-poll dump of
`priceRoute`'s inputs (belief, situations, `ownDeparture`, the lap walk's
`lap`/`f` per fitted stop, the rows for the rider's stop) on a named rider
boarding 129 York (stop 2) across the Sat 9/6 departure, `RIDER="Blue
Night@2@2026-09-06T22:44:00Z"`, the #217 tree, route 13's cells served.

**Where it was.** Not "at rest, no fresh fix": the capture has #57's fix
frozen 31 m from the 333 Cedar marker from 22:57:01 to 23:00:41 Z with
`last_stop_id` 43, then NEW fixes at 23:00:46 / 23:00:51 / 23:01:01 with
`last_stop_id` 10 — the pull-out — then a 60 s pause 61 m out (inside the
125 m rest radius), then away at 23:02:06. Mon is the same shape one
evening later: #38 frozen 12 m from the marker until 22:59:54, fresh fixes
from 22:59:59 Z. Both are the bus's FIRST departure from Cedar that evening
(#57 first appears at 21:36 Z and never comes within 75 m of Cedar before
22:52; #38's only earlier pass was a 59 s roll-through at 21:22 on Blue Day
that the detector never pinned).

**What the dump says**, Sat, the rider's second slot (129 York, occurrence 1):

| poll (Z) | lead | `sits` (leg 0) standing / moving mass | `ages` | `own` | next-Cedar walk `lap` → `f` | slot 2 |
|---|---|---|---|---|---|---|
| 23:00:41 | standing at 0 (Cedar), r 520 | 0.959 / 0.029 | {97: 3021, 121: 1180} — **no 10** | null (standing seeds itself) | 2496 → **1.409** (prevDep = residual 136) | 3885 |
| 23:00:46 | standing, fresh fix | 0.717 / 0.283 | same | null | 2496 → 1.409 | 3849 |
| **23:00:51** | **moving** (standingAt −1), rest still held | 0.176 / 0.824 | same, no 10 | **null** — `ages[10]` undefined | **null → 1** | **3583** |
| 23:00:56 … 23:01:11 | moving | 0.33 → 0.40 standing | | null | null → 1 | 3593 / 3569 / 3577 / 3595 |
| 23:01:16 | standing again (the pause) | 0.575 / 0.425 | | null | 2495 → 1.41 | 3818 |
| 23:02:06 | moving, released | | **{10: 0, …}** first served | | 0 + t → 1.39 | 3777 |

The mechanism in one line: **the standing variant seeds the next visit's lap
from the residual (`depT[standingAt] = rem`) whatever the served ages say;
the moving variant of the SAME leg was seeded only by `ownDeparture`, which
returned null because `ages[10]` was undefined** — the bus had not departed
Cedar yet this block, so `buses[].lap` did not name it. So the next Cedar
stand was priced f 1.41 (+240 s on a 590 s table) in one variant and f 1 in
the other, and the lead flipping between them over a shuffling pull-out was
the dip: 3849 → 3583 → 3818, "then 64 | 59 | 63 min", −266 s for six polls.
The served age first appears 80 s after the belief's departure (23:02:06 Z,
when the collector's own at-stop gate finally clears). #217 handled a served
age OLDER than the rest (`served > r`) and left an ABSENT one alone; they are
the same case — the belief has seen a departure the clock has not.

**The fix** is one predicate in `ownDeparture` (web/src/eta/arrival.ts): an
undefined or non-finite served age is treated exactly as a stale one, in both
the held-rest branch (`depT` 0) and the released branch (`depT` −(now −
leftAt)). Nothing else moves: a served age younger than the rest is still
taken as served; every stop without a rest identity, every standing lead and
every caller with no ages price bit-identically. `lap.test.ts` walks the case
(stand → held pull-out → released → served) with the stop's age absent and
asserts one correction all the way through, and that without the rest
identity the same polls price the stand uncorrected.

Re-traced on the same rider: 3849 → 3823 → 3833 → 3814 → 3823 → 3836 → 3818,
"then 64 | 63 | 63 min".

**Measured exactly as 6c, four arms.** A = master client (Red's cells only),
C = #217 + route 13's cells, D = this fix + route 13's cells; the A and C
runs are the 6c artifacts (`~/wt/eta-uncertainty/.../r13/rs`, `~/wt/lapfix/
.../lapfix/rs`), D from `~/wt/lapres/.../lapres/rs`; same captures, same
`snap909.db`, same `CHAIN="Blue Night:10:6"`, `pair-by-route.mjs`.

rider-sim, fixed / introduced:

| evening | paired | arm | STRAND | jump ≥180 s | reversal ≥60 s | dropped | first-promise \|miss\| p50 | early >60 s | coverage @ width | worst drift p50 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sat 9/6 | 1,349 | A → C (#217) | 0 / 0 | 0 / 76 | 38 / 101 | 0 / 0 | 110 → 85 s | 11.9 → 10.7% | 74.5 → 77.6% @ 637 → 575 s | 70 → 110 s |
| Sat 9/6 | 1,349 | **A → D** | **0 / 0** | **0 / 0** | **48 / 20** | 0 / 0 | 110 → 85 s | 11.9 → 10.7% | 74.5 → 77.6% @ 637 → 575 s | 70 → 70 s |
| Sat 9/6 | 1,351 | C → D | 0 / 0 | 76 / 0 | 91 / 0 | 0 / 0 | 85 → 85 s | identical | identical | 110 → 70 s |
| Mon 9/8 | 1,196 | A → C (#217) | 0 / 8 | 34 / 60 | 22 / 75 | 0 / 0 | 105 → 90 s | 17.1 → 14.2% | 82.6 → 82.0% @ 699 → 625 s | — |
| Mon 9/8 | 1,196 | **A → D** | **0 / 0** | **34 / 0** | **24 / 10** | 0 / 0 | 105 → 90 s | 17.1 → 14.2% | 82.6 → 82.0% @ 699 → 625 s | 125 → 70 s |
| Mon 9/8 | 1,212 | C → D | 8 / 0 | 60 / 0 | 67 / 0 | 0 / 0 | 90 → 90 s | identical | identical | 130 → 70 s |

Riders who saw a jump ≥180 s: Sat master 29.9%, #217 34.0%, **D 27.9%**, Mon
36.0%, 35.5%, **31.2%**; a reversal ≥60 s: Sat 49.7%, 52.1%, **45.5%**, Mon
58.0%, 60.1%, **55.0%**. Worst drift per wait p50: Sat 70 / 110 / **70** s,
Mon 125 / 130 / **70** s. The Mon episode (22:59:59–23:00:14 Z, the same
first-departure shape) is gone from D's window entirely; what remains there is
master's own +2880 s for a rider at Cedar itself when the bus pulls out. The first-sight columns are
byte-identical between C and D on both evenings — the accuracy 6b measured
is intact, and the departure-poll lurch is gone in both its forms.

**Strands under both rules** (PR #220's `audit-strands.ts`, run out of its
branch over the same saved waits — a strand there needs one named vehicle
across the drop and at the arrival): Sat, valid paired 1,195, legacy
strand both 9 / onlyA 0 / onlyB 0, attributable both 7 / 0 / 0, for A → D
and for A → C alike; Mon, valid paired 1,044, legacy both 29 / 0 / 0 and
attributable 29 / 0 / 0 for A → D (A → C: legacy onlyB 8, attributable 0 —
#217's eight Mon strands were second-slot drops with no named vehicle, i.e.
the instrument's, and D removes them under both rules). Secondary-catastrophic WAITS (the
audit's `!leader && catastrophic`): Sat A 16 / C 140 / **D 45**, Mon A 62 / C 125 / **D 66**; the 29 (Sat) and 4
(Mon) above master are the hourly re-anchor at the Cedar ARRIVAL for riders
boarding Congress / Cedar (43 → 96: "in 15, 73" → "in <1, 66", −350 s in the
second slot beside a −870 s leader jump master makes too) — present
identically in B, C and D, so they are the covariate re-pricing the Cedar
stand on an anchor event, not the departure and not this fix.

gps-replay (route 13, proximity truth, paired row for row, 17,788 / 16,119
scorable rows):

| evening | arm | median \|err\| | pessimistic ≥120 s | optimistic ≥120 s | 10–90 coverage | better / worse |
|---|---|---:|---:|---:|---:|---:|
| Sat 9/6 | A → D | 78.8 → 70.0 | 13.8 → 13.5% | 24.4 → 20.2% | 73.9 → 78.2% | 4,540 / 2,493 |
| Sat 9/6 | C → D | 70.3 → 70.0 | 13.6 → 13.5% | 20.2 → 20.2% | 78.2 → 78.2% | 259 / 64 (moving rows 4 / 0) |
| Mon 9/8 | A → D | 72.5 → 71.8 | 15.5 → 14.0% | 22.5 → 22.4% | 75.5 → 76.3% | 3,138 / 2,781 |
| Mon 9/8 | C → D | 71.9 → 71.8 | 14.0 → 14.0% | 22.4 → 22.4% | 76.3 → 76.3% | 39 / 0 (moving rows byte-identical) |

**Red, where #206 is live** (held-out 9/4, 13:00–19:00 Z, `POP=uniform`,
`CHAIN="Red:11:6"`, `model-patch-0904-lapS.json`, master client vs D):
**STRAND 0 / 0, jump ≥180 s 0 / 0, reversal ≥60 s 0 / 0, dropped 0 / 0 on
1,374 paired waits, against master AND against #217; 1,373 of 1,374 sequences
byte-identical** — the one difference is #217's own (a single reading's second
slot 80 → 81 min for a rider at Winchester), unchanged by this fix. First-sight
miss 55 s, early >60 s 13.1%, identical on every wait. `audit-strands.ts`: valid
paired 1,288, legacy strand 13 / 0 / 0, attributable 5 / 0 / 0, catastrophic
waits identical (primary 4, secondary 29). Red's first departure of a block from
344 Winchester is the same shape, but the second slot there is a different
vehicle, so the moving variant's seed prices nothing a rider sees.

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
in time order) takes it to **0.30 us**.

    loadLapFits:  21,190 ms  ->  2,435 ms

**The window was NOT shortened, and the reason is the point.** Cutting 90 days
to 45 takes the call to ~1.0 s and leaves the served SET identical — but the
set is the wrong invariant. What ships is the COEFFICIENTS, and they move:

| cell | | lapB x 1e4 | lapM (s) | lapN |
|---|---|---:|---:|---:|
| 3:11 | 90 d | -9.285 | 3,030 | 3,913 |
| | 45 d | -9.740 | 3,055 | 977 |
| 3:121 | 90 d | -10.011 | 2,820 | 41,308 |
| | 45 d | -10.476 | 2,827 | 11,937 |

Over the laps those cells actually see that is a **median 13.0 s of stand at
344 Winchester (p95 19.1, max 29.4)** and 6.3 s at Union Station (N). The
paired rider-sim result the rollout gate rests on was measured with the 90-day
fit, so shortening the window would put a configuration in front of riders that
nothing had measured — the exact failure `predictions_log` exists to end. With
`etDay` fixed the call is ~2.4 s against 21.2 s, which is the defect gone; a
third of that does not buy an unmeasured change to a coefficient a rider's
countdown is built from.

And the 30-day row is a warning, not an improvement: a THIRD Red cell appears
there, which is the day-blocked gate qualifying a cell on thinner evidence —
the very failure the per-cell bootstrap exists to refuse.

### Is the six-hourly refresh worth taking off the loop? Measured: no, and here is what is

`loadLapFits` is synchronous on the loop that serves `/api/buses`. At boot that
costs nothing — nothing is being served yet — but `LapFitCache` also refreshes
every six hours, and that lands in steady state. Measured on production
2026-09-10 rather than argued:

| | |
|---|---|
| steady-state `pollStalenessMs` (40 samples over ~60 s) | min 90, p50 2,500, p90 4,441, max 4,860 ms |
| poll interval | 5,000 ms |
| `pollSkipped` / `droppedObservations` | 0 / 0 |
| `collector.calibrated` `durationMs`, every 5 min | 996, 991, 1,068, 1,057 ms |
| `loadLapFits` after the `etDay` fix (Pi, 90 d) | 2,435 ms |
| deploy-to-deploy gap, 39 gaps over three days | p25 0.10 h, **p50 0.28 h**, p75 1.10 h, max 12.8 h |
| process lifetimes that ever reach the 6 h timer | **3 of 39, 8%** |

Three numbers settle it.

1. **The refresh almost never fires.** The median process lives 17 minutes; only
   8% of them reach six hours. What actually runs is the BOOT fit, and that is
   free.
2. **When it does fire it delays one poll, it does not skip one.** The interval
   is 5 s and staleness already runs to 4.9 s, so one delayed poll takes a
   single reading to about 7.3 s and `pollSkipped` stays 0.
3. **It is not the dominant term and it is not close.** `calibrate` itself
   stalls the loop **~1.0 s every 5 minutes** — a 0.33% duty cycle — against
   the fit's 2.4 s every 6 hours at most, 0.011%. **The fit is thirty times
   less of the loop than the calibration it rides on.** If anything here should
   be chunked it is `calibrate`, and that is a separate piece of work with a
   thirty-fold better payoff.

**The defect worth fixing is that none of this was visible.**
`CalibrationStats.durationMs` times `calibrate()` and EXCLUDES
`lapFitsCache.get()` — which is precisely where the 21 s lived, in a log line
that reported 996 ms while the loop had been held for twenty-one seconds.

**Fixed (2026-09-10).** `runCalibrate` times the get itself and
`collector.calibrated` now carries two fields beside `lapFitCount`:

| field | |
|---|---|
| `lapFitMs` | what `lapFitsCache.get()` cost. ~0 on the 5-minute cadence (a cached get), its own number on the six-hourly refresh and at boot |
| `loopHeldMs` | `durationMs + lapFitMs` — **the number to read**, because it is the whole synchronous hold, which is what `pollStalenessMs` will show |

`durationMs` is left exactly as it was: it is the calibrator's own cost, and
keeping the two apart is what makes a slow FIT distinguishable from a slow
calibration. The timing is a wrapper around a call that already happened on
this line, so nothing about when the fit runs, how often, or what it returns
changed — the 90-day window and both gates are untouched.

`src/collector/collector.fitClock.test.ts` is the regression, and its middle
case is the 2026-09-10 shape at 1/100 scale: a stubbed cache that busy-waits
120 ms, then an assertion that `lapFitMs` and `loopHeldMs` both see it **while
`durationMs` stays under it**. Two of its three cases fail on the code as it
shipped, which is the point — an instrument that can go blind silently is how
this hid for a day.

## 8. After the widening: the layover deficit re-measured on BOTH served lines (2026-09-12)

The lap covariate went live on Blue Night at **2026-09-12 00:5x ET** (#217 then
#218, master 1d359a8), so `dwells` now serves five lap-fitted cells — Red 3:11
and 3:121, Blue Night 13:10 (333 Cedar), 13:97 and 13:121. Every layover number
quoted in the 2026-09-11 investigations predates that, including the one that
matters most: the standing-freeze work concluded that the deficit on layover
rests splits **40.5% ratchet / 59.5% estimate** with a median shown deficit of
171 s, and named the estimate half — the pooled stand median — as what the lap
covariate exists to attack.

So: did the ship move the half it was aimed at? Measured, not argued, with
`scripts/eta-replay/postlap/` (the generalisation of `../trough/`, same
arithmetic, now per route and per cell, with the arms as a PAYLOAD patch).

### The days, and why these

| day | line | positions | window | buses |
|---|---|---:|---|---|
| 2026-09-10 | Red | 23,356 | 06:57–18:19 ET | #309 #310 #316 |
| 2026-09-11 | Red | 13,212 | 06:59–13:31 ET | #304 #310 #316 |
| 2026-09-10 | Blue Night | 8,327 | 17:58–23:59 ET | #41 #46 |
| 2026-09-11 | Blue Night | 2,168 | 20:59–23:59 ET | #46 |

`raw_positions` is swept at six hours, so an archived day holds a full service
day only where the Pi's capture supplemented it: 09-10 is the last such day for
both lines. Red 09-11 comes from the production snapshot the trough
investigation took that afternoon — deliberately, because **09-11 is the day the
−171 s figure was measured on**, so the comparison is direct.

**There is no post-ship day, and there cannot be one yet.** The fits shipped at
00:5x ET today and today is a Saturday: `route_active` reports 3 and 13 both
false, and neither line has run since the ship. So every number here is the
CURRENT client replayed over pre-ship days, with the covariate served and
withheld on the same polls. That is the right instrument for this question — a
paired arm cannot be confounded by the day, which is what
[[project-red-bias-2026-09-11]] was retracted for — but note the honest caveat:
the 90-day fit window includes these days, so the served arm is in sample here.
The held-out evidence for these cells is the cell gate's own day-blocked
cross-validation (§5a): 13:10 **−120.9 s**, 3:121 −64.0 s, 3:11 −54.8 s.

**Fidelity.** Red 09-10, the WITHHELD arm against `predictions_log`'s own rider
rows for that day (production's lap correction was not yet effective on Red —
#217/#218 are what made it so): 231 rows paired inside the log's 15 s bucket,
replay − logged **median +10 s**, p10 −24, p90 +52, 60.2% within 30 s. Blue
Night 09-10, the same arm priced at the stops riders ACTUALLY watched — 333
Cedar, Prospect / Sachem (N), 100 Church Street South, 129 York, Elm / York,
since the cells' own +3 riders are nobody's watched stop on that line: **248
rows paired, median −6 s**, p10 −252, p90 +23, **73.8% within 30 s**. Production
served no route-13 fit that evening, so the withheld arm is the one to check
against the log. Read from those farther stops the chains are three to five
times longer (median mixture 1,505–1,518 s against 263–833 s) and both Blue
Night cells read the same DIRECTION with a larger magnitude — +102 to +126 s
signed, 46–52% of rows with the bus beating the promise by two minutes. That is
chain length, not a second estimate of the cell.

### What the covariate did, per route and per cell

Rows are what a rider three hops past the resting cell would have read; rests
are selected on the detector's own `arrived_at → departed_at` span ≥ 300 s.
`signed` is `shown − actual` (negative = the rider waits longer than told),
`wait` the share ≥ 120 s late to the rider, `early` the share where the bus beat
the promise by ≥ 120 s, and `split` the deficit seconds divided into the part
the #119 ratchet holds and the part the estimate is low by.

| day | cell | n (rests) | signed off → on | \|err\| off → on | wait off → on | early off → on | split off → on |
|---|---|---:|---|---|---|---|---|
| 09-10 | **Red, both cells** | 3,867 (59) | −100 → −105 | 144 → **118** | 46.3 → 46.9% | 11.1 → **2.7%** | 28/72 → 28/72 |
| 09-10 | Red 3:11 344 Winchester | 1,950 (30) | −162 → −162 | 168 → 162 | 57.9 → 58.6% | 3.0 → 0.2% | 40/60 → **39/61** |
| 09-10 | Red 3:121 Union Station (N) | 1,917 (29) | −18 → −53 | 131 → **95** | 34.4 → 35.0% | 19.4 → **5.3%** | 6/94 → 10/90 |
| 09-11 | **Red, both cells** | 3,100 (34) | −77 → −102 | 116 → 122 | 43.3 → 46.1% | 5.7 → 4.7% | 27/73 → 30/70 |
| 09-11 | Red 3:11 344 Winchester | 1,686 (19) | −190 → −181 | 190 → 182 | 62.3 → 61.2% | 0.0 → 0.0% | 34/66 → **40/60** |
| 09-11 | Red 3:121 Union Station (N) | 1,414 (15) | +9 → −49 | 76 → 94 | 20.6 → 28.1% | 12.5 → 10.3% | 0/100 → 0/100 |
| 09-10 | **Blue Night, all cells** | 981 (27) | +60 → **+5** | 122 → **74** | 16.3 → 17.2% | 35.4 → **14.1%** | 1/99 → 2/98 |
| 09-10 | BN 13:10 333 Cedar | 871 (14) | +62 → **+1** | 125 → **75** | 18.4 → 19.4% | 35.7 → **11.9%** | 0/100 → 2/98 |
| 09-10 | BN 13:97 Peabody Museum | 36 (9) | −1 → 0 | 17 → 17 | 0.0 → 0.0% | 0.0 → 0.0% | 3/97 → 2/98 |
| 09-10 | BN 13:121 Union Station (N) | 74 (4) | +117 → +115 | 117 → 115 | 0.0 → 0.0% | 48.6 → 45.9% | 53/47 → 53/47 |
| 09-11 | **Blue Night, all cells** | 154 (5) | +107 → **+19** | 107 → **31** | 0.0 → 0.0% | 34.4 → **9.1%** | 90/10 → 0/100 |
| 09-11 | BN 13:10 333 Cedar | 111 (2) | +111 → **+8** | 111 → **24** | 0.0 → 0.0% | 36.9 → **0.0%** | – → 0/100 |
| 09-11 | BN 13:121 Union Station (N) | 38 (1) | +87 → +96 | 87 → 96 | 0.0 → 0.0% | 31.6 → 36.8% | 90/10 → – |

**How much of that is the covariate and not the day: all of it, by
construction.** The arms are the same polls, the same truth and the same code,
differing only in whether the served tables carry `lapB`/`lapM`/`lapN`. Rows the
two arms priced identically: Red 09-10 11.8%, Red 09-11 26.4%, Blue Night 09-10
23.0%, Blue Night 09-11 0.6%; where they differ the median move is −9, −11, −41
and −90 s respectively. The covariate is live and it is doing most of the work
on Blue Night.

### The judgement: the estimate half shrank where the ship aimed, and NOT on Red

- **Blue Night 333 Cedar is fixed, or nearly.** |error| halves (125 → 75 s on
  09-10, 111 → 24 s on 09-11), the signed error goes from +62 to +1 s, and the
  share where the bus beat the promise by two minutes falls 35.7 → 11.9% and
  36.9 → 0.0%. This was the largest held-out margin on the network (−120.9 s)
  and it reads like it. The deficit that REMAINS there is still 98% estimate,
  but it is a much smaller deficit.
- **Red's 344 Winchester is untouched: −162 s signed in BOTH arms** on 09-10
  (−190 → −181 on 09-11), `wait ≥ 120 s` 58.6%, per-row estimate part 104 → 103 s.
  Its split is **38.6–42.0% ratchet / 58.0–61.4% estimate** — the 40.5 / 59.5
  figure reproduced to within a point and a half, on the current client, with
  the covariate on.
- **Why the asymmetry, measured on the same days**: the realised lap → stand
  slope at 13:10 was **−0.816** (09-10) and **−0.939** (09-11), against served
  `lapB·1e4` −10.1; at Red's 3:11 it was **−0.025** on 09-10 — no lap signal
  that day at all — so the factor sat at 1.00–1.10 and had nothing to correct.
  The covariate is not weak on Red; the day's stands simply were not a function
  of the lap. 3:121 is in between (realised −0.158) and still gains 36 s of
  |error| on 09-10.
- **What Red's covariate DOES buy is the pessimistic tail**: route-wide
  `early ≥ 120 s` 11.1 → 2.7% (09-10), and at Union Station 19.4 → 5.3% with
  |error| 131 → 95 s. It also costs a little on 09-11's Union Station (76 → 94 s
  |err|, +9 → −49 s signed), the day whose stands there ran 625 s against a
  served 374 — i.e. the day the correction was pointed the wrong way.
- **So the pooled stand median is STILL the dominant term of what is left**, on
  Red at 344 Winchester (59–61% of the deficit seconds) and route-wide (70–72%).
  The ratchet's 40% has not grown and has not shrunk. Nothing here overturns the
  operator's open trade on it.

Two incidental findings worth keeping:

- **13:97 (Peabody Museum) is a measured no-op**, |error| 17 s in both arms —
  which is what §5a predicted for a cell admitted on a −1.5 s margin, and is
  the evidence that the gate's tiny-effect admissions are harmless rather than
  merely argued. Its served `q50` is **0 s** with `pstop` 0.54: half its visits
  are roll-throughs, so its 525 s *arrivals* span is anchor residence time, not
  standing time. `summarise.mjs` prints both spans for exactly this reason.
- **13:121 (Union Station (N)) on Blue Night fails the other way.** The card
  there is PESSIMISTIC by ~115 s and **53% of its deficit is the ratchet**, not
  the estimate — the mirror image of 344 Winchester. Served `q50` 39 s with an
  sd of 518 s. The covariate is a near no-op there (115 vs 117 s). That cell
  wants a different fix from the stand median, and it is the one BN cell a
  rider-facing complaint would come from.

### No rider simulator was run, deliberately

Nothing in this measurement changes behaviour — the arms are a payload patch and
the only code touched is an inert trace applied out of tree — so there is no
rider gate to clear. Route 13's rider gate was run when the widening shipped
(§6c/§6d: jump ≥ 180 s introduced 0 on both paired evenings, reversals net
fixed, Red byte-identical). A rider pair IS required before widening to a new
route, per §5b.

### Where a fit would pay most next (the input to the next widening)

Ranked by the cell gate's own held-out margin, then by whether the cell actually
carries layovers (served `q50`, and real visit spans on 09-10), then by demand
(rider-surface `predictions_log` rows that day), with fold routes set aside —
one stop id cannot carry two passes of an out-and-back, which is why Purple
10:10 (−55.5 s) and Green 9:22 (−40.5 s) are excluded rather than ranked:

| rank | line | cells (held-out Δ) | served q50 | visits ≥ 300 s on 09-10 | rider rows |
|---|---|---|---:|---:|---:|
| 1 | **Brown (19)** | 19:145 Science Park Garage **−41.3**, 19:115 State St −21.1, 19:121 Union Station −10.5 | 673 / 72 / 723 | 10 / 0 / 10 | 1,176–1,480 |
| 2 | **Pink (8)** | 8:149 York / Cedar **−61.3**, 8:125 VA Hospital −21.1 | 355 / 144 | 26 / 11 | 112–759 |
| 3 | Gold (15) | 15:10 333 Cedar −11.6 | 391 | 6 | 187 |
| – | Orange Night (14), Orange East (17) | 14:10 −19.3, 17:10 −28.4 | 90 / 76 | 3 / 2 | 1,135 / 410 |
| – | Grocery Ham (18), Blue Weekend (4) | 18:53 −32.9, 4:98 −25.1 | 135 / 25 | 0 / 0 | 0 |

**Brown first.** It is the only non-fold line with two genuine layover cells
(Science Park Garage stands a median 555 s, Union Station (N) 805 s), it has the
fourth-largest rider volume of any line, and three of its cells pass the gate.
Pink carries the single biggest non-fold margin (−61.3 s at York / Cedar, 26
long stands in one day) and is ranked second only because it is the least
watched line AND the line the split stand tables burned 280 → 431 strands — its
rider pair is the one that will actually decide it, exactly as §5b says. Orange
Night and Orange East have the demand but not the stands (q50 90 s and 76 s:
there is almost nothing to correct). Grocery Ham and Blue Weekend have no
weekday exposure at all and would have to be gated on a weekend day.
