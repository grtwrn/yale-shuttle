# Useful, stable route comparisons

Route order must not treat a transient pickup estimate as a change in route quality. The live UI derives a ride estimate from destination and pickup forecasts; that difference can jump. Plans now retain their original ride duration separately for route comparisons. Displayed ETAs, ride times, and destination windows continue updating.

Within the existing availability and walking-competitiveness tiers:

- A full destination arrival window entirely earlier than another (with 90 seconds of separation) ranks first.
- When windows overlap, compare walking plus the planned ride. An unavailable destination window retains only the earliest bound implied by walking to pickup, the pickup lower bound, and the final walk; its latest bound remains unknown. Among trips within one minute of that cost, keep the prior order; initially prefer less walking.
- A new order must remain preferred for 30 seconds. Availability changes and explicit new plans take effect immediately; current-location GPS changes do not reset the confirmation period.
- Select from the resulting partial order rather than using a pairwise overlap sort, which can be non-transitive.

The third-route visibility rule also uses planned travel duration, so wait/ETA jumps cannot flash it off screen. The separate class-time panel still checks full destination windows, catchability and feed freshness; unknown arrival windows cannot become an on-time recommendation.

Both planners and the geographic fallback suppress routes unless they save at least two minutes of walking, scaled to 20% of the direct walk for trips shorter than ten minutes, and at least 10% for walks longer than twenty minutes. This is a rider preference, not a fitted prediction parameter. Within a route’s near-fastest boarding/alighting alternatives, minimize total walking, then riding.

Validation includes mixed/overlapping destination windows, an overlap chain that would break a naive comparator, one-poll reversals and sustained improvements, immediate unavailable-route demotion, walking alternatives, changing live rides with fixed planned rides, and walking-saving boundaries. Full tests/typechecks/build and recorded Division/Prospect → Rosenkranz phone flows passed. A synthetic six-phase Red ETA sequence over recorded geometry verifies that estimates update without changing route order; it measures UI stability, not forecast accuracy.

The reported Red 1–19 minute model window is a separate unresolved issue. The no-running-minimum experiment reproduced delayed departure responses and larger reversals, so this change does not alter ETA-model coefficients, beliefs, or intervals.

The runtime Docker image explicitly includes the shared walking policy, and the import-closure test now covers both the estimator and server planner. Container imports are verified before release.
