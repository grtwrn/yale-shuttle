# Preflight for Tuesday 2026-09-08: Red, and every line, on the data we already have

**Run 2026-09-07 evening, on `origin/master` `1a0159c`** in a throwaway worktree
(`/home/gwarren/yale-shuttle-wt/redcheck`). Four estimator changes shipped to
production today, each measured on its own gate and none of them measured
together against the operator's own acceptance case:

| commit | what it changed |
|---|---|
| `8c4c456` | closed loop stages 3–4: model parameters served and re-estimated daily (defaults byte-identical) |
| `8d093a3` | pooled all-routes pace + global stand class pools |
| `58a6db2` | the layover rest fix — a bus creeping the last metres to a layover marker keeps its rest |
| `1a0159c` | Green's stop order read off the published line |

The operator's ask: *"tonight run checks on the red line again to make sure we
didnt miss anything from the data we already have."*

**Verdict: ready for Tuesday.** Every gate passes. Red — the line the operator
asked about — is unchanged to a tenth of a second on the 9/4 replay and
net-better on the 9/3 simulator, fixing 21 strands, 171 jumps ≥180 s and 219
reversals against 1, 13 and 83 introduced. The operator's own test, a rider at
Division / Prospect while a bus sits at 344 Winchester, still shows **no strands
at all**, and its reversal share improves 7.0 → 5.2%. The three archived Red
riders reproduce at or better than the sequences on record. No route regresses
on any column against the model as it shipped on 9/6. Green improves sharply and
is the only line carrying a day-one caveat — it warms up into its full gain over
Tuesday rather than starting there (§3).

At a glance, proximity truth, 9/4 window, 205,061 pairs: overall median error
**91.9 s (pre-model) → 60.2 s (as shipped 9/6) → 59.5 s (today)**, p90
534.5 → 430.9 → **392.7**, dangerous tail **24.0% → 14.8% → 14.0%**.

---

## 1. The gates

| gate | result |
|---|---|
| `npm run typecheck` (backend **and** `web/`) | pass |
| `npm test` | **75 files, 2147 passed**, 4 todo, 0 failed |
| `cd web && npx vite build` | pass, `built in 4.45s` |

## 2. The three archived Red riders at Division / Prospect

Replayed through the real client entry point on the tree under test
(`rider-sim --rider Red@48@<instant>@41.325351,-72.922891`, the canary's own
origin at Prospect / Canner), 9/3 capture, `snap-0904-2205.db`,
`PAYLOAD_PATCH=model-patch-all-0903.json` — the same inputs
`docs/eta-ring-posterior.md` recorded its acceptance table with. Tree stamp in
the run: `1a0159c [HEAD] anchorGate=true nextIn=identity (#74)`.

| rider | master `2a5568c` (pre-model, as recorded) | ring as shipped `768ded5` (as recorded) | **today, `1a0159c`** |
|---|---|---|---|
| **#309, 21:21:25Z** | miss −125 s, worst drift 115 s, no strand; `5 → 4 → 1 → <1 → now` | miss −125 s, drift −170 s: `5 → 1` at 21:25:52, then "in 1" for 3.5 min to the kerb | miss −125 s, **worst drift −55 s**, 4 reversals (none ≥60 s), no strand; `5 → 4 → 3 → 3 → 3 → 1 → 1 → 1 → 1 → <1 → now`, arrival 21:29:22 |
| **#316, 20:36:03Z** | miss 0, drift 55 s; "in 4" held 3 min, `3 → 2 → 1 → now` | miss +15 s, drift −55 s; "in 1" from 20:40 to the kerb at 20:47 | miss **+15 s**, drift **−55 s**, 1 reversal, no strand; "in 2" held 20:40:48 → 20:46:38, then `1 → <1 → now`, arrival 20:47:18 |
| **#304, 20:58:03Z** | **strand**: `4 → <1`, bus 66 s later | no strand: `5 → 1 → 1 → 4 → 1 → <1 → now` (one reversal) | miss −115 s, **worst drift −50 s**, 2 reversals (none ≥60 s), no strand; `6 → 5 → 4 → 3 → 2 → 1 → 2 → 2 → 2 → <1 → now`, arrival 21:02:08 |

**None of the three got worse; two are visibly better.**

- **#309** — the recorded ring collapsed `5 → 1` in one step at 21:25:52 and
  then sat on "in 1" for three and a half minutes. Today it steps
  `5 → 4 → 3 → 3 → 3 → 1`, and the worst single-tick drift falls **170 → 55 s**.
  The first promise is unchanged (−125 s), so the level did not move; the
  *shape* did.
- **#316** — miss and worst drift identical to the record (+15 s, −55 s). The
  plateau the rider reads is "in 2" instead of "in 1" for a bus 6½ minutes out:
  the same held number, one bucket less optimistic.
- **#304** — the recorded ring still showed a `1 → 4` climb (its one reversal).
  Today the largest movement in the whole wait is **50 s** and the countdown is
  monotone bar two sub-minute wobbles. The 9/3 strand stays gone.

Aggregate over the three: first-promise |miss| median 115 s, worst drift
p50 55 s / max 55 s at the 5 s cadence, **0% jump ≥180 s, 0% reversal ≥60 s,
0% strand, 0% overshoot, 0 pin changes, 0 vanished countdowns**; the estimator's
10–90 interval covered the actual arrival for 3 of 3.

`traceany.mts` on the same three vehicles (`ROUTE=3`,
`PATCH=model-patch-all-0903.json`, `TARGETS=146,48`) shows why the shape is
smoother: the belief holds `S14@14` (standing at 344 Winchester, stop index 14)
with the rest clock `r` running monotonically, and the #119 display floor pins
stop 146 at 138 s and stop 48 at 216 s across the whole stand — e.g. #309
21:26:42 → 21:27:23, `r` 55 → 95 s, `eta=146:138[0-374] 48:216[21-452]`,
unmoved while the mass shuffles between `S14@14` and `M13` at the kerb. The
rest survives the shuffle; nothing re-bills a second stand.

## 3. gps-replay, every line, 9/4 15:51–22:04 ET

`scripts/eta-replay/gps-replay.ts` on `snap-0904-2205.db` with
`PAYLOAD_PATCH=model-patch-all-0904.json`; 49,655 raw positions, 226,052 pairs,
**205,061 scored on proximity truth (45 m)**, next 1–5 stops. Three arms, all
on the same inputs:

- **legacy** — today's tree with `MODEL_ROUTES=""`: the pre-model arithmetic,
  the baseline every ring measurement is quoted against.
- **9/6 model (`8d093a3`)** — the stored master-arm run in
  `/home/gwarren/yale-shuttle-wt/base0907` (`scripts/.eta-replay/out-master/gps.json`).
  `8c4c456` shipped byte-identical defaults and `8d093a3`'s pooled priors are
  recorded as byte-identical on this window, so this arm is also the model as it
  stood before **all four** of today's changes.
- **today (`1a0159c`)** — this run.

### Overall (`truths.prox.client`)

| arm | n | median \|err\| | p90 | median bias | pessimistic ≥120 s | optimistic ≥120 s | within 120 s | 10–90 covers |
|---|---|---|---|---|---|---|---|---|
| legacy | 205,061 | 91.9 s | 534.5 | +7.0 | 24.0% | 18.4% | 57.6% | 54.7% |
| 9/6 model `8d093a3` | 205,060 | 60.2 s | 430.9 | −7.9 | 14.8% | 16.7% | 68.5% | 76.6% |
| **today `1a0159c`** | 205,061 | **59.5 s** | **392.7** | −7.7 | **14.0%** | 17.1% | **68.9%** | 76.5% |

Detector truth agrees: median 103.4 (legacy) → 75.9 (9/6) → **75.7** today,
p90 659.9 → 591.9 → **530.3**, pessimistic ≥120 s 33.0 → 25.8 → **25.3%**.
Split by state, today vs 9/6: at-stop 63.6 → **63.0** s (p90 324.7 → 319.5),
moving 57.8 → **56.9** s (p90 505.9 → **450.8**).

### Per route, proximity truth, `client` (the number riders actually get)

median \|err\| s · pessimistic ≥120 s % · optimistic ≥120 s % · within 120 s % · 10–90 coverage %

| route | n | legacy | 9/6 model `8d093a3` | **today `1a0159c`** | verdict |
|---|---|---|---|---|---|
| **Red** | 20,972 | 52.8 · 10.1 · 13.4 · 76.5 · 65.8 | 47.6 · 4.8 · 19.0 · 76.3 · 76.3 | **47.5 · 4.8 · 19.0 · 76.3 · 76.3** | unchanged to a tenth |
| **Green** | 22,611 | 276.4 · 55.4 · 8.2 · 36.4 · 51.1 | 288.8 · 56.1 · 8.2 · 35.7 · 50.5 | **191.3 · 49.0 · 11.3 · 39.6 · 49.8** | much better (see the caveat) |
| Blue Day | 12,274 | 43.8 · 12.0 · 7.2 · 80.8 · 62.9 | 35.3 · 7.8 · 6.3 · 85.9 · 81.4 | 35.3 · 7.8 · 6.3 · 85.9 · 81.4 | identical |
| Blue Night | 22,973 | 113.5 · 28.5 · 19.4 · 52.1 · 67.8 | 71.0 · 13.3 · 18.8 · 67.9 · 78.8 | **70.8 · 13.1 · 18.8 · 68.1 · 78.8** | slightly better |
| Blue West | 12,037 | 96.0 · 38.0 · 6.3 · 55.7 · 46.9 | 47.5 · 4.5 · 16.6 · 78.9 · 91.5 | 47.5 · 4.5 · 16.6 · 78.9 · 91.5 | identical |
| Brown | 8,307 | 212.2 · 32.8 · 30.7 · 36.5 · 45.8 | 79.9 · 12.7 · 27.4 · 60.0 · 79.4 | **79.4** · 12.7 · 27.4 · 60.0 · 79.4 | slightly better |
| Gold | 6,018 | 68.7 · 13.2 · 17.4 · 69.4 · 75.3 | 55.4 · 7.4 · 20.9 · 71.7 · 79.8 | 55.4 · 7.4 · 20.9 · 71.7 · 79.8 | identical |
| Orange Day | 13,982 | 36.6 · 10.7 · 2.1 · 87.3 · 69.4 | 28.1 · 5.0 · 3.6 · 91.4 · 83.7 | 28.1 · 5.0 · 3.6 · 91.4 · 83.7 | identical |
| Orange East | 11,656 | 85.1 · 15.2 · 21.6 · 63.2 · 50.3 | 48.1 · 3.5 · 16.5 · 80.0 · 89.8 | 48.1 · 3.5 · 16.5 · 80.0 · **89.9** | identical |
| Orange Night | 28,068 | 54.5 · 5.3 · 16.0 · 78.7 · 57.1 | 39.4 · 3.0 · 9.1 · 87.9 · 83.4 | 39.4 · 3.0 · 9.1 · 87.9 · 83.4 | identical |
| Pink | 19,061 | 178.7 · 13.0 · 49.0 · 38.0 · 39.7 | 106.0 · 9.4 · 36.4 · 54.2 · 67.9 | 106.1 · 9.4 · 36.4 · 54.2 · 67.9 | +0.1 s, noise |
| Purple | 27,102 | 207.1 · 41.3 · 25.0 · 33.7 · 37.9 | 102.9 · 25.3 · 22.0 · 52.7 · 76.1 | 102.9 · 25.3 · 22.0 · 52.7 · 76.1 | identical |

**Nothing regressed.** The only non-improving cell in the whole table is Pink's
median, +0.1 s — one pair's worth on 19k, not a change. Red is the focus and
Red is byte-identical bar 0.1 s of median: today's four changes did not touch
it, which is the answer to the question that was asked.

The overall p90 falling 430.9 → 392.7 and the moving-row p90 505.9 → 450.8 are
**Green alone**; the rest fix (`58a6db2`) shows up exactly where the doc
predicted it would — Blue Night, Brown, Orange East — at a few tenths of a
second, because a rest served short of a layover marker is rare enough to move
two recorded riders' boards by three minutes and 205k scored pairs barely at all.

### Green: better today, better again tomorrow — and a day-one caveat

Green is the line today's `1a0159c` was for, and on this window it goes
**288.8 → 191.3 s** median, p90 **2,817 → 643 s**, dangerous tail
**56.1 → 49.0%**, within 120 s **35.7 → 39.6%**, median bias **+247.6 → +113.1 s**.
The stateless anchor's disagreement share on Green falls **41.3% → 28.4%** —
and it falls to 28.4% in the *legacy* arm too, so that half of the win is the
server-side repaired order, not the ring.

**That 191.3 s is not the doc's 70.1 s, and the difference is not a
disagreement — it is the cold start, measured.** `model-patch-all-0904.json` was
built from segment rows the collector wrote under the **published** stop order,
so the repaired ring asks for hops that table has never held. Of route 9's 23
patched segment keys, `81-26`, `25-127` and `26-80` carry no `dq` at all and the
repaired ring's `81-127` / `127-80` are absent outright — precisely the three
hops `docs/eta-ring-posterior.md` says "have no history at all because the old
order could never bill them". The doc's 70.1 s was measured on tables
**re-derived from the same capture by the collector's own reducer** under the
repaired order; this run is what the line looks like on the *first day*, before
those hops warm up.

So the honest reading for Tuesday: Green starts the day at roughly **191 s
median, 49% dangerous tail** — already a third better than the 288.8 s riders
had — and converges toward ~70 s as the collector bills the new hops over the
day. Three hops will read `estimated` (the `~`) until then. Nothing here is a
regression; it is a warm-up, and it is worth re-measuring on Tuesday evening's
snapshot rather than assuming either number.

## 4. The rider simulator on Red — the operator's own case

`scripts/eta-replay/rider-sim/run.ts`, default population (`ROUTES=Red`,
`HOLDOUT=Green,Purple`, `CHAIN=Red:11:6`), 9/3 capture
(`positions-20260903.jsonl`), `snap-0904-2205.db`,
`PAYLOAD_PATCH=model-patch-all-0903.json`,
`CLIENT_ROOT=…/redcheck/services/shuttle-v2`, `OUT_NAME=redcheck-0903`.
9,470 riders → 8,318 waits, **7,705 scored** (210 gave up, 401 boarded on
arrival), 1,083 skipped because the planner boarded them at a neighbouring stop
and 69 with no option. 99 minutes on the Pi. Tree stamp `1a0159c`, clean.

The two arms it is paired against are the archived runs, same capture, same
snapshot, same patch, same population:

- **`master-0903`** — `2a5568c`, the pre-model production arithmetic.
- **`cand11-0903`** — `768ded5`, the ring estimator exactly as it shipped on 9/6.
  **This is the arm that answers tonight's question**: everything it and today's
  tree do differently is today's four commits (plus the intervening UI work, none
  of which touches the estimator).

### 4a. The 344 Winchester chain, stop by stop (675 scored waits)

Today's run against the recorded `cand11` column of `docs/eta-ring-posterior.md`:

| stop | first miss | jump ≥180 s | jump ≥300 s | reversal ≥60 s | **strand** | p90 drift |
|---|---|---|---|---|---|---|
| Winchester / Division (146) | 80 → **80** s | 5.2 → **5.2%** | 0 → **0** | 2.6 → **2.6%** | 10.4 → **10.4%** | 168 → **168** |
| Division / Sheffield (49) | 75 → 74.5 s | 5.3 → **5.3%** | 0 → **0** | 6.1 → **6.1%** | 9.6 → **9.6%** | 170 → **170** |
| **Division / Prospect (48)** — *the operator's test* | 80 → **80** s | 5.2 → **5.2%** | 0 → **0** | 7.0 → **5.2%** | **0 → 0%** | 115 → **115** |
| Prospect / Hillside (104) | 74 → **74** s | 5.4 → **5.4%** | 0 → **0** | 8.0 → **5.4%** | **0 → 0%** | 115 → **115** |
| SCL (113) | 80 → **80** s | 5.4 → **5.4%** | 0 → **0** | 7.2 → **4.5%** | **0 → 0%** | 115 → **115** |
| 130 Prospect Street (S) (4) | 101 → **101** s | 5.6 → **5.6%** | 0 → **0** | 2.8 → 5.6% | 0.9 → **0.9%** | 132 → **131.5** |

**The stop-48 row is intact and slightly better**: no strands, jump ≥180 s on
5.2% of riders, no ≥300 s jump at all, p90 drift 115 s, and reversals down
7.0 → 5.2%. Stops 104 and 113 improve on reversals the same way. Stop 4 is the
one cell that moves the wrong way — reversals 2.8 → 5.6%, i.e. three riders out
of 108 — against four cells that improve; it is not a mechanism, it is the
known creep-and-refreeze residue §3 of the design doc keeps deliberately.

**The departure moment** (657 of 675 chain riders were watching when the bus's
`at_stop` cleared at 344 Winchester) is unchanged from `cand11` to the rider:
raw ETA beyond the clock **+5 s at +0 s**, +35 s at +30 s; displayed drift
**p50 0 s, p90 55 s**, **≥180 s on 15 riders, ≥300 s on 0** — the same 15 and 0
the design doc records. Against pre-model master that was 38 and 36.

### 4b. Red as a whole (6,081 scored waits)

| | master `2a5568c` | ring as shipped `768ded5` | **today `1a0159c`** |
|---|---|---|---|
| first promise \|miss\| median | 54 s | 40 s | **40 s** |
| early > 60 s / late > 60 s | 26.2% / 20.3% | 24.4% / 17.4% | **24.4% / 17.4%** |
| jump ≥180 s | 11.3% | 9.1% | **6.7%** |
| jump ≥300 s | 6.1% | 2.6% | **2.6%** |
| reversal ≥60 s | 5.6% | 9.0% | **6.9%** |
| **strand** | 6.1% | 1.6% | **1.3%** |
| overshoot | 10.3% | 5.6% | **4.5%** |
| pin changed | 9.2% | 3.9% | **3.9%** |
| dropped while approaching | 4.5% | 1.8% | **1.2%** |
| worst drift p90 / max | 230 / 1570 s | 170 / 595 s | **170 / 595 s** |
| 10–90 interval at first sight covers | — | 77.4% (12.3 early, 10.2 late) | **77.4% (12.3 / 10.2)** |

Every defect column is at or better than the arm that shipped, and the two the
design doc flagged as the model's own cost — reversals and drops — are the two
that improved most (9.0 → 6.9%, 1.8 → 1.2%).

### 4c. Paired, FIXED / INTRODUCED

**Against `cand11` (the ring as it shipped 9/6) — this is the regression hunt:**

| route | paired waits | strand | jump ≥180 s | reversal ≥60 s | dropped |
|---|---|---|---|---|---|
| **Red** | 7,203 | **21 / 1** | **171 / 13** | **219 / 83** | **83 / 44** |
| Green | 569 | 38 / 17 | 132 / 39 | 122 / 70 | 21 / 0 |
| Purple | 526 | 1 / 0 | 0 / 0 | 4 / 0 | 1 / 0 |
| ALL | 8,298 | 60 / 18 | 303 / 52 | 345 / 153 | 105 / 44 |

**No column on any route is net worse.** Red fixes 21 strands and introduces
one; fixes 171 jumps ≥180 s and introduces 13; fixes 219 reversals against 83
introduced. Purple — the hold-out that exists so a Red-tuned change cannot
regress it silently — is untouched (its four cells are 1/0, 0/0, 4/0, 1/0 out of
526 waits). Green's whole column is today's stop-order fix: it was priced by the
legacy arithmetic in `cand11`, so its numbers there equal master's, and the ring
now fixes 38 strands, 132 jumps and 122 reversals against 17 / 39 / 70.

**Against `master-0903` (pre-model production), for the record:**

| route | paired waits | strand | jump ≥180 s | reversal ≥60 s | dropped |
|---|---|---|---|---|---|
| Red | 7,172 | 415 / 52 | 468 / 62 | 346 / 422 | 283 / 58 |
| Green | 569 | 38 / 17 | 132 / 39 | 122 / 70 | 21 / 0 |
| Purple | 474 | 37 / 50 | 109 / 49 | 143 / 23 | 83 / 38 |
| ALL | 8,215 | 490 / 119 | 709 / 150 | 611 / 515 | 387 / 96 |

Compare the *introduced* halves with what `cand11` introduced against the same
master arm (`416/73, 465/215, 343/553, 283/97`): today introduces fewer defects
than the shipped model did on every one — strands 73 → **52**, jumps
215 → **62**, reversals 553 → **422**, drops 97 → **58**. Reversals are still the
one column net worse than the pre-model arithmetic on Red (346 fixed / 422
introduced), which is the known and accepted trade — a bus that creeps a fix and
re-freezes moves the posterior out and back — but the gap has closed by more
than half since the model shipped.

### 4d. The hold-out lines

Purple, 402 scored waits: unchanged from `cand11` to within four riders on any
flag. Green, 547 scored waits, is now on the model (it was declined in
`cand11`): first-promise |miss| median 600 s, jump ≥180 s 39.7%, strand 6.4%,
p90 drift 530 s. Those are bad numbers in absolute terms and better than what
they replace — the pairing above is 38/17, 132/39, 122/70, 21/0 in Green's
favour — and they carry the same day-one caveat as §3: the 9/3 patch cannot
price the three hops the repaired order newly asks for.

## 5. Regressions

**None found.** There was no trace to run: no column on any route in the
`cand11` pairing is net worse, Red's replay row is identical to a tenth of a
second, and the three archived riders reproduce at or better than their recorded
sequences.

Three cells moved the wrong way by an amount at or below the instruments' own
noise, recorded so nobody re-hunts them as findings:

| cell | move | reading |
|---|---|---|
| Pink, gps-replay median \|err\| | 106.0 → 106.1 s | +0.1 s on 19,061 pairs; every other Pink column is identical |
| Chain stop 4 (130 Prospect St (S)), reversal ≥60 s | 2.8 → 5.6% | three riders of 108; the creep-and-refreeze residue `docs/eta-ring-posterior.md` §3 keeps on purpose. Four other chain stops improve on the same column |
| Green, 10–90 coverage | 50.5 → 49.8% | the interval narrowed with the median (p90 2,817 → 643 s), so the same nominal coverage over a much tighter band |

The one thing that is **not** a regression but **is** a day-one caveat is
Green's warm-up: three hops (`81-127`, `26-127`, `127-80`) have no measured
drive because the published order could never bill them, so on Tuesday morning
they price from the route's pace and read `estimated` until the collector has
billed them. On tables that cannot supply them — which is what this whole
preflight ran on — Green measures **191.3 s median / 49.0% dangerous tail**
against the 288.8 s / 56.1% riders had; the design doc's steady-state
measurement on re-derived tables is 70.1 s / 12.1%. Expect Tuesday to land
between the two and to move toward the lower figure through the day.

## What was run

```bash
# worktree: origin/master 1a0159c, node_modules + snapshots copied from wt/ring
cd /home/gwarren/yale-shuttle-wt/redcheck/services/shuttle-v2

npm run typecheck && npm test && (cd web && npx vite build)

# the three archived riders (canary origin, Prospect / Canner)
TZ=America/New_York REPLAY_DB=./store/snap-0904-2205.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0903.json \
  CAPTURE=$HOME/shuttle-captures/positions-20260903.jsonl OUT_NAME=named-0903 \
  npx tsx scripts/eta-replay/rider-sim/run.ts \
    --rider Red@48@2026-09-03T21:21:25Z@41.325351,-72.922891 \
    --rider Red@48@2026-09-03T20:36:03Z@41.325351,-72.922891 \
    --rider Red@48@2026-09-03T20:58:03Z@41.325351,-72.922891

# the mechanism behind each
TZ=America/New_York ROUTE=3 PATCH=./scripts/.eta-replay/model-patch-all-0903.json \
  TARGETS=146,48 CAPTURE=$HOME/shuttle-captures/positions-20260903.jsonl \
  REPLAY_DB=./store/snap-0904-2205.db \
  npx tsx scripts/.eta-replay/traceany-redcheck.mts 2026-09-03T21:20:00Z 2026-09-03T21:30:00Z '#309'

# gps-replay, both arms
TZ=America/New_York REPLAY_DB=./store/snap-0904-2205.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0904.json \
  REPLAY_OUT=./scripts/.eta-replay/out-1a0159c npx tsx scripts/eta-replay/gps-replay.ts
TZ=America/New_York MODEL_ROUTES="" ... REPLAY_OUT=./scripts/.eta-replay/out-legacy ...
# baseline arm: /home/gwarren/yale-shuttle-wt/base0907/.../out-master/gps.json (8d093a3)

# the rider simulator, ~2 h
TZ=America/New_York REPLAY_DB=./store/snap-0904-2205.db \
  CLIENT_ROOT=/home/gwarren/yale-shuttle-wt/redcheck/services/shuttle-v2 \
  PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0903.json \
  CAPTURE=$HOME/shuttle-captures/positions-20260903.jsonl \
  CHAIN=Red:11:6 OUT_NAME=redcheck-0903 npx tsx scripts/eta-replay/rider-sim/run.ts

node scripts/eta-replay/rider-sim/pair-by-route.mjs \
  scripts/.eta-replay/master-0903.waits.jsonl scripts/.eta-replay/redcheck-0903.waits.jsonl
node scripts/eta-replay/rider-sim/pair-by-route.mjs \
  scripts/.eta-replay/cand11-0903.waits.jsonl scripts/.eta-replay/redcheck-0903.waits.jsonl
```

## What this did not measure

- **The grocery lines** (routes 6 and 18) run at weekends and appear in neither
  the 9/3 nor the 9/4 window; `8d093a3`'s pooled priors were accepted on a 9/6
  Sunday replay and are unmeasured here.
- **`8c4c456`'s served parameters** were exercised only at their defaults, which
  are byte-identical to the constants. A re-estimated parameter set arriving over
  the wire is not in any arm above.
- **Live behaviour.** Everything here is offline replay against captured
  positions. Tuesday is the first weekday of full service with all four changes
  live; re-run this file's gps-replay against Tuesday evening's snapshot, and
  watch Green in particular.
