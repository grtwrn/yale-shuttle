# Where the bus actually stops (investigated 2026-09-09, not shipped)

The operator's ask: *"sometimes the shuttle does not stop at the location
indicated on the map. That makes it confusing for first-time riders to know where
to stand. Can we create a new dot for where the shuttle actually stops for those
that it consistently stops slightly far from the published stop location?"*

Yes — for **10 stop/route cells out of 235**, Division / Prospect on Red among
them. The interesting work is the other 225, because four separate things look
like "the bus stops somewhere else" and only one of them is.

**Corrected 2026-09-10 by the operator, who knows the ground truth at Division /
Prospect: "there are two groups, the more northern group is because there's a
stop light but the southern group is where it stops."** The first version of
this script counted both as evidence, put the mode window at 67% and refused a
berth it could see. Two changes follow from that and both are below: one
observation per visit is the LAST stand, not the last fix; and a stand behind
the berth cannot argue against it.

`scripts/berth-offsets.mjs` is the measurement. It reads the daily archive
(`~/shuttle-archive/<day>/`, 3–8 Sep: 21,549 visits, 11,624 of them served) and
writes nothing. `scripts/berth-preview/` renders any cell on a map.

## The estimator, and why it is not the mean of the fixes

For every visit the detector scored `stopped`, take the coordinate the bus was
frozen at just before it pulled away. The feed's ~30 m deadband makes that
directly observable: a standing bus repeats one coordinate.

**One observation per visit, and it is the LAST STAND — a frozen run of at least
10 s — not simply the last fix.** A bus can be stationary near a stop for two
reasons and only one is a berth. At Division / Prospect Red waits at the corner
to turn off Division onto Prospect, then pulls 55 m down Prospect and opens its
doors. The data says which is which without being told: **in all 24 visits that
show both, the corner stand comes first.** Duration cannot do this job — the
median hold is ~25 s at *both* clusters — and neither can position alone.

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
| mode window | ≥ 75% of the visits **not behind it**, and ≥ 20 outright | stops where buses genuinely stop in two places |
| past the berth | ≤ 10% of visits end **ahead** of the window | a signal *past* the stop, the one shape we cannot explain |
| distance | ≥ 35 m from the published dot | anything the 30 m deadband alone could produce |
| **rival stop** | **berth ≥ 1.5× nearer its own stop than any other** | **a visit booked against the wrong half of a stop pair** |

**The window is scored against the visits that are not BEHIND it, and that
asymmetry is a fact about the mechanisms rather than a fitted constant.** Every
way a spurious stand can arise puts it behind the berth: the deadband lags, a
queue at a signal is on the way in, and a visit where nobody boards leaves no
stand at the kerb at all so its last stand is whatever came before. None of
those is evidence against where the kerb is. A stand *ahead* of the window is
the one shape that would be — a signal past the stop — so it is capped
separately at 10%. Division / Prospect has 15 behind and 3 ahead of 55.

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
  berth   window          in/notBehind  behind ahead    n   stop
+ 90.5 m   52.9 ..  92.2     23/25  .92     12     2   37   100 Church Street South  Purple
+ 88.4 m   54.8 ..  94.7     38/40  .95      7     2   47   Elm / Orange             Orange East
+ 65.4 m   35.1 ..  72.0     37/39  .95      8     2   47   300 George St            Blue Night
+ 64.4 m   35.0 ..  67.7     52/52 1.00      0     0   52   Prospect / Canner        Blue Day
+ 64.3 m   26.3 ..  66.1     35/36  .97     19     1   55   Canal / Munson           Red
+ 55.4 m   22.6 ..  59.0     37/40  .93     15     3   55   Division / Prospect      Red
+ 49.4 m   16.3 ..  55.1     39/39 1.00      3     0   42   Church / George          Blue Night
+ 40.1 m   10.1 ..  42.9     32/32 1.00      2     0   34   Wall / York              Blue Night
- 39.1 m  -64.0 .. -36.0     21/21 1.00      0     0   21   Chapel / Dwight          Blue West
+ 36.3 m    8.1 ..  47.0     43/43 1.00      2     0   45   Building 900             Green
```

**Two of the ten are Red, and both are corners the line turns at** — Division /
Prospect and Canal / Munson. That is the shape to look for: where the route
turns, the signal stop and the kerb are different places.

**Prospect / Canner on Blue Day is the flagship**, and it has independent
corroboration: 47 of 47 visits berth in a 25 m window 65 m up Prospect Street, and
OpenStreetMap's own *northbound* Prospect/Canner marker sits right there. Our
single stop id carries the *southbound* coordinate, so a Blue Day rider following
the dot stands 65 m from where the bus opens its doors. This is also the operator's
own trip origin and the rider canary's board stop.

## Division / Prospect on Red — the case that corrected the rule

55 visits, two clusters ~55 m apart, and the first version of this script called
that a spread and refused it. The operator supplied the ground truth: the
northern cluster is the signal, the southern one is the kerb. Everything the
data can check agrees —

- **+ along the route is SOUTH here.** Red comes east along Division and turns
  south onto Prospect, so the corner is a turn at a signal.
- **The corner stand comes first in all 24 visits that show both.** A bus queues
  to enter the block and then berths.
- **Duration cannot separate them**: the median hold is 24.9 s at the corner and
  24.9 s at the berth.
- **The 9 visits whose only stand is at the corner drive straight on afterwards**
  — 16 → 54 → 91 → 154 m with no second stand. That is a bus held at the light
  with nobody to pick up, not a bus berthing at the corner.

Berth: **+55.4 m, 41.324475, −72.923216**, from 37 of the 40 visits that berthed
at all, in a 22.6–59 m window. 15 visits stopped short of it, 3 past it.

## Before this ships

- **A signal PAST the stop is still not separable from a berth.** The last-stand
  rule would call it the kerb. `aheadOfWindow` is the indicator and it is capped
  at 10%, but that is a bound on the damage, not a discriminator — the real one
  would be duration (which we have measured to be useless here) or a doors
  signal (which the feed does not carry). No qualifying cell has more than 3.
- **Ten cells may still not be a feature.** Decide whether ten dots justify a new
  map concept, or whether the right shipping shape is a line of text on the stop
  — "buses stop about 55 m down Prospect, past the lights" — which costs no map
  legend and no new marker vocabulary.
- **Three of the ten are Blue Night** and two are Red, the two lines with the
  most riders standing in the dark at the wrong spot. That is the argument for
  shipping something.
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
