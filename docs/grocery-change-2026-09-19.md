# Grocery service change, effective September 19, 2026

The operator supplied this notice on September 18: “Beginning 9/19/2026, the Hamden Grocery route will be the main Grocery Line which now offers Trader Joes's. The Milford route is discontinued.”

The app identifies the historic Milford service as `Grocery TJ` (route 6) and Hamden as `Grocery Ham` (route 18). Before the effective date, cards announce the coming change. From midnight in America/New_York on September 19, they describe Hamden as the main grocery route serving Trader Joe's and Milford as discontinued. Planned trips use their selected trip date.

The old alternating-weekend calendar ends for Hamden on that date. Existing weekend hours and published closure dates remain; the notice does not supply replacement hours. Milford gets no further scheduled start, even if an old upstream active flag remains true. Live physical buses retain the separate visibility rules, so an unexpectedly reporting bus is not hidden by a schedule correction.

Trip fallback cards, expanded grocery trip cards, route-hour captions and the map's route list show the notice. Retired Milford cards do not suggest a future departure or current service hours. New Hamden stop geometry, retail location coordinates and timetable changes are not inferred from the notice; those continue to come from the existing route data.

Validation covers the Eastern-midnight cutoff, historical dates, both subsequent weekends, weekday/holiday closures, stale live flags, no future Milford starts, and future-trip fallback wording. App checks and deployment run on hosted GitHub Actions to avoid loading the Pi.
