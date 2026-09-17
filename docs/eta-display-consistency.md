# ETA labels and waiting bus markers

Reports 113 and 114 (September 17, 2026) describe a mini-map ETA alternating
between a single estimate and a range. Their screenshots show the older map
label alongside the newer trip card's point plus likely window.

The map and stop rows still used `displayBand`: it suppressed ranges narrower
than three or wider than fifteen **printed** minutes. Both cutoffs depended on
flooring the two endpoints separately. A two-second countdown can turn a
119–241-second interval (printed 1–4) into 117–239 (printed 1–3), replacing it
with a 2-minute midpoint. At the other cutoff, a Red interval could replace a
9-minute midpoint as its printed width changed from sixteen to fifteen minutes.
These are reproductions of the display rule, not raw telemetry recovered from
the screenshots.

All surfaces use the trip card's `arrivalSummary` through `mapArrivalLabel`.
The mini-map is compact: **(R) A–B min**, one line per route. It retains every
available window regardless of width, with outward endpoint rounding; the
point estimate stays on the card and stop rows. A missing window gets an
explicitly approximate **~N min**, and an observed arrival says **At stop**.
Genuine forecast updates still change the values. Missing or stale forecasts
do not retain a fabricated map arrival. Wait labels avoid arrival chips and
map controls; the map reserves space above its endpoints for these labels.

At a wait stop, the bus's mini-map marker has a permanent label next to it:
**Red M:SS/~Nm**, a single compact line placed closer to the bus. The full
route name uses the bus marker's route color so nearby buses remain
identifiable. The tooltip and accessibility label spell out elapsed waiting
time and typical total, including whether the bus is waiting nearby.
The elapsed clock comes from the
shared warm standing state; the typical total comes from the same historical
stand quantiles used by the stop list, not the legacy arrival-to-arrival hop
median. The label names nearby waits, updates without recreating the marker,
and disappears when the bus moves or its live state expires. Only stops with
sufficient data and a typical wait of at least three minutes receive it, as in
the existing wait-stop labels. Typical total is context, not time left.

Regression tests reproduce both cutoff switches, compare map/card wording,
exercise waiting/moving and missing-table states, and cover wait-label
collisions. The recorded mobile browser check also verifies an advancing wait
clock with a stable typical total. No ETA model coefficients, forecast values,
or arrival-selection rules change.
