# Protected-window frontend contract audit

Pinned before execution, September 22, 2026. Research only, production source
05a988194af3c376e5aa5da16682c29f797db2b2. No model fits, new fleet dates, user
reports, or deployment. This is a deterministic software sensitivity audit,
not a historical estimate of changed recommendations or rider misses.

The existing fixed-visit experiments apply:
eta = deployed.eta; low = min(deployed.low, candidate.low, deployed.eta);
high = max(deployed.eta, candidate.high).
All roster, ordering, occurrence, point, freshness and raw at-stop evidence
must remain identical. We audit those assumptions, not tracking changes.

Use actual production exports: rideBoardArrivals, boardingVisitAllowed,
pickLiveArrival, forecastPickupSelection, atStopJourneyBoard, journeyArrival,
preferredTripOrder, stableTripOrder, topVisibleOptions, findReminderOption,
liveReminderInput, secUntilLeave and computeLeaveAlert. Do not copy ranking or
selector logic into the harness. Run existing relevant tests as controls.

1. Deterministic selection grid: point seconds 0,59,60,89,90,150,299,300,301,
600,1200 for two buses; walks 0,59,60,180,300,600; pins absent/A/#A/B.
Include same-bus later pickups, interposed repeat pickup before destination,
and raw-at-stop associations. Change bounds only, with an unchanged arm and
two protected transformations (lower unchanged or earlier; upper at point
or point+60). Require the exact selected bus, stop occurrence, point,
departure/missed-bus verdict and selection relation to remain unchanged.

2. Deterministic reminder grid: point 0,1,59,60,61,119,120,121,300,600,1200;
lower 0, point/2, point; upper point, point+60, point+600; candidate lower
0 or deployed lower; candidate upper 0 or point+60. Walks 59,60,180,300,600;
ages 0,5,15,30,44,45 seconds. For valid same-visit inputs, transformed
secUntilLeave must never be later. Check the actual live reminder adapter on
different-bus and later-same-bus visits, freshness expiry and reordered route
lists; an armed route is identified by label and stops, not top-card position.
Never deliver notifications.

3. Prespecified counterexamples through actual journey/ranking functions:
(a) tightening a destination upper bound creates >90-second separation and
promotes a longer-commute route; (b) moving a destination lower bound earlier
removes separation and restores a shorter-commute route; (c) earlier pickup
low changes order when destination is unknown; (d) earlier pickup low changes
catchRisk from false to true with the same bus/point. Check strict 90-second
boundary, the 30-second persistent-change hold, a reverting blip, initial
plans, route-list reorder and a four-shuttle visibility example. Differences
are expected findings, not failures or proof of greater missed-bus risk.

Report every case and counts separately. Do not interpret synthetic frequency
as traffic-weighted behavior. No full React/browser/geographic plan replay is
claimed. Existing distribution arrays are not made coherent by replacing two
bounds; no probability/calibration claim or production API change is allowed.

Before a future window promotion, either replay complete simultaneous option
sets and real selection policies against independent physical boarding labels
(explicit unknown/censoring), or define and evaluate a separate ranking policy.
The current fixed-visit safety gate remains necessary and insufficient for a
claim of whole-app boarding safety. Do not silently freeze/change ranking to
make the audit pass.
