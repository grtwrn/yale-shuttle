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

### What is left, and is NOT the departure

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
