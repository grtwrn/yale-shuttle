# The standing trough: what the card is priced from while a bus lays over

This harness answers one question about the ring estimator's display ceiling
(`Floors` / `priceRoute` in `web/src/eta/arrival.ts`): **while a bus stands at a
layover, which term produces the number the rider reads, and how much of the
error is the ceiling holding a trough rather than the estimate being low?**

It replays the REAL client (`computeUpcomingArrivals` from this worktree's
`web/src`) over a day of production rows for Red and traces every priced row
(`setPriceTrace`, inert in production): the rest identity and its clock, the
elapsed `r`, the lead cluster's mass split into the variants that price the rest
as CONTINUING and those that price it as OVER, each half's own quantile, the
mixture the display uses, the rest-less chain (`departNow`), the residual stand
and the lap factor behind it, the ceiling in force, the number shown, and the
detector's own next arrival.

## What it found (2026-09-04, 09-10, 09-11; 53 layover rests, 18,218 rows)

The trough is not the stand table, the lap correction, the clock or the drive:

| term | at the trough poll |
|---|---|
| served stand table at 344 Winchester | `q50` 355 s, `qn` 159 — right |
| the residual it bills, given `r` | 350-380 s — right, and it tracks `r` |
| the lap factor | 1.00-1.23, i.e. it RAISES these stands |
| the rest-less chain (`departNow`) | 73 s, flat — the drive is not the problem |
| the standing variants' own quantile | 259-466 s |
| **the lead cluster's MIXTURE (what the display uses)** | **109-217 s** |

Within the first minute of a stand the feed's ~30 m deadband produces a FRESH
fix (a bus shuffling at the kerb), a fresh fix is departure evidence
(`P_DEPART_ON_FRESH` = 0.71), and the lead cluster splits about half and half
between "standing, ~450 s left" and "pulled out, ~70 s of drive". The MEDIAN of
that bimodal mixture falls into the standing part's lower tail. One poll later
the mass is back at 0.96 standing and the mixture is 393 s again — but #119's
`min(prev, eta)` has kept the trough, and shows it for the rest of the stand
(the plateau holds 46-98% of a rest; 14 of 15 on 9/11 were set by a poll with a
live departure hypothesis). Of the deficit seconds on the layover rests, the
**ratchet holds 40.5% and the estimate at that poll is low by 59.5%** — the
second half is the pooled stand median, the known dominant defect.

`rules.mjs` scores candidate display rules OFFLINE from one replay — the
ceiling changes only the number a row shows, never the belief or the tables — and
the replay's `on` arm is then a CHECK on that arithmetic (0 of 18,218 rows
disagree).

## Running it

```bash
cd services/shuttle-v2/scripts/eta-replay/trough
D=../../.eta-replay/trough                      # where the inputs live (gitignored)
for d in 2026-09-04 2026-09-10 2026-09-11; do
  for a in off on; do DATA=$D FILE=arch-$d.tsv TROUGH=$a npx tsx decompose.ts; done
done
DATA=$D node rules.mjs 2026-09-04 2026-09-10 2026-09-11
```

`TROUGH=off` is master (`setCeilingHoldsUnderDeparture(false)`), `on` the
shipped rule. `decompose.ts` prints the per-rest table and the per-poll
decomposition of the longest rests and writes `dec-arch-<day>-<arm>.json`;
`rules.mjs` scores master against every candidate rule (accuracy, both 120 s
tails, rises per rest, departure latency) and pairs the replayed arm against its
own offline simulation.

## The inputs (NOT committed — ~4 MB a day)

They live under `services/shuttle-v2/scripts/.eta-replay/trough/` (gitignored)
and are extracted from a production DB snapshot or from `~/shuttle-archive/<day>`.
Each `arch-<day>.tsv` line is a type letter, a TAB, then one JSON row:

| type | table | fields the replay uses |
|---|---|---|
| `A` | `arrivals` (route 3, that ET day) | `bus_name`, `stop_id`, `arrived_at`, `departed_at` |
| `V` | `stop_visits` | `bus_name`, `stop_id`, `pinned_at`, `departed_at` |
| `R` | `raw_positions` (route 3) | `collected_at`, `bus_id`, `bus_name`, `lat`, `lon`, `heading`, `last_stop_id` |

`buses_now.json` is one captured `/api/buses` payload, for `routes`,
`route_paths`, `stop_coords`, `stop_names`, `segments`, `dwells` and
`model_params`.

The payload each poll is rebuilt as the 2026-09-11 investigation's `minireplay.ts`
did it: positions at 5 s, `at_stop_since` from `stop_visits.pinned_at`,
`stationary_since` from a repeated coordinate, lap ages from the arrivals'
departures at stops 11 and 121. Truth is the detector's own next arrival within
45 min, and a poll where the bus is already standing at the target stop is
excluded — the same rule as `truthAt` in `src/server/predictions.ts`.

Red days with a full service day of positions: **2026-09-04, 09-10, 09-11**
(09-08 and 09-09 hold only 1-3 h and are useful only as a smoke test).

Fidelity: the rebuilt payload's numbers run a median 2 s under the logged
`predictions_log` rows for the same day (the 2026-09-11 investigation's check).
