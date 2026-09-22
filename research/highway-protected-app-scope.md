# Protected-window application scope limitation

Recorded September 22, 2026 while hosted run 35690386363 was in progress. This note does not change the pinned transform, inputs, fitting, quality policies, cohorts, or scoring rules.

The fixed-visit replay evaluates one actual bus and physical boarding visit. Preserving its point forecast and preventing later pickup lower bounds controls that replay's reminder timing. It does **not** establish unchanged route recommendations, transfer behavior, or complete application boarding risk.

The application has additional dependencies: `tripRanking.ts` compares destination low/high bounds to decide whether a route is clearly earlier (`b.high + 90 < a.low`) and applies a 30-second stability hold. Its missing-destination fallback uses pickup low. `journeyArrival.catchRisk` also uses pickup low. Consequently a protected window can alter route ordering or catch-risk presentation even though its point forecast is unchanged.

Those decisions require a separate actual-selector/ranking audit, owned by the parent research task. No route-choice stability or complete-journey safety claim follows from this study. The hosted report's hypothetical fixed-visit action metrics must be read together with this limitation.
