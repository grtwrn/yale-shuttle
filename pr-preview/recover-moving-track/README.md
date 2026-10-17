# Recover a bus's route position while it approaches a stop

After the Blue Weekend continuity correction in PR #410, a process restart
could still choose Elm/York (53) on the outbound approach to Broadway/York
(21). The database retained the correct open anchor and fresh GPS history,
but recovery required the bus to be within 75 m of the stop and already at
rest. That discarded the very route history needed to distinguish nearby
poles on different parts of the loop.

Recovery now accepts an approaching open visit when replay matches its exact
saved arrival timestamp, stop, route, and identity. The current observation
then runs through the ordinary reducers. The curb/standing/boarding radii,
freshness bound, history cap, and closed/mismatched-episode refusals remain
the same. Historical replay events are discarded rather than inserted again.

An active inbound leg also needs its origin pass to start inside the retained
unbroken history. Otherwise a clipped departure or earlier holds would be
invented from the first available fix. The new recorded Purple control
demonstrates this: its 30-minute window clips the Union Station departure by
45 seconds. Recovery refuses that incomplete leg.

## Recorded checks

The real collector/database replays the shared 360-fix Blue Weekend capture
with restarts at 12:55:23.365, 12:55:48.321, and 13:04:23.394 UTC on October 3.
The first two are the reproduced failure points; the third is the genuine
later Elm/York return. Every live position/clock and every row of arrivals,
segments, stop visits, and legs equals the uninterrupted run, including the
later return's original 29.878-second stand. The first two cases fail on base
`b95ca75e2e72b68e0dbdd19e0825e1eba1c09be6`. The clipped-history control fails
when the new completeness guard is removed.

The broader sweep runs the actual collector into an in-memory SQLite DB.
At one-minute checkpoints it creates cold collectors using that same DB,
invokes their real SQL-backed recovery, and compares every restored reducer
field with the uninterrupted collector before the next poll. Both arms use
the same retained published network data. It covers 344,079 raw observations
and 14 observed routes, including Green and Purple's repeated-stop calls.

| Date (ET) | Raw observations | Checkpoint polls | Accepted restores | Newly accepted | State mismatches |
| --- | ---: | ---: | ---: | ---: | ---: |
| October 3 | 78,928 | 1,090 | 4,948 | 2,856 | 0 |
| October 4 | 83,319 | 1,087 | 5,226 | 2,904 | 0 |
| October 15 | 181,832 | 1,083 | 11,904 | 6,409 | 0 |

All 22,078 accepted restores match uninterrupted state exactly, including
12,169 that the earlier curb-only recovery discarded. The study reports zero
collector errors. The completeness guard refuses 127 initially considered
restores; the broader unguarded candidate had 33 state mismatches, all in the
inbound leg. Input/source hashes and per-route counts are in
[checks.json](checks.json).

These are public-feed consistency checks, not independent physical boarding
truth, historical warm ETA parity, or an accuracy/promotion claim. A truly
new bus without matching recoverable history still uses normal cold-start
behavior. This change does not backfill historical records. Deployment
invalidates the frozen learning cycle, which must restart on matching code.

## Reproduction

Run with Node 22 and the installed service dependencies from the repository
root, keeping a checkout of the base source available:

```sh
npx --prefix services/shuttle-v2 tsx pr-preview/recover-moving-track/replay.mts \
  --source services/shuttle-v2 \
  --base /path/to/b95ca75/services/shuttle-v2 \
  --network /path/to/buses.json \
  --raw /path/to/raw_positions.jsonl.gz \
  --out /tmp/recovery-check.json
```

The script performs no network requests and touches no existing database.
The shared Blue fixture and new Purple fixture contain only public vehicle
positions and route/stop metadata; full captures remain outside the repository.
