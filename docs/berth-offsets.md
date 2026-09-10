# Where the bus actually stops (investigated 2026-09-09, not shipped)

The operator's ask: *"sometimes the shuttle does not stop at the location
indicated on the map. That makes it confusing for first-time riders to know where
to stand. Can we create a new dot for where the shuttle actually stops for those
that it consistently stops slightly far from the published stop location?"*

Yes — for **4 stop/route cells out of 229**. The interesting work is the other
225, because three separate things look like "the bus stops somewhere else" and
only one of them is.

`scripts/berth-offsets.mjs` is the measurement. It reads the daily archive
(`~/shuttle-archive/<day>/`, 3–8 Sep: 21,549 visits, 11,624 of them served) and
writes nothing. `scripts/berth-preview/` renders any cell on a map.

## The estimator, and why it is not the mean of the fixes

For every visit the detector scored `stopped`, take the coordinate the bus was
frozen at just before it pulled away. The feed's ~30 m deadband makes that
directly observable: a standing bus repeats one coordinate.

**But that coordinate is biased, and the bias is the whole problem.** A new
coordinate is only sent once the bus has moved ~30 m, so the last fix before it
comes to rest was taken somewhere in the 30 m *behind* where it actually stopped.
Averaging those fixes reports a berth ~15 m short of the truth at **every** stop —
a bias that would masquerade as "buses stop before the sign" network-wide, and
would have had us redraw the whole map.

Every observation is at or behind the berth *along the direction of travel*, so
the berth is the supremum of the along-path samples and a high quantile estimates
it from below with an error shrinking like 30/n. So: project each frozen fix onto
the route's published polyline, work in signed along-path metres, take p90 of the
in-window cloud.

**The falsifiable claim, and it passes.** If the published coordinates are broadly
right and the deadband is the only distortion, the network's berth offsets should
centre near 0 with spans near 30 m. Measured over 8,778 observed berths: **median
offset +3.6 m, median 10–90 span 41.6 m.** The published stop locations are, in
the main, correct.

## The decision rule

A second dot is drawn only when the berth is a fact rather than a spread:

| gate | value | what it rejects |
|---|---|---|
| observations | ≥ 20 | a berth read off a handful of visits |
| mode window | ≥ 75% inside one 40 m stretch | stops where buses genuinely stop in two places |
| distance | ≥ 35 m from the published dot | anything the 30 m deadband alone could produce |
| **rival stop** | **berth ≥ 1.5× nearer its own stop than any other** | **a visit booked against the wrong half of a stop pair** |

The rival gate is the one that matters most, and it was not in the first draft.
Five of the first twelve candidates failed it: Red's "130 Prospect Street (S)"
berth is **13 m from Prospect / Sachem (N)**, Green's "Orange / Bradley (S)" is
17 m from Orange / Trumbull, Orange Night's "Canner / Whitney (N)" is 29 m from
Whitney / Canner. This is the `(N)/(S)` invariant in CLAUDE.md — stops metres
apart can be many stops apart in sequence — showing up in a new place, and it is
the same class of error PR #190 fixed in the rider simulator. We cannot tell "the
bus berths over there" from "this visit was attributed to the neighbouring stop",
and either way the map already draws a dot there. So we say nothing.

## What qualifies

```
  berth   window (share)   span    n   stop
+ 64.9 m   35.0 .. 67.7    1.00   25 m  47   Prospect / Canner [100]   Blue Day
+ 47.3 m   16.3 .. 55.1    0.93   22 m  40   Church / George   [35]    Blue Night
+ 40.2 m   10.1 .. 42.9    0.94   29 m  33   Wall / York       [67]    Blue Night
+ 39.6 m    8.7 .. 47.0    0.94   30 m  35   Building 900      [26]    Green
```

**Prospect / Canner on Blue Day is the flagship**, and it has independent
corroboration: 47 of 47 visits berth in a 25 m window 65 m up Prospect Street, and
OpenStreetMap's own *northbound* Prospect/Canner marker sits right there. Our
single stop id carries the *southbound* coordinate, so a Blue Day rider following
the dot stands 65 m from where the bus opens its doors. This is also the operator's
own trip origin and the rider canary's board stop.

## Division / Prospect on Red — the stop the operator asked about — does not qualify

50 observed visits, and the densest 40 m window holds **62%** of them; the 10–90
spread is **56 m**. The dots run the length of the block: a cluster around the
Division/Prospect corner and a second ~55 m down Prospect. Red buses stop on
either leg of the corner and there is no "actually stops here" to tell anyone.
The honest answer at that stop is the published dot, and the rule returns it.

That is the useful half of the result. A rule that fired at Division / Prospect
would have invented a berth out of a bimodal cloud and pointed first-time riders
at one of two places the bus uses.

## Before this ships

- **The traffic-signal confound is not resolved.** A bus queueing at a light just
  past a stop is indistinguishable from a berth by position alone. The rival gate
  removes the cases where the light sits at another stop, and the 75% window gate
  removes the ones where the bus only sometimes catches the light — but a signal
  that is red most of the time, 40 m past a stop with no neighbouring stop, would
  pass. None of the four qualifying cells looks like one (Prospect / Canner is
  mid-block, corroborated by OSM), but the discriminator should be duration or a
  doors signal, not position.
- **Four cells is not a feature yet.** Decide whether four dots justify a new map
  concept, or whether the right shipping shape is a line of text on the stop —
  "buses stop about 65 m north, outside the Administration Building" — which costs
  no map legend and no new marker vocabulary.
- **Two of the four are Blue Night**, whose riders are the ones most likely to be
  standing in the dark at the wrong spot. That may be the argument for shipping it.
- Re-measure on more days. Six days of archive is 20–50 visits per cell; the rule
  wants ≥ 20 and the estimator's error falls like 30/n.

## Running it

```bash
curl -s https://yale-shuttle.fly.dev/api/buses -o /tmp/buses.json
node scripts/berth-offsets.mjs --payload /tmp/buses.json --json /tmp/berths.json
node scripts/berth-offsets.mjs --payload /tmp/buses.json --stop 48   # one stop

# the map preview
cp /tmp/berths.json /tmp/buses.json scripts/berth-preview/
cd scripts/berth-preview && python3 -m http.server 8099 --bind 127.0.0.1
# http://127.0.0.1:8099/index.html?stop=100&route=1
```
