# Winchester wait to the next Division pickup

The current Winchester release model already bypasses the old fleet-wide
upper-side widening. Applying that older adjustment to its lower tail can
still pull a useful pickup bound toward zero. The next Division / Prospect
arrival now retains the model's lower tail while the supported Winchester
release model is active. Its distribution dots receive the same correction.

This is specific to Red, a supported current Winchester hold, Division's
first arrival, and a leading route position that has not passed that pickup.
There is no minimum ETA, maximum window, quantile change, or outcome-based
exclusion. The point estimate, upper bound, position tracking, Rosenkranz
destination window and following arrival retain their prior behavior.

## Paired replay

The unchanged production comparator is commit `56a5258`. Separate processes
replayed the original September 16–17 observations in original order, with
the release model enabled in both arms. The baseline exactly reproduced all
150,020 archived current-code arrival rows. The final candidate preserved all
row identities, points, upper bounds, other destinations, following arrivals
and tracking records; 4,035 lower bounds changed. The 151 periodic full-server
comparisons also passed. September 18 morning added 1,992 polls and 18,209
rows, using calibration inputs completed before that date.

These are chronological code replays, not exact recordings of what every
rider saw: collector clocks are reconstructed, and the September 18 replay
uses the earlier frozen tables and prior September 17 fit. September 16–17
were previously inspected development data. The September 18 ablation was
defined before scoring that new date; the final narrower scope also used
those results and is not an untouched holdout.

Division first-arrival windows after recorded Winchester pin, September 16–17:

| Elapsed wait | Visits | Mean window width, before → after | Actual arrival below lower bound |
| --- | ---: | ---: | ---: |
| 1 minute | 60 | 8.71 → 7.77 min | 0 → 0 |
| 3 minutes | 38 | 7.28 → 6.07 min | 0 → 0 |
| 5 minutes | 29 | 6.47 → 5.40 min | 0 → 0 |
| 7 minutes | 21 | 5.28 → 4.41 min | 0 → 0 |

The candidate's median increase among changed warmed Division readings is
67 seconds. These repeated readings are not independent journeys. On
September 18, seven completed Winchester-to-Division trips were available:
the one-minute width changes 12.26 → 11.50 minutes, with no added lower-bound
miss at that checkpoint. Existing upper misses remain; this is not proof of
nominal coverage or a solution to every broad window.

## Catching the bus

Continuous checks distinguish arrival from the end of boarding. Some valid
near-departure cases arrive before the raised lower bound: the largest new
early arrival is about 23.5 seconds in the reused dates and 3.3 seconds on the
new morning. They are retained. Across the matched stopped Division targets
(53 on the reused dates and seven on September 18), neither arm's lower
timestamp falls after the recorded pickup departure. Among affected stopped
visits, the smallest candidate margin is about 22.8 seconds on the reused
dates and 56.6 seconds on September 18. GPS departures are proxies for doors,
and this is not a guarantee that a rider cannot miss the bus.

The continuous audit explicitly counts four unchanged rows where only a
next-lap forecast was saved because the replay omitted the already-arrived
zero-hop row. Those rows are not relabeled as the current pickup. Unknown
departure lists and passed-stop outcomes remain separately accounted for.

The app's connection warning compares walking time directly with the pickup
lower bound, without an extra one-minute safety margin. Raising the bound
can therefore remove a connection warning. Leave reminders use the unchanged
point ETA minus walking time and their existing 30-second margin; their
trigger does not change. The audit is a retrospective timing check, not an
observed-rider or walking-speed trial.

Broadly removing lower widening was rejected: Rosenkranz departure-phase
lower misses and interval scores worsened repeatedly. Its destination
window and other pickup/occurrence margins remain unchanged. The accepted
scope gives a modest useful increase, not a cosmetic replacement of a
1–16-minute window with an unsupported tight promise.

Reproduction artifacts, frozen plans, scripts, per-visit outcomes, original
failures and independent review are under the workspace directory
`red-lower-data-2026-09-18/`. Focused pricing tests cover matching distribution
dots, other destinations, following laps, unsupported laps, other routes and
a leading position already beyond Division.
