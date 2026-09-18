A Red rider could see `in 9, 23 min → 2–17 min · 2 buses → in 9, 23 min` in 20 seconds because a width cutoff switched between incompatible headline forms. Keep an approximate arrival above its full likely window; tapping shows the interval, next shuttle, estimated gap, stops away, and any observed hold. Use observed stop presence for “At your stop.”

Smooth the conformal multiplier at horizon boundaries, sharing the function with nightly scoring. Also fix nightly replay omitting production lap covariates: load 90-day history, exclude departures after the replay cutoff, emit lap fields, and invalidate old replay caches. Update watcher parsing, point-jitter detection, card activation, and the server Docker import closure.

Recorded September 16 evidence:
- 3,453 watcher bus frames: point predictions identical; stop-48 coverage unchanged at 96.9%; >=60-second interval endpoint jumps 130 → 125.
- Red GPS replay: detector coverage 84.0% → 84.3%; median interval width unchanged. No deliberately narrower coefficients promoted.
- Paired rider replay: 203 waits, outcomes and bus selections identical. First-sight raw interval coverage remains 66.5%; cold-start uncertainty and underlying point errors remain limitations. Broad windows are not counted as elimination of point jitter.
- Forward-day covariate screen, 103 held-out visits: lap duration reduces stand MAE from 187.2 to 119.1 seconds; adding spacing does not improve average error. No spacing coefficients promoted.

Validation: backend/frontend typechecks and frontend build pass; 2,605 tests pass across the full suite and targeted reruns after corrections. Recorded-data phone checks cover 320px layout, Enter, Escape/focus restoration, close button, backdrop dismissal and expanded-trip access. This branch is not deployed.

[Preview](https://github.com/grtwrn/yale-shuttle/blob/fix/red-eta-stability-2026-09-16/pr-preview/red-eta-2026-09-16/README.md) · [Detailed measurements, caveats and reproduction](https://github.com/grtwrn/yale-shuttle/blob/fix/red-eta-stability-2026-09-16/docs/red-eta-2026-09-16.md)
