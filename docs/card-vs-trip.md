# The app has two ETA estimators, and the route cards are running the old one

**Status: MERGED 2026-09-04. `StopList` now calls `computeUpcomingArrivals`;
what follows is the measurement that decided it, and "What the merge did" at
the foot is the paired before/after.** Instrument:
`services/shuttle-v2/scripts/eta-replay/card-vs-trip.ts` (disagreement,
truth-scoring, sequence stability) and `card-cost.ts` (the performance
hypothesis). Corpus `~/shuttle-captures/positions-20260903.jsonl`, 7,233 polls,
13:51–24:00 UTC; snapshot `store/snap3-split.db`;
`PAYLOAD_PATCH=scripts/.eta-replay/split-patch-0903.json` so the trip arm is
the post-#85 client and not silently the one from the day before. Baseline
tree `origin/master` d4cf07e (PRs #67, #72, #81, #85, #86, #90, #93, #97, #102
included).

---

## The finding

The trip card runs `computeUpcomingArrivals` (`web/src/arrivals.ts`). The
**route cards on the Map tab do not.** `StopList` in `TransitMap.tsx` carries
its own arithmetic inline (~180 lines, lines 5269–5464), and it has none of the
machinery that lands in `arrivals.ts`:

| | `computeUpcomingArrivals` | `StopList` |
|---|---|---|
| anchor | `resolveAnchorIndex` — projection onto the published line, the corroboration gate (#72/#90/#93/#97), direction of travel (#86), `at_stop_id` refinement | `nearestRouteStop`: nearest stop by **squared lat/lon degree delta**. Not metres, not projected, ungated, no direction, no `at_stop` |
| stop list | `mergedRouteStops` — primary route **verbatim, repeats and all** | de-duplicated across every route id, primary included (Green 23 → 20, Purple 15 → 11) |
| first hop | stand/drive split (#81/#85), else stall credit bounded by the dwell and the drive floor, then chord proration | the whole arrival-to-arrival segment, always |
| laps | two (so "and the one after that?" and the bus's own stop can answer) | one |
| sanity cap | 90 min | none |
| display | `floor(eta / 60) min` | `round(low / 60) min` — the **low end of the interval** |

`liveAnchor.ts`'s own header says the shared store exists "precisely so *the
map, the route cards and the trip card* cannot disagree about where a bus is."
PR #102 routed five render sites through it. `StopList`'s ETA arithmetic was
not one of them, and it is the site that draws the route cards.

---

## 1. How far apart they are

948,072 paired rows — one line's card row for one stop at one poll, where the
card shows an ETA and the trip estimator also has one.

**It is not a uniform offset. It is a small median with a very fat tail.**

| bucket | rows | \|Δ\| p50 | \|Δ\| p90 | \|Δ\| p99 | Δ > 180 s | Δ > 300 s |
|---|---|---|---|---|---|---|
| all | 948,072 | **52 s** | **985 s** | **2,315 s** | **31.9%** | **25.1%** |
| trip ETA ≤ 5 min | 197,328 | 34 | 774 | 1,613 | 23.7% | 19.8% |
| a bus standing at a layover | 302,337 | 110 | 750 | 1,830 | 42.7% | 30.2% |
| the departure poll | 73,601 | 36 | 902 | 2,237 | 25.3% | 20.4% |
| the 344 Winchester chain, bus standing | 18,785 | **175** | 397 | 1,244 | **49.4%** | 20.6% |
| Green | 118,849 | **649** | 2,203 | 3,598 | **72.1%** | 66.9% |
| Purple | 62,126 | **366** | 1,283 | 2,384 | 58.2% | 52.1% |
| Red | 157,981 | 49 | 590 | 1,633 | 33.3% | 22.7% |
| Blue Day | 162,652 | 23 | 361 | 1,114 | 15.9% | 12.3% |

**On screen, in whole minutes**, the two surfaces print the same number on
**14.4%** of rows. 66.7% are two or more minutes apart and **36.8% are five or
more minutes apart**. Restricted to the rows a rider acts on (trip ETA ≤ 5 min)
it is better but not fixed: 38.4% identical, 70.6% within a minute, **15.6%
still five or more minutes apart**.

They also disagree about **which vehicle** on 10.9% of rows overall — Purple
36.3%, Green 24.1%.

## 2. Which is right

Truth is the bus's own track entering 45 m of the stop (the canary's rule, from
the same positions). 878,334 rows scored; error = predicted − actual, seconds.

| bucket | card \|err\| p50 | card bias | trip \|err\| p50 | trip bias | paired: card better | trip better |
|---|---|---|---|---|---|---|
| all | 174 s | +31 | **126 s** | +13 | 37.2% | **53.1%** |
| trip ETA ≤ 5 min | 67 | +21 | **48** | −14 | 33.5% | 52.5% |
| standing at a layover | 210 | +76 | **120** | −1 | 33.0% | **58.6%** |
| departure poll | 133 | +28 | **95** | +15 | 34.9% | 55.5% |
| chain, bus standing | 212 | **+185** | **113** | **+14** | 27.3% | **66.9%** |
| split served (Red, Blue Day) | 122 | +30 | **78** | −4 | 31.9% | 56.3% |
| split absent | 205 | +32 | **170** | +32 | 40.1% | 51.3% |

**The trip estimator wins, and it wins hardest exactly where today's work
landed.** At the 344 Winchester chain with a bus standing at the garage, the
card's median promise is **+185 s late** — it bills the whole 557 s
arrival-to-arrival hop with no credit for the minutes already stood — against
the trip card's +14 s. Trip is better on 66.9% of those rows.

**Two apparent counter-examples, and both dissolve.** In the whole-day
aggregate the card beats the trip estimator on Green (362 vs 471 s) and ties on
Purple. That is the branch lock (`docs/eta-estimator-design.md`): the trip arm
occasionally puts a fold-back bus a lap away, and a lap on Green is 80 minutes.
But restricted to the rows riders act on:

| line, trip ETA ≤ 5 min | card \|err\| p50 | trip \|err\| p50 | card better | trip better |
|---|---|---|---|---|
| Green | 100 s | **70 s** | 36.0% | **50.2%** |
| Purple | 279 s | **110 s** | 35.7% | **55.7%** |

**On the near-term rows the trip estimator is better or tied on every one of
the twelve lines that ran that day.** The card's Green advantage lives entirely
in far-horizon rows nobody is standing at a kerb reading.

## 3. Where each arm thinks the bus is

This is the mechanism. `nearestRouteStop` against the gated anchor, per
bus-poll:

| line | bus-polls | same stop | hops apart when not (p50 / p90 / max) |
|---|---|---|---|
| Green | 13,698 | **41.6%** | 5 / 6 / 10 |
| Blue West | 1,460 | 43.6% | 1 / 1 / 4 |
| Orange East | 1,475 | 54.4% | 1 / 4 / 4 |
| Purple | 19,468 | 55.0% | 1 / 2 / 5 |
| Blue Night | 2,203 | 60.9% | 1 / 4 / 6 |
| Red | 17,647 | 70.9% | 1 / **12** / 14 |
| Blue Day | 17,021 | 74.6% | 1 / **10** / 12 |
| Brown | 6,217 | 75.6% | 1 / 1 / 4 |

The two surfaces put the same bus on different stops between a quarter and
three-fifths of the time, and the p90 disagreement on Red and Blue Day is ten
to twelve stops. The card's badge and pause chip are drawn from this anchor;
the trip card's countdown from the other one.

## 4. The sequence — the thing the whole ETA lane is about

Consecutive readings at one stop, same vehicle, 5 s apart (834,797 pairs):

| bucket | card frozen | trip frozen | card drops ≥ 2 min in one poll | trip drops ≥ 2 min |
|---|---|---|---|---|
| all | **95.6%** | 29.2% | **1.3%** | 0.6% |
| trip ETA ≤ 5 min | 95.1% | 27.6% | 0.9% | 0.6% |
| departure poll | 84.9% | 11.7% | **2.3%** | 1.0% |

**The route card's countdown does not count down.** Its ETA is a sum of
segment averages from an anchor stop; nothing in it is a function of `now`, so
it changes only when the naive anchor jumps to the next stop — and then it
falls by a whole hop at once. It is frozen on 95.6% of poll pairs and still
collapses by two or more display minutes **twice as often** as the trip card.

A rider at Division / Prospect watching Red #316 through the 344 Winchester
layover on 2026-09-03 (card `round(low/60)` | trip `floor(eta/60)`):

```
18:41:19   card  6 min | trip  9 min      raw 542s vs 564s
18:41:39   card  6 min | trip  6 min      raw 542s vs 378s   [bus standing]
18:42:34   card  6 min | trip  5 min      raw 542s vs 329s
18:43:19   card  6 min | trip  4 min      raw 542s vs 290s
18:44:44   card  6 min | trip  5 min      raw 542s vs 329s
18:45:39   card  6 min | trip  4 min      raw 542s vs 292s
18:45:44   card  1 min | trip  4 min      raw  57s vs 289s   <- one poll
18:46:34   card  0 min | trip  0 min
```

The card holds "6 min" for **four minutes and twenty-five seconds** and then
drops to "1 min" in a single 5-second poll. That is the operator's own
complaint — "saying a bus is 10 min away and then a few seconds later dropping
to 1 second" — reproduced on the surface nothing shipped today touches.

## 5. Is the card's simplicity load-bearing?

**No.** `card-cost.ts`, on the busiest poll of the day (19 live buses, 15
lines, 274 stop slots), on the Pi:

| | ms per render |
|---|---|
| card (StopList arithmetic, all 15 lines) | 0.262 |
| **trip — ONE `computeUpcomingArrivals` over every stop** | **0.928** |
| trip — one call per line (15 calls) | 6.246 |
| trip, stateless (no anchor store) | 0.695 |

A merged `StopList` costs **0.67 ms more per render** against a 16.7 ms frame,
and `StopList` re-renders on the 1 s `tick`. The one thing the shape must get
right is **one shared call, not one per line** — fifteen calls is 6.2 ms and
would also mean fifteen redundant `ROUTE_LISTS` sweeps, since
`computeUpcomingArrivals` already loops every line internally.

## 6. Can the trip estimator answer the card's question?

Yes, with no trip context. `computeUpcomingArrivals(stopIds, buses,
routeStops, stopCoords, segmentTimes, now, dwellTimes, store)` takes exactly
the props `StopList` already receives — no origin, no walk, no destination.
Measured: **0 of 948,072 card rows had no trip answer.**

Two visible differences a merge would produce, neither of them a surprise:

- **7,566 rows across 567 line-renders** (0.8%) where the card shows a
  countdown off a bus `isBusOnRoute` rejects — Pink 4,499, Blue Night 1,767,
  Green 1,300. Blue Night's buses drive a documented 2.1 km relief run 996 m
  off route past no stops; the trip estimator is right to decline and the card
  is promising arrivals from a deadheading bus.
- The card's stop list must become `mergedRouteStops` for the anchor index to
  mean the same thing as the store's — or go through `anchorIndexOnList`,
  which exists for exactly this and translates back by stop id.

## 7. Three dead arrival boards

`NextShuttles` (67 lines), `FavoriteStopsPage` (240) and `StopGroupsSummary`
(64) are each referenced only by their own declaration — 371 lines, never
rendered. All three call `computeUpcomingArrivals`; **none shares a helper with
`StopList`**, whose estimator is unique in the file. Deleting them is cheaper
than merging them and removes three more surfaces that could drift.

## Reproduce

```bash
cd services/shuttle-v2
TZ=America/New_York REPLAY_DB=./store/snap3-split.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/split-patch-0903.json \
  CAPTURE=$HOME/shuttle-captures/positions-20260903.jsonl \
  npx tsx scripts/eta-replay/card-vs-trip.ts        # ~2 min on the Pi
#   TRACE_STOP=48 ROUTES=Red FROM=... TO=...        # the sequence above
TZ=America/New_York REPLAY_DB=./store/snap3-split.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/split-patch-0903.json \
  npx tsx scripts/eta-replay/card-cost.ts
```

`card-vs-trip.ts` transcribes the `StopList` arithmetic verbatim and
**self-checks the transcription** against `TransitMap.tsx` on every run: it
asserts the load-bearing lines are still there and that `StopList` still
contains none of `resolveAnchorIndex` / `anchorIndexOnList` / `stallCredit` /
`firstSegProgressFactor` / `priceFirstHop`. When the merge lands, that check
fires and the script is telling the truth: the divergence it measures is gone.

---

# What the merge did

`StopList` now runs one shared `computeUpcomingArrivals` over every stop of
every line, anchors through `anchorIndexOnList` on `liveAnchorStore`, and
prints `fmtMin(eta)` — the trip card's own transform — instead of
`round(low / 60)`. The instrument scored it by pinning its transcription to an
archived copy of the pre-merge file (`BEFORE_SRC`), so `card` is master's route
cards and `trip` is the merged ones, paired on the same 948,072 rows.

## The sequence — what this was actually for

Consecutive readings at one stop, same vehicle, **split by whether the feed
sent a NEW coordinate for that bus**. A number that does not move while the bus
does not move is honest; a frozen countdown for a bus that is demonstrably
driving is the defect. (53.6% of consecutive samples repeat a position rather
than interpolating — `docs/bus-speed.md` — so the split matters.)

| | pairs | frozen **while moving**, before | after | after, re-measured on #119..#122 |
|---|---|---|---|---|
| all | 339,581 | **89.3%** | **10.4%** | **16.7%** |
| trip ETA <= 5 min | 71,582 | 88.5% | 10.5% | 20.5% |
| a bus standing at a layover | 71,888 | 90.0% | 8.7% | 22.3% |
| **the departure poll** | 43,286 | **77.8%** | **4.0%** | **20.9%** |
| the 344 Winchester chain | 10,590 | 88.8% | **2.2%** | 18.5% |
| chain, at the departure poll | 1,956 | 82.5% | 2.4% | 33.2% |
| Purple | 21,613 | 94.9% | 29.8% | 29.8% |
| Green | 56,610 | 92.4% | 11.7% | 11.7% |
| Blue Day | 53,608 | 86.8% | 3.3% | 28.1% |

**The last column is not a regression, and reading it as one would be the
mistake this table exists to prevent.** It was taken when #112 was re-landed
(the original squash never reached master — see the re-land PR), against a
master that by then carried #119's non-increasing standing ceiling. That
ceiling deliberately HOLDS the shown number flat where the raw conditional
median would climb while a bus sits, precisely so the app stops sliding an
arrival later on no news at all. A held number is counted as "frozen" by this
metric, so the two changes push the same statistic in opposite directions for
opposite reasons. The columns that matter for the defect #112 was about — the
collapse that FOLLOWS a freeze — are unchanged, and they are below.

And the collapse that follows a freeze:

| | before | after |
|---|---|---|
| drops >= 2 display minutes in one poll (all) | 1.3% | **0.6%** |
| ... at the departure poll | 2.3% | **1.0%** |
| ... chain, at the departure poll | 2.1% | **0.2%** |
| jump >= 180 s (all) | 1.2% | **0.5%** |

Purple's 29.8% is the branch lock, not this change: where the anchor genuinely
cannot be resolved the gate holds it, and a held anchor is a held number. It is
`docs/eta-estimator-design.md`'s open work, and it is still three times better
than what the card did before.

## Accuracy, which follows

Against observed arrivals, |err| p50 **174 s -> 126 s**; at a layover
**210 -> 120** with the bias going **+76 s -> -1 s**; on the 344 Winchester
chain with a bus standing, **212 -> 113** and **+185 s -> +14 s**. The old
arithmetic is better on 37.2% of rows and worse on 53.1%. Full table above.

## The trip card is untouched

rider-sim, 8,344 waits, master vs this tree, same capture and snapshot:
**every flag identical, worst-drift delta p50/p90 = 0 s, 0 improved, 0
worsened, 7,711 same.** The only change to `arrivals.ts` is an additive
`estimated` field; nothing that produces a number moved.

## What a rider sees change

- **The countdown counts down.** It was a sum of segment averages from a stop
  index and no function of `now`.
- **A number instead of "0 min".** `fmtMin` says "now" and "<1 min"; the old
  `Math.round(low / 60)` reached 0 for a bus at the kerb (PR #98 settled that
  on the other surface).
- **The bus badge moves back one stop.** The anchor is "the segment the bus is
  on", not "the nearest stop", so a bus 200 m before a stop no longer badges
  AT it — which also means that stop now shows its (small) ETA instead of
  suppressing it.
- **7,566 rows a day stop appearing** (0.8%) — promises off a bus
  `isBusOnRoute` rejects, Pink 4,499, Blue Night 1,767, Green 1,300. Blue
  Night's is the documented 2.1 km relief leg past no stops. The empty state
  says so rather than going quiet: a card whose line has vehicles but none on
  route reads `23 stops · 2 buses off route ›`, where otherwise it would have
  read `23 stops ›` under a header saying "2/3 buses".
- **`~` survives.** `UpcomingArrival.estimated` is true when no hop in the
  chain had a calibrated segment, which is what the card's own flag meant. The
  candour was worth a field.

## The prediction log had to change with it

`predictions_log` deliberately covered only the trip card, because pooling two
ESTIMATORS in one column is the inference error it exists to stop. The merge
removes that error and creates a quieter one: the route cards report a far
larger, mostly far-horizon population (every line, every stop) than the trip
card (the one stop a rider chose). Pooled silently, the median would move
because the MIX changed and it would read as the estimator changing.

So a reading now carries **which screen showed it** — `trip` / `ride` /
`card` — as the eighth positional element on the wire and as part of the dedup
key, one row per (vehicle, stop, bucket, surface). It is optional on the wire:
a bundle from before today posts seven elements and every reading it ever sent
was a trip-card one, which is what the default says. An unrecognised value is
DROPPED rather than defaulted, because a client asserting an unknown population
would otherwise land in the one every published accuracy number is about.

The privacy shape is unchanged and the column-set test was updated to say so
explicitly: the surface is a property of the APP, deduplicated across every
browser exactly as the rest of the row is, so a row still means "at least one
client somewhere had this on that screen" and there is still nothing two rows
can be joined on to make one browser's trail.

## The instrument retires itself

`card-vs-trip.ts` self-checks its transcription against `TransitMap.tsx` and
refuses to run once `StopList` contains `anchorIndexOnList` / `stallCredit` /
`priceFirstHop`. It fired on the first run after the merge, which is the
acceptance signal. `BEFORE_SRC` is how it still scores: it verifies the
transcription against a checkout of the file it was taken from, so it cannot
quietly grade a copy that has drifted.

## Caveats

- **Absolute levels are optimistic.** The `PAYLOAD_PATCH` tables are built from
  the same day being replayed, so the split-served rows know more than the live
  client did. Paired deltas — which is every "card better / trip better" column
  — are unaffected.
- The card's own displayed number is the **low** end of its interval, so it
  carries a −110 s bias against its own `eta`. At the chain that accidentally
  cancels most of the missing stall credit (shown bias +2 s against eta's
  +185 s). It is a coincidence of two errors with opposite signs, not a design,
  and it does not survive to the other buckets (bias −336 s on Green).
- One day, one capture. Green and Purple's numbers are entangled with the
  branch lock, which is open work in `docs/eta-estimator-design.md`.
