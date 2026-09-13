# The #119 standing ceiling: counting how it arms

This harness answers one question about the ring estimator's display ceiling
(`Floors` in `web/src/eta/arrival.ts`): **when a bus reaches a stop and the
ceiling is recorded, how much of the lead cluster's mass is actually priced as
standing, and what does the ceiling cost the rider when it is recorded from the
mixture instead?**

It replays the REAL client (`computeUpcomingArrivals` from this worktree's
`web/src`) over a day of production rows for Red, once per arm, and pairs the
two runs poll for poll. The arms are the switch in `arrival.ts`:

* `ARM=off` — master: the ceiling is recorded on the first poll the lead stands,
  from the standing+moving MIXTURE, and then ratchets (`min(prev, eta)`).
* `ARM=on` — the variant: the entry is PROVISIONAL while the lead's standing
  mass is below `LEAD_SWITCH_MASS`, and is armed once from the standing
  variant's own quantiles on the poll the mass clears.

## Running it

```bash
cd services/shuttle-v2/scripts/eta-replay/ceiling/count
D=../../../.eta-replay/ceiling/count            # where the inputs live (gitignored)
for d in 2026-09-04 2026-09-10 2026-09-11; do
  for a in off on; do DATA=$D FILE=arch-$d.tsv ARM=$a npx tsx count.ts; done
done
DATA=$D node summarise.mjs 2026-09-04 2026-09-10 2026-09-11   # paired off vs on
DATA=$D node episode.mjs 2026-09-11                           # per-rest sequences
```

`count.ts` prints the rest-by-rest table and writes `out-arch-<day>-<arm>.json`
(the per-poll rows and per-rest summaries) into `DATA`; `summarise.mjs` pairs
the two arms; `episode.mjs` prints the shown number against the truth through
the longest 344 Winchester rests, which is how an aggregate is checked against
a case a human can read. `probe.mts` prints what the synthetic fixture in
`web/src/eta/arrival.test.ts` does per poll, in both arms — it is what the unit
tests in that file were written against.

## The inputs (NOT committed — they are ~4 MB a day)

They live under `services/shuttle-v2/scripts/.eta-replay/` (gitignored) and are
extracted from a production DB snapshot. Each `arch-<day>.tsv` line is a type
letter, a TAB, then one JSON row:

| type | table | fields the replay uses |
|---|---|---|
| `A` | `arrivals` (route 3, that ET day) | `bus_name`, `stop_id`, `arrived_at`, `departed_at` |
| `V` | `stop_visits` | `bus_name`, `stop_id`, `pinned_at`, `departed_at` |
| `R` | `raw_positions` (route 3) | `collected_at`, `bus_id`, `bus_name`, `lat`, `lon`, `heading`, `last_stop_id` |

`buses_now.json` is one captured `/api/buses` payload, for `routes`,
`route_paths`, `stop_coords`, `stop_names`, `segments`, `dwells` and
`model_params`.

The payload each poll is rebuilt the way the 2026-09-11 investigation's
`minireplay.ts` did it (fidelity: median −2 s against the logged
`predictions_log` rows for that day): positions at 5 s, `at_stop_since` from
`stop_visits.pinned_at`, `stationary_since` from a repeated coordinate, lap ages
from the arrivals' departures at stops 11 and 121. Truth is the detector's own
next arrival within 45 min, and a poll where the bus is already standing at the
target stop is excluded — the same rule as `truthAt` in `src/server/predictions.ts`.

Red days with a full service day of positions: **2026-09-04, 09-10, 09-11**
(09-08 and 09-09 hold only 1–3 h and are useful only as a smoke test).
