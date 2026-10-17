# Blue Weekend: nearby poles across the Stop & Shop detour

Blue Weekend lists Broadway/York (21), Stop & Shop (116), then Elm/York
(53). Poles 21 and 53 are about 22 metres apart, but stop 116 requires a
substantial out-and-back. The two-stop anchor window previously selected 53
on the outbound pass, five seconds after 21, then went backwards to 116 and
recorded 53 again on the return. A stationary outbound pass could become a
false completed stop visit and a false 21→53 training leg.

The detector now excludes that two-hop candidate when the nearby poles and
continuous observations cannot contain the intervening journey. It uses the
existing 75 m stop allowance, 250 m discontinuity allowance, and 25 m/s
continuity bound. Adjacent calls, sufficient observation gaps, missing stop
geometry, and discontinuous fixes retain their previous behavior.

The committed fixture contains 360 public fleet fixes for bus #44 on
October 3, 12:40–13:10 UTC. Its later Elm/York resting plateau begins at
13:04:03.483 UTC within the collector's 75 m zone; the separate 45 m curb
criterion first fires at 13:04:13.449 UTC. These clocks are deliberately
kept separate. The six regression/control tests fail twice against base
`b3320691a3a06acffb611e232792d0f5fee811cd` and all pass with the fix.

Full raw-position replays use identical published network geometry in both
arms. Saved October 3 metadata and the October 16 live feed have identical
stop coordinates, route sequences, and route paths. Weekday archives were
checked against their manifest SHA-256, row count, and completeness receipt.

| Date (ET) | Raw positions | Elm/York visits before → after | Other route event streams |
| --- | ---: | ---: | --- |
| October 3 | 78,928 | 18 → 9 | Identical SHA-256 digests |
| October 4 | 83,319 | 22 → 11 | Identical SHA-256 digests |
| October 14 | 181,142 | Route 4 inactive | All routes identical |
| October 15 | 181,832 | Route 4 inactive | All routes identical |

All 20 retained return visits preserve their original bus, arrival time,
departure time, standing duration, and outcome. Their counts match the
existing curb-plus-served-feed check (9 and 11). Exactly 20 false arrivals,
20 false visits, and 20 false 21→53 legs disappear. They are replaced by
20 Broadway/York dwells, 20 segments and 20 legs from 21 to 116. Counts at
nearby stops 21, 116, 150, and 41 are unchanged.
An existing October 4 disagreement at stops 21/150 (11 collector visits
versus 10 curb/feed matches) remains outside this fix.

This is a consistency correction to recorded occurrences, not independent
proof of boarding or an ETA accuracy improvement. The learning cycle must
restart after deployment because its frozen observation code changes.
Previously collected evidence remains retained.

[checks.json](checks.json) contains input hashes, per-route event digests,
visit counts, and regression/control results for all 525,221 observations.

To reproduce with retained public captures, run from the repository root:

```sh
npx --prefix services/shuttle-v2 tsx pr-preview/blue-weekend-occurrence/replay.mts \
  --source services/shuttle-v2 \
  --network /path/to/buses.json \
  --raw /path/to/raw_positions.jsonl.gz \
  --out /tmp/candidate.json
```

Run the same script with `--source /path/to/base/services/shuttle-v2` and
compare `byRoute` hashes and visit counts. The replay writes only the given
output file and never modifies the database. Full captures stay outside the
repository; the regression fixture contains no rider reports or context.
