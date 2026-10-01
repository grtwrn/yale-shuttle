# Grocery service change, effective September 19, 2026

The operator supplied this notice on September 18: “Beginning 9/19/2026, the Hamden Grocery route will be the main Grocery Line which now offers Trader Joes's. The Milford route is discontinued.”

The app identifies the historic Milford service as `Grocery TJ` (route 6) and Hamden as `Grocery Ham` (route 18). Before the effective date, cards announce the coming change. From midnight in America/New_York on September 19, they describe Hamden as the main grocery route serving Trader Joe's and Milford as discontinued. Planned trips use their selected trip date.

The old alternating-weekend calendar ends for Hamden on that date. Existing weekend hours and published closure dates remain; the notice does not supply replacement hours. Milford gets no further scheduled start, even if an old upstream active flag remains true. Live physical buses retain the separate visibility rules, so an unexpectedly reporting bus is not hidden by a schedule correction.

Trip fallback cards, expanded grocery trip cards, route-hour captions and the map's route list show the notice. Retired Milford cards do not suggest a future departure or current service hours. New Hamden stop geometry, retail location coordinates and timetable changes are not inferred from the notice; those continue to come from the existing route data.

The live feed confirmed notice 27 with the title `Grocery Route`. That title now matches both grocery lines instead of being treated as system-wide. Expanded grocery cards replace this specific dated upstream notice with the single date-aware message; other service announcements are retained.

The trip search also shows the update for Milford grocery-store searches, including Trader Joe's (apostrophe variants and TJ/TJs), Whole Foods, Costco, and grocery categories. External supermarket and other grocery results in Milford qualify too. Generic store queries show it when a matching Milford result appears. Milford remains in selected grocery labels so the town and update survive selection and reloads. Explicit Hamden and unrelated searches clear it. The message names Hamden as the main grocery route and Trader Joe's as a new destination; it does not claim that every Milford retailer is now served in Hamden.

The historical feed names Trader Joe's as route 6's only shopping stop. The broader search warning does not infer a new historical stop list. Yale's [SOM grocery directory](https://groups.som.yale.edu/part/grocery-stores/) also locates Whole Foods and Costco in the Milford shopping area. The notice uses the trip's date and does not replace the chosen destination or invent a new Hamden stop.

Relevant live service announcements now appear above the route options, including when only a no-bus fallback route is available. Shared alerts show once across visible route choices; opening details retains that route's alert. The September 19 road-race notice (live announcement 28) is included verbatim and follows the feed rather than being hardcoded as a permanent suspension. The date-aware grocery transition replaces its equivalent upstream copy.

Validation covers the Eastern-midnight cutoff, historical dates, both subsequent weekends, weekday/holiday closures, stale live flags, no future Milford starts, and future-trip fallback wording. App checks and deployment run on hosted GitHub Actions to avoid loading the Pi.
