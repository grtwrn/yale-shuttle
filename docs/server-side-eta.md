# Shared server ETA tracking

Live riders read one continuously updated forecast from `/api/buses.server_eta`.
Opening a browser no longer initializes a separate tracking model. The server
uses the same ring estimator in `web/src/arrivals.ts`; the migration changes
who owns its state, not the statistical model or calibration parameters.

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

## Restart recovery

The single `eta_checkpoint` SQLite row saves the belief and display history at
most every 30 seconds, using a versioned V8 serialization that preserves typed
arrays and Maps. A checkpoint no older than two minutes can restore tracking
across a short deployment. Stale, incompatible or corrupt data is discarded;
checkpoint write failure does not suppress a live forecast. Historical segment,
stand and lap calibration remains in the existing database and loads separately.
A long outage cannot recover *current* GPS knowledge from old recordings.

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
