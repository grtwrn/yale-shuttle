# When a bus stops reporting

Red, 2026-09-04 13:47 ET. A rider at Division/Prospect was watching #304, due
in about eight minutes and closing on 344 Winchester. At **13:47:51 it made its
last report** and stopped appearing in the feed. Two minutes later the
collector's 120 s liveness TTL deleted it, `/api/buses` lost it, and the card
moved to **#310, a full loop away at 42 min**, with no word of explanation.

> "just jumped from 8 to 42 minutes. do we catch if a bus is going offline?
> can we?" — operator

This is the record of what the data says about such a bus, including **two
readings that were wrong**, because each was convincing and the design depends
on not making them again.

## Reading 1 (WRONG): "it is still standing there"

Six hours of `raw_positions`, all routes, gaps ≥ 2 min in a bus's reports:

| | |
|---|---|
| gaps | 9 |
| came back | **9 of 9** |
| duration | median 4.4 min, p90 11.6 min |
| reappeared | 7–225 m from where it vanished (except one at 80 min / 2.2 km) |
| new `bus_id` | 9 of 9 |
| at a stop when it vanished | 9 of 9 (none > 100 m from one) |

Read on its own this says a dropout is a hiccup: the bus is standing at a stop,
it will be back in four minutes, keep counting down.

**It is survivorship.** A six-hour window can only contain gaps that *ended*
inside it. Every gap that was still open — every bus that went quiet and stayed
quiet — is invisible to that query by construction.

## Reading 2 (also wrong, in the other direction): "#304 never came back"

At 13:58, eleven minutes after it vanished, there was no #304 under any id on
any route. Recorded as a bus that never returned.

**It came back at 14:06** — eighteen minutes after going quiet — under
`bus_id` 65982, resting in the **Science Park Garage lot**, about 500 m from
where it vanished and *off Red's route altogether*, then drove to
Division/Prospect by 14:15.

Two things follow, and both are in the shipped code:

- A returning bus comes back **near, but not at**, where it went. A
  reconciliation radius in tens of metres would have called #304 a different
  vehicle. (Nothing has to measure one: the collector reconciles by track key,
  which is the bus **name**.)
- ⚠️ **A freshly reissued id carries a garbage `last_stop_id`.** #304 came back
  claiming Union Station (N), Red index 0 — **seventeen hops** from where it
  actually was. The anchor must come from GPS alone until the feed catches up.
  *Not fixed here* — it belongs to `anchor.ts` / `anchorGate.ts` — but it is
  now reachable more often, because a bus that returns is a bus a rider may
  still have on screen.

## The measurement that decided the design

`arrivals` retains 90 days, so it can see the gaps that never end. Every window
of `(bus_name, bus_id, route_id)` contributes a **vanish event** at its end,
including the last window per name (the never-returned case); events in the
final 2 h are dropped as right-censored. n = 3,136.

**Conditioned on the route still running 20 min later** — i.e. a genuine
dropout rather than the end of a service block — n = 1,994:

| back within | share | of those, within 600 m |
|---|---|---|
| 2 min | 2.1% | 93% |
| 5 min | 13.4% | 97% |
| **10 min** | **32.8%** | **96%** |
| 15 min | 41.2% | 94% |
| 20 min | 44.5% | 92% |
| 30 min | 46.6% | 90% |
| 60 min | 49.7% | 88% |
| **never within an hour** | **50.3%** | |

**A bus that goes quiet is a coin flip.** Not a hiccup. Where the route went
quiet too (end of service, n = 1,142) it is worse still: 14.2% back within
10 min, 80.2% never within the hour.

### Why the row is not priced as a bus that is still coming

Because half of them are not. Pricing a ghost as "standing at its stop, leaving
shortly" replaces a silent lie (the row vanishes) with a confident one (a
countdown for a bus in a garage). #304 spent eighteen minutes off route; a
countdown would have been wrong for every second of them.

### Why the bound is ten minutes

The knee of the return curve. Returns arrive at ~3.8 percentage points per
minute out to ten minutes, then **1.7** (10–15), **0.65** (15–20), **0.22**
(20–30), **0.10** (30–60). Past ten minutes a longer memory buys a stale row
rather than a reunion — and the contamination rises: of gaps ending within
10 min, 4% end more than 600 m away; by 30 min it is 10%.

The row also expires earlier when the promise it remembers runs out
(`ghostGraceMs` = min(10 min, wasDue + `STOP_DWELL_SEC`)), so a bus that was
due in three minutes is held for four, not ten.

## Where a bus goes quiet predicts whether it returns — and is not used

Vanish events by the stop last reached, route still running (back within 10 min
against a 33% baseline):

| stop | n | back ≤ 10 min | ≤ 20 min |
|---|---|---|---|
| Orange / Edwards (N) | 180 | **78%** | 92% |
| Prospect / Highland (N) | 119 | 71% | 87% |
| LEPH / 60 College | 196 | 70% | 88% |
| Orange / Bishop (N) | 30 | 60% | 77% |
| 344 Winchester | 137 | 58% | 85% |
| 333 Cedar | 177 | 49% | 69% |
| York / Cedar | 42 | 29% | 40% |
| Peabody Museum | 53 | 17% | 21% |
| 300 George St | 106 | 7% | 7% |
| Canner / Whitney (N) | 133 | **4%** | 5% |
| Union Station (N) | 43 | 2% | 2% |
| Prospect / Sachem (N) | 61 | **0%** | 0% |
| Willow / Whitney | 56 | 0% | 2% |
| West Haven Train Station | 46 | 0% | 9% |

A spread of 0% to 78% — relief points where drivers go off air briefly, against
end-of-line stops where a bus goes out of service.

**Deliberately not built.** The row makes no claim about the bus returning, so
the return rate does not change a word of what is shown; it would only tune how
long a true sentence stays on screen, which is not worth a new calibrated
table. Recorded here so the next reader does not have to re-measure to find
that out.

## What is shown instead

The row keeps its place and says two true things and no false one, both in the
past tense so both stay true whatever the bus is doing:

```
Red   was due in 8 min                                    23 min
      🚶 3 min › 🚌 11 min                                 1:58p   ›
      📡 #304 — signal lost 2 min ago · next bus in 42 min
```

- **Nothing ticks.** The number is the last estimate made while the bus was
  still reporting, frozen — a memory of a promise, not an estimate. It is not
  passed through `remainingSec`.
- **The next confirmed bus is beside it.** This is the half that makes the row
  safe: the rider sees both "#304 has gone quiet" and "#310 in 42 min" and
  decides whether to wait or walk. Today they get only the 42.
- **The wait and the total are priced on the confirmed bus**, never the ghost —
  `pickLiveArrival`'s `boardable` excludes ghosts entirely.
- The map marker greys, and the push notification (`leaveAlert`) refuses to arm
  on a ghost: a card can say "signal lost"; a notification that says "time to
  leave" cannot.

## Reproducing the measurement

```bash
# probe4.js in the PR's scratch; the shape is:
#   window per (bus_name, bus_id, route_id) from `arrivals`
#   -> vanish event at each window end, right-censored at 2 h
#   -> next window of the same NAME = the return, or never
printf '<js>' | ~/.fly/bin/flyctl ssh console -a yale-shuttle -C "node -"
```

`raw_positions` (6 h) is the wrong instrument for this question and produced
Reading 1. Use `arrivals` (90 d), and count the events that never end.
