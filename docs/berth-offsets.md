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
| majority | the window holds > 50% of **all** visits | a berth asserted off a minority of the evidence |
| past the berth | ≤ 10% of visits end **ahead** of the window | a signal *past* the stop — but see the blind spot below |
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

## `aheadOfWindow` is blind exactly where the failure is worst

This is the most important thing learned on 2026-09-10 and it limits everything
above. The gate counts visits ending PAST the window, so **it only sees a signal
when the BERTH dominates.** Where the signal dominates, the signal *is* the
window and nothing lies beyond it — the count is zero and the gate passes.

It surfaced by accident. The rival guard was scoped to the route (see below),
which took qualifying cells 10 → 33, and the 23 admitted were dominated by
~100 m berths at busy downtown stops: **Phelps Gate on SIX routes at 98–107 m,
333 Cedar on five at 73–98 m**, Union Station (both), York / Cedar, Becton,
300 George St. Every one of them had `aheadOfWindow` at 0–3. A stop whose next
junction is about 100 m on, measured from six independent routes, is what a
signal looks like when the last-stand rule books it as the kerb.

**Position alone cannot separate the two, and this keeps being rediscovered.**
At Division / Prospect the signal comes BEFORE the kerb; at Phelps Gate it
appears to come after. The last-stand rule takes the last either way. The
operator's own knowledge settled Division / Prospect — nothing in this data
would have.

## The route-scoped rival guard: tried, measured, reverted

The argument is sound and is still recorded in the code as `rivalOnRoute`. The
guard exists for attribution (a visit can only be booked against a stop this
route's sequence was choosing between) and for visibility ("there is a dot there
already" is only true if the rider can see it, and the map filters to their
line). Blue Day's Chemistry / 225 Prospect berths on the **SCL** kerb 63 m short
of its own sign — and SCL is a **Red** stop a Blue Day rider never sees.

It was reverted within the hour: it is what admitted the 23 cells above. The
unscoped guard suppresses them **by accident**, and the accident is load-bearing
until there is a real discriminator.

## Chemistry / 225 Prospect, scored gate by gate

The operator asked for this one specifically. It fails five of eight, and the
rival guard is the least of them:

```
FAIL  >=20 observed visits                     18 of 20
FAIL  >=20 of them in one 40 m window          13 of 20
FAIL  window holds >=75% of the not-behind     72%
PASS  window holds >50% of ALL visits          72%
FAIL  <=10% of visits end PAST the berth       5 of 18 = 28%
PASS  berth >=35 m from the sign               -62.9 m
FAIL  clear of ANY nearby stop                 27 m from SCL
PASS  clear of a stop ON THIS ROUTE            238 m to Prospect / Edwards
```

**28% ending past the berth** is the real verdict: Blue Day appears to use both
the SCL kerb and its own sign. And the sample is thinner than n = 18 looks —
11 of the 18 visits are from 2026-09-03 alone, then 4, 1, 2.

**Chemistry / 225 Prospect and SCL are 39 m apart and are plausibly one kerb
under two ids** — SCL served by Red, Chemistry by Blue Day, Orange Day and Blue
Weekend. Measured on Red, SCL's own berth is **+2.5 m**: that dot is already
right. If Blue Day genuinely uses the SCL kerb the honest fix is to record that
those are one stop, not to invent a berth beside them.

## The stop can be different per line, and it is not a direction artefact

The operator's correction, 2026-09-10, to a bad suggestion of mine: I proposed
pooling the per-route cells at a shared stop, on the grounds that a berth is a
property of the kerb. He said the stop may be different per line. Measured over
the 53 stops served by ≥2 routes with ≥10 observations each, he is right.

Compare the **physical** distance between the berth coordinates two lines imply
(the signed along-route offsets are NOT comparable across routes — each is
measured on its own polyline, so Red passing Phelps Gate the other way reads
172 m of "disagreement" for berths physically 44 m apart; that is the only such
case in 53):

```
physical disagreement, worst pair per stop:  median 10 m, p90 107 m, max 151 m
lines physically berthing >40 m apart:       14 of 53 stops
```

**Direction explains some of it and not most of it.** Grouping pairs by whether
the two routes' bearing through the stop agrees within 45°:

```
same direction        n=48   median  7 m   >40 m apart: 10
opposite / different  n= 9   median 40 m   >40 m apart:  5
```

So **10 of the 14 big disagreements are between lines travelling the same way**.

**And the (N)/(S) suffix does not encode it.** 4 of 15 suffixed stops disagree
by >40 m against 10 of 38 unsuffixed — 27% against 26%, the same rate. Where
the operator has split a stop by direction that is real, but it is not the
thing that separates these.

Two consequences. Cells stay per (stop, route); pooling is out. And cross-route
agreement becomes *informative* rather than assumed: at Chemistry / 225 Prospect
three lines land within 11 m of each other, which is worth something precisely
because agreement is not the default.

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
