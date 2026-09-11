# The case for the app, in one screenshot: Blue West, 2026-09-09 22:51 ET

The operator was waiting for Blue West #127 at Mansfield / Division with both
apps open. This is what each said, and what the bus did.

| 22:51:32 ET | number shown |
|---|---|
| **This app** | `🚌 in <1–7, then 40 min` — and on the bus's own row, `Canal / Munson ⏸ 3:30 · <1–7 min left` |
| **The official Yale Downtowner app** | `#127 · 11:14 PM · 23 min` |
| **What happened** | #127 reached Mansfield / Division at **22:52:18** — **46 seconds later** |

Our range contained the truth at its low end. Theirs was wrong by 22 minutes, in
the direction that costs a rider the trip: a rider reading "23 min" at 10:51pm,
near the end of Blue West's service, walks away — and the bus they needed pulls
in three quarters of a minute later.

## It was not a lucky poll

We record their number for this stop every ~3 minutes in `upstream_etas`. Over
the 25 minutes before the arrival it never tracked the bus at all:

```
22:29:50  said 34 min | actually 22.5 | err +11.5
22:32:56  said 34 min | actually 19.4 | err +14.6
22:36:02  said 34 min | actually 16.3 | err +17.7
22:39:08  said 33 min | actually 13.2 | err +19.8
22:42:14  said 22 min | actually 10.1 | err +11.9
22:45:20  said 20 min | actually  7.0 | err +13.0
22:48:26  said 23 min | actually  3.9 | err +19.1
22:51:32  said 23 min | actually  0.8 | err +22.2
```

Truth fell 22.5 → 0.8 minutes. Their figure went 34, 34, 34, 33, 22, 20, **23,
23** — it rose again over the last two samples, while the bus was closing. It is
not a countdown; it is not converging on anything.

Reproduce: `stop_id 163`, `bus_name '#127'`, `arrivals.arrived_at` against
`upstream_etas.sampled_at`, 2026-09-09.

## Why we were right, mechanically

Three things in this repo were each load-bearing in that one number. Take any one
away and you get their answer, not ours.

1. **The bus was standing, and we knew where and for how long.** `⏸ 3:30` is the
   rest clock read off the ring posterior's belief rather than off `at_stop_since`
   — the distinction that survives a collector restart (#129) and a rest taken
   short of the marker. A model that prices a standing bus as "driving, with the
   whole hop still ahead" is exactly how you get 23 minutes.
2. **The stand was priced as a distribution conditional on elapsed time.**
   `<1–7 min left` is the 10th–90th percentile of `(S − r | S > r)` from
   Canal / Munson's own stand table. After 3:30 of a typically short hold most of
   the mass is already spent. A point estimate off a pooled mean cannot say that.
3. **We showed the range.** The operator asked for this the same day — "I just
   want a narrower range of when we expect it to arrive" — and the range is what
   made the card actionable. `<1–7` says *stay where you are*. `23 min` says go
   home.

## What it does not prove

One arrival is one arrival. The head-to-head that carries weight is
`scripts/eta-replay/compare-upstream.ts` — shared (bus, stop, minute) pairs that
matched the same arrival, cells under 50 rows withheld. This case is a worked
example of a margin that measurement already shows across the network, not the
evidence for it. Their `avg` is published in whole minutes, so ~±30 s of any gap
is rounding; a 22-minute gap is not.

Keep the screenshot beside this file. It is the one artefact showing both numbers
on one screen at one instant, which no query can reconstruct.
