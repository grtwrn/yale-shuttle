# The layover deficit, per route and per fitted CELL

This harness answers one question about the stand estimate: **while a bus lays
over, how wrong is the number a rider reads, and how much of that error is the
#119 ratchet holding a trough rather than the ESTIMATE being low?** — and it
answers it per (route, stop) cell, with the lap covariate served and withheld,
on the same days.

It is the generalisation of `../trough/` (2026-09-11), which measured the same
split on Red only, before the lap covariate was served on Blue Night. The
40.5% ratchet / 59.5% estimate figure quoted in CLAUDE.md and in the memory
notes comes from that harness; the arithmetic here is the same, so the numbers
are comparable.

## What it reports

For the rows a rider at the stop THREE hops past the resting cell would have
read (the way Red's 344 Winchester layover was read from Division / Prospect —
the shape every cell is measured through):

| | |
|---|---|
| `signed` | median of `shown − actual`. Negative = the rider waits longer than told |
| `\|err\|` | median absolute error |
| `wait` | share of rows where the rider waits **≥ 120 s longer** than told |
| `early` | share where the bus **beat the promise** by ≥ 120 s (the dangerous tail) |
| `ratch` / `est` | the deficit split. Of the seconds the bus came LATER than shown, how many the ratchet holds (`mixture − shown`) and how many the estimate is low by (`actual − mixture`) |
| `mDef` / `mRat` / `mEst` | the same three, as per-row medians |
| `lapF` / `resid` | the lap factor in force and the residual stand it bills |

Three rest definitions are printed, because they are **not the same line**:

- **all standing rows** — every priced row where the lead is at rest;
- **arrivals span ≥ 300 s** — `arrived_at → departed_at`, which is ANCHOR
  RESIDENCE time, not standing time (CLAUDE.md's invariant);
- **visit span ≥ 300 s** — `stop_visits.pinned_at → departed_at`, the span the
  served stand table `q` is actually measured from.

On Red the two spans agree (344 Winchester is a real layover on the marker). On
Blue Night they do not: Peabody Museum (13:97) shows an 8-minute arrivals span
at a stop whose served `q50` is **0 s** with `pstop` 0.54 — half its visits are
roll-throughs. Read the visit row there.

## Running it

```bash
cd services/shuttle-v2/scripts/eta-replay/postlap
D=../../.eta-replay/postlap                 # inputs + outputs (gitignored)

# 1. the inputs: one route-day each, straight from ~/shuttle-archive
ROUTE=13 DAY=2026-09-10 OUT=$D node build-arch.mjs
curl -s https://yale-shuttle.fly.dev/api/buses -o $D/buses_now.json

# 2. the arms — a PAYLOAD patch, never a code change
DATA=$D FILE=arch-r13-2026-09-10.tsv ROUTE=13 TAG=on        npx tsx layover.ts
DATA=$D FILE=arch-r13-2026-09-10.tsv ROUTE=13 STRIP=13 TAG=off13 npx tsx layover.ts

# 3. pair them row by row (baseline first)
DATA=$D node summarise.mjs arch-r13-2026-09-10.tsv \
  lay-arch-r13-2026-09-10-off13.json lay-arch-r13-2026-09-10-on.json

# 4. is the rebuilt payload the one production served?
DATA=$D node fidelity.mjs lay-arch-r13-2026-09-10-off13.json pred-2026-09-10.json 13
```

`STRIP=13` serves the tables with route 13's `lapB`/`lapM`/`lapN` deleted — i.e.
production as it was **before 2026-09-12 00:5x ET** — and `STRIP=3,13` removes
the covariate altogether. The per-bus lap ages are left in place in every arm:
with no fit, `priceRoute` never asks for them, so stripping the fit is the whole
arm. Both arms replay the same polls against the same truth, so a difference is
the covariate and not the day.

## It needs the price trace, which is NOT in the tree

`layover.ts` imports `setPriceTrace` from `web/src/eta/arrival.ts`. That hook is
inert instrumentation (null in production, nothing computed) and it is
deliberately **not committed**: this is a measurement branch and the estimator is
not being changed. `price-trace.patch` beside this file applies it to master:

```bash
git apply services/shuttle-v2/scripts/eta-replay/postlap/price-trace.patch
npx vitest run web/src/eta/     # 116 tests, unchanged — the clamp arithmetic is identical
```

The patch rewrites the #119 clamp as one branch instead of two so the raw
mixture can be reported beside the number shown. With no held ceiling `shown`
IS `eta` and the delta is 0, which is exactly master's else branch — the tests
above are what says so.

## The inputs (NOT committed — ~1–4 MB a route-day)

`arch-r<route>-<day>.tsv`, one JSON row a line behind a type letter:

| type | table | fields |
|---|---|---|
| `A` | `arrivals` | `bus_name`, `stop_id`, `arrived_at`, `departed_at` |
| `V` | `stop_visits` | `bus_name`, `stop_id`, `pinned_at`, `departed_at` |
| `R` | `raw_positions` | `collected_at`, `bus_id`, `bus_name`, `lat`, `lon`, `heading`, `last_stop_id` |

`buses_now.json` is one captured `/api/buses` payload (routes, paths, stop
coords, segments, dwells, model_params). The payload each poll is rebuilt as the
trough harness did it: positions at 5 s, `at_stop_since` from
`stop_visits.pinned_at`, `stationary_since` from a repeated coordinate, and
`buses[].lap` ages from the arrivals' own departures at the FITTED stops.

**Which days exist, and why.** `raw_positions` is swept at 6 h, so an archived
day holds a full service day only where the Pi's capture supplemented it:

| day | route 3 (Red) | route 13 (Blue Night) |
|---|---|---|
| 2026-09-10 | 23,356 rows, 06:57–18:19 ET, 3 buses | 8,327 rows, 17:58–23:59 ET, 2 buses |
| 2026-09-11 | none archived (a production snapshot covers 06:59–13:31) | 2,168 rows, 20:59–23:59 ET, 1 bus |

Truth is the detector's own next arrival within 45 min, and a poll where the bus
is already standing at the target stop is excluded — `truthAt` in
`src/server/predictions.ts`.
