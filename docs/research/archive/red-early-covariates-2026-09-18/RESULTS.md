# Early Winchester departures before Division pickup

The user confirmed that the target is the Red bus reaching Division / Prospect,
then asked to re-check lap time, anchor timing and the buses ahead/behind in
genuine early cases. This is an artifact-only investigation following deployed
pickup policy PR294. No new ETA model or lower-bound increase was shipped.

## What the cases actually show

The four changed pickup lower-tail cases are valid journeys. They are not four
unusually short Winchester holds: pin-to-departure waits were 160.1, 500.1,
285.1 and 749.9 seconds. Their worst changed-bound errors occur at departure
or within ten seconds afterward; the onward drive to Division takes 60–80
seconds. Keep these observations.

The short hold in visit64318 is consistent with compensation for a longer
preceding lap: lap3281.7s + hold160.1s =3441.8s, versus visit65347's
lap2964.2s + hold500.1s =3464.3s. This supports the already-used lap covariate;
it does not prove driver instructions or fully explain the lower-tail miss.

The independently audited case record is
`../red-lower-data-2026-09-18/early-case-covariates.md` and its `.py/.json/.log`.
Proven-truncated visit65237 is excluded only as a hold-duration outcome:
raw movement and its reached outgoing leg confirm that its departure remains
valid prior-bus evidence. No legitimate short/long outcome was trimmed.

## Re-check beyond the selected cases

`PLAN.json` froze seven models before the new score. The read-only export and
causal feature extraction produce160 training holds before September14,
113 later holds on September14–17 and12 on September18. Labels ask whether
the bus departs within120s at elapsed wait0/60/180/300/480s. Previous event
known-times use explicit conservative proxies; no future actual bus arrival
or departure is an input. Training-only travel sums are anchor-time proxies,
not actual future arrival times.

Adding the bus's own elapsed time since leaving Union improves the classifier's
visit-balanced Brier score from0.13461 to0.13231 on September14–17 and0.08787
to0.07371 on September18. Aggregate scores improve on each later date. The
independent fixed-elapsed check confirms gains at all five old-date checkpoints,
but September18 has small regressions at300/480s. Longer own lap and longer
Union age increase the fitted chance of leaving soon. The live estimator
already uses own lap and a15-minute clock phase.

The classifier weights each visit's landmarks to total one. That fit targets
a sampled-landmark population and is not a calibrated live departure probability.
Risk bins must not become displayed percentages or a new minimum pickup time.

Ahead/follower additions are inconsistent across dates and availability
contracts. The initial run mistakenly retained historical peer source-age
features when the current snapshot was unusable. That contract error was
fixed before interpretation; original script/output files remain under
`.before-unusable-peer-correction` names. `audit-inputs.py` verifies sorted
legacy departures, all visit weights, complete descriptive strata and zero
unusable-peer inputs. The legacy export's exact route-filtered query is saved
in `capture-legacy.py`.

A real limitation remains: in visit70927, the120s confirmed-departure rule
latched #306 as both ahead and follower, although recorded reconstructed wire
already showed #316 at Division, about60s after Winchester departure. Thus
these negative/mixed coefficients do not rule out physical neighbor effects.
Actual causal movement/receipt-based neighbor identity is the next measurement
issue to resolve before trying more elaborate coordination models.

## Full remaining-wait distribution check

`union-survival/` predeclared two matched arms and fit one ordinary event-history
likelihood per training hold, avoiding outcome-dependent landmark weights in
training. The baseline matches unchanged runtime component quantiles to within
0.00018s on supported laps. This is a frozen component comparison, not full
live ETA replay or untouched calibration validation.

On100 supported-lap September14–17 visits, adding Union age improves WIS from
44.26 to43.85s and mean10–90 width from298.1 to292.6s. On nine supported
September18 visits, WIS changes58.46 to57.35s and width377.8 to373.5s.
The two extra early-bound misses are two distinct valid journeys, crossing
by only0.29s and1.42s; an additional late checkpoint is7.03s late within an
already-late visit. These are modest regressions, not evidence of major new
boarding harm. Larger all-cohort gains are concentrated in unsupported laps,
where runtime retains its marginal fallback.

Union age has some signal, but narrowing by4–6s does not address a many-minute
pickup interval. Independent review finds no basis here for a further lower
bound increase or model deployment. The potential feature is preserved; the
valid regressions and the original early cases remain in the evaluation.

No production records, model parameters, collector or watcher were changed.
The separate route-card presentation change is PR295; it exposes existing
destination bounds and makes no estimator change.
