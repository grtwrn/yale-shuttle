# Shared server ETA tracking

Live riders read one continuously updated forecast from `/api/buses.server_eta`.
Opening a browser no longer initializes a separate tracking model. The server
uses the same ring estimator in `web/src/arrivals.ts` and the existing historical
calibration. Two tracking corrections accompany the migration: reacquire a
repeated-stop branch when fresh GPS and a changed stop hint end its kerb visit;
retain meaningful posterior mass on the held branch when pricing, without
resurrecting numerical remnants of a disproven branch.

## Observation and forecast clocks

`ServerEta` runs from the collector's poll observer even without viewers.
`observationVersion()` advances only after GPS updates. Calibration, topology
refreshes and HTTP cache refreshes cannot become repeated GPS evidence.
Each bus also carries `observed_at`; an unchanged observation reuses its object
so another bus's successful poll cannot advance the missing bus's belief.

The v2 wire contains:

- `at`: forecast calculation time; `servedAt`: response assembly time.
- `buses`: `[name, routeLabel, canonicalAnchorIndex, standingState]`.
- `rows`: `[busIndex, stopId, eta, low, high, stopsAhead, estimated, departNow, lowFloor]`.
- Optional `distributions`: one array per row, containing 50 equal-mass quantiles
  (1%, 3%, …, 99%) in rounded seconds. Older v2 clients ignore this additive field.

Repeated stop visits remain separate rows. Arrivals, stops-away and holds come
from the same server state. The reader accounts for observation age and elapsed
client time without requiring the phone clock to agree with the server clock.
Conformal lower bounds may be negative internally; the display clips them to now.

A forecast expires after 45 seconds. Individual missing buses are removed from
forecast rows after the same interval, even if still within the map's 120-second
position TTL. Missing, malformed or stale live output yields no local fallback:
trip timing becomes unavailable, class recommendations and leave reminders are
withheld. GPS map positions may remain visible. Pure estimation remains available
for offline tools and hypothetical planning.

## Rider distributions and recorded trips

The server samples the existing priced mixture before it is discarded, applying
its held-arrival shift, route/horizon corrections and interval widening to the
samples. This preserves separate route branches and layover tails; it does not
fit a normal curve through the displayed low/point/high. The point and bounds
are unchanged. Missing or malformed optional samples suppress only the graph.
Samples age and expire with their corresponding live arrival rows.

The pickup dialog leads with observed source-to-target journeys. Filled model
quantile dots on a clock axis sit in a separate, initially collapsed "Forecast
for this shuttle" section. The class-arrival disclosure uses the selected
bus's forward drop-off distribution plus its final walk, with target, class and
walking markers. It does not add marginal pickup and ride quantiles. Class
recommendations state that the shuttle *may* fit the buffer and keep the catch
assumption beside that conclusion. Dot fractions are not validated on-time
probabilities.

Opening either disclosure requests
`/api/journey-history?route=Red&bus=308&stop=48&eta=360`. The bus/ETA identify the
selected forward occurrence in the existing warm server snapshot; requests do
not advance tracking. Stale snapshots, ambiguous repeated sources, later laps,
and contradictory/approach rest states have no comparable starting point.

The reader uses `stop_visits` and `legs`, without old predictions or rider
reports. It examines at most 240 recent source visits in 30 days and returns
at most 24 independent completed paths (one dot per target visit, not one per
poll). Paths connect exact departure/arrival timestamps through intermediate
visits, preserve route occurrence indices, and reject gaps, missing legs,
wrong-direction hops and weak target arrivals. Both endpoints must have a
recorded stop; pass-through endpoint visits are excluded and disclosed. Departure timestamps use the
existing time-leading leg index. Similar weekday/weekend and local time within
two hours constrain comparisons. "Independent" here means distinct visits;
trips on the same day or bus can still be statistically dependent.

For a stopped bus, the historical reference instant is `pinned_at + elapsed`,
including only visits still stopped then. Live elapsed time comes from the
collector's `at_stop_since` (the same pinned clock), rounded down to five
seconds. It is used only when the warm estimator agrees with the pinned stop
and the latest movement was at least ten seconds ago. The graph includes the
remaining stop wait and the connected journey to the target. It does not
replace the estimator's potentially earlier approach-rest clock.

For a moving bus, the graph explicitly shows complete times measured from
departure at the starting stop, as context. No duration is prorated into a fake
observed remaining time. The live ETA handles present progress. Historical
matching at exact GPS positions remains a later extension requiring sufficient
recorded trajectories and direction/occurrence checks.

Hollow dots retain their actual horizontal values and show recorded durations,
with dated timing anchors in a table, a sample/date count, an observed median
when at least five trips exist, and the last three recorded arrivals. The
min/max is not presented as a prediction interval. Destination history ends at
the drop-off stop before the final walk.

Each opening or explicit refresh obtains a labeled snapshot, with no hidden
polling. The reader has a bounded 60-second cache keyed by route occurrences,
mode and elapsed-wait bucket; the public endpoint is rate limited and marked
`no-store`. Sparse/failed history does not block live estimates. The old
`/api/arrival-history` similar-ETA diagnostic remains for cached older clients;
the new UI no longer uses it.

## Restart recovery

The single `eta_checkpoint` SQLite row saves the belief and display history at
most every 30 seconds, using a versioned V8 serialization that preserves typed
arrays and Maps. A checkpoint no older than two minutes can restore tracking
across a short deployment. Stale, incompatible or corrupt data is discarded;
checkpoint write failure does not suppress a live forecast. Historical segment,
stand and lap calibration remains in the existing database and loads separately.
A long outage cannot recover *current* GPS knowledge from old recordings.

Raw GPS retention is 36 hours so the overnight archive can retain a full prior
operating day for calibration replay. The former six-hour window had removed
daytime Red GPS before the archive ran. Derived visits, legs and arrivals retain
their existing 90-day history. Route geometry still uses a six-hour input window.

Default: all supported routes. `SHUTTLE_SERVER_ETA=0` withholds live ETA output;
it does not restore browser estimation. `SHUTTLE_SERVER_ETA_ROUTES` can restrict
served routes. `/healthz.serverEta` reports steps, failures, active beliefs,
forecast/checkpoint timestamps, restored beliefs, rows and calculation cost.

## Verification

- Forty recorded network polls compare every arrival field against the same
  estimator with independent state (0.5-second rounding tolerance), then pass
  the real wire through the browser reader.
- Restart continuity, corrupt/expired checkpoint handling, missing-bus expiry,
  clock skew and missing/malformed forecasts have regression tests.
- Docker import-closure tests ensure server estimator sources reach the image.
- `SERVER_ETA=1` in `scripts/eta-replay/rider-sim/run.ts` runs a shared engine
  through the capture before riders join. The default retains per-session
  browser state for paired comparisons. Both arms use identical observations,
  calibration, destinations and rider start times.
- Recorded mobile checks exercise the ETA interval dialog, class deadline,
  narrow-screen layout and failed-feed behavior.

The model remains synchronous on the collector's event loop; watch `lastStepMs`
and collector lag. Historical foundation measurements were approximately 35 ms
per warm poll on a Pi 5. Current production measurements, rather than this old
benchmark, determine capacity. Calibration tables are still published for
future planning and useful stop statistics. No exact probability of making
class is claimed from an unvalidated nominal interval.
