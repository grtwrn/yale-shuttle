# Frozen landmark remaining-wait screen

All development dates were previously inspected. This is a conditional true-rest component comparison, not a full rider ETA replay. Quantities are seconds; early means the bus departed before the lower predicted remaining-wait bound.

## Visit-weighted primary totals

| Stop | Contract | Arm | Visits/checkpoints | MAE | p90 abs | WIS80 | Width80 | Early | Late |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 11 | arrival15 | landmark_lap_elapsed_clock | 99/352 | 74.2 | 160.6 | 46.8 | 309.3 | 2.0% | 7.2% |
| 11 | arrival15 | plus_ahead_snapshot | 99/352 | 70.6 | 131.5 | 43.9 | 279.8 | 3.6% | 5.6% |
| 11 | arrival15 | plus_ahead_follower_snapshot | 99/352 | 71.2 | 126.3 | 44.0 | 265.3 | 3.6% | 10.1% |
| 11 | arrival15 | current_code_component | 99/352 | 71.7 | 136.4 | 44.5 | 297.4 | 6.1% | 1.0% |
| 11 | completed120 | landmark_lap_elapsed_clock | 99/352 | 74.2 | 160.6 | 46.8 | 309.3 | 2.0% | 7.2% |
| 11 | completed120 | plus_ahead_snapshot | 99/352 | 71.4 | 134.6 | 44.0 | 276.9 | 4.1% | 6.1% |
| 11 | completed120 | plus_ahead_follower_snapshot | 99/352 | 70.9 | 130.1 | 43.3 | 264.4 | 3.6% | 9.4% |
| 11 | completed120 | current_code_component | 99/352 | 71.7 | 136.4 | 44.5 | 297.4 | 6.1% | 1.0% |
| 121 | arrival15 | landmark_lap_elapsed_clock | 103/370 | 103.4 | 279.8 | 65.2 | 329.3 | 14.0% | 4.8% |
| 121 | arrival15 | plus_ahead_snapshot | 103/370 | 98.9 | 280.0 | 67.0 | 279.5 | 16.4% | 5.4% |
| 121 | arrival15 | plus_ahead_follower_snapshot | 103/370 | 100.2 | 273.6 | 65.5 | 280.6 | 15.6% | 7.3% |
| 121 | arrival15 | current_code_component | 103/370 | 135.3 | 313.3 | 77.9 | 359.3 | 11.5% | 13.0% |
| 121 | completed120 | landmark_lap_elapsed_clock | 103/370 | 103.4 | 279.8 | 65.2 | 329.3 | 14.0% | 4.8% |
| 121 | completed120 | plus_ahead_snapshot | 103/370 | 99.3 | 278.5 | 67.2 | 282.1 | 16.4% | 5.6% |
| 121 | completed120 | plus_ahead_follower_snapshot | 103/370 | 99.1 | 268.9 | 65.2 | 279.2 | 16.4% | 8.2% |
| 121 | completed120 | current_code_component | 103/370 | 135.3 | 313.3 | 77.9 | 359.3 | 11.5% | 13.0% |

## Primary contract by date

| Stop | Date | Arm | Visits/checkpoints | MAE | WIS80 | Early | Late |
|---|---|---|---:|---:|---:|---:|---:|
| 11 | 2026-09-14 | landmark_lap_elapsed_clock | 28/105 | 93.8 | 58.0 | 3.4% | 9.8% |
| 11 | 2026-09-15 | landmark_lap_elapsed_clock | 21/76 | 68.4 | 42.3 | 2.5% | 1.0% |
| 11 | 2026-09-16 | landmark_lap_elapsed_clock | 33/105 | 59.9 | 39.3 | 1.0% | 5.8% |
| 11 | 2026-09-17 | landmark_lap_elapsed_clock | 17/66 | 76.8 | 48.1 | 1.2% | 13.5% |
| 11 | 2026-09-14 | plus_ahead_snapshot | 28/105 | 89.8 | 54.6 | 3.4% | 6.9% |
| 11 | 2026-09-15 | plus_ahead_snapshot | 21/76 | 62.0 | 40.0 | 4.9% | 3.3% |
| 11 | 2026-09-16 | plus_ahead_snapshot | 33/105 | 63.7 | 38.9 | 2.8% | 4.5% |
| 11 | 2026-09-17 | plus_ahead_snapshot | 17/66 | 63.1 | 40.6 | 4.1% | 8.2% |
| 11 | 2026-09-14 | plus_ahead_follower_snapshot | 28/105 | 88.9 | 53.8 | 5.0% | 10.5% |
| 11 | 2026-09-15 | plus_ahead_follower_snapshot | 21/76 | 62.4 | 39.6 | 2.5% | 4.9% |
| 11 | 2026-09-16 | plus_ahead_follower_snapshot | 33/105 | 64.2 | 39.5 | 2.8% | 11.2% |
| 11 | 2026-09-17 | plus_ahead_follower_snapshot | 17/66 | 66.5 | 42.2 | 4.1% | 13.8% |
| 11 | 2026-09-14 | current_code_component | 28/105 | 96.4 | 56.8 | 9.6% | 0.0% |
| 11 | 2026-09-15 | current_code_component | 21/76 | 58.2 | 36.9 | 4.9% | 1.0% |
| 11 | 2026-09-16 | current_code_component | 33/105 | 59.9 | 38.7 | 3.4% | 0.0% |
| 11 | 2026-09-17 | current_code_component | 17/66 | 70.7 | 44.8 | 7.1% | 4.7% |
| 121 | 2026-09-14 | landmark_lap_elapsed_clock | 29/112 | 122.3 | 81.8 | 13.8% | 8.8% |
| 121 | 2026-09-15 | landmark_lap_elapsed_clock | 23/84 | 78.3 | 51.9 | 9.2% | 1.7% |
| 121 | 2026-09-16 | landmark_lap_elapsed_clock | 33/114 | 96.6 | 59.5 | 16.2% | 4.2% |
| 121 | 2026-09-17 | landmark_lap_elapsed_clock | 18/60 | 117.4 | 66.1 | 16.4% | 3.3% |
| 121 | 2026-09-14 | plus_ahead_snapshot | 29/112 | 113.7 | 83.6 | 13.8% | 8.8% |
| 121 | 2026-09-15 | plus_ahead_snapshot | 23/84 | 75.5 | 52.3 | 13.6% | 1.7% |
| 121 | 2026-09-16 | plus_ahead_snapshot | 33/114 | 96.4 | 66.2 | 20.8% | 4.8% |
| 121 | 2026-09-17 | plus_ahead_snapshot | 18/60 | 109.6 | 60.6 | 16.4% | 5.6% |
| 121 | 2026-09-14 | plus_ahead_follower_snapshot | 29/112 | 114.4 | 81.6 | 13.8% | 9.5% |
| 121 | 2026-09-15 | plus_ahead_follower_snapshot | 23/84 | 81.6 | 55.2 | 9.2% | 1.7% |
| 121 | 2026-09-16 | plus_ahead_follower_snapshot | 33/114 | 96.5 | 62.0 | 21.8% | 10.4% |
| 121 | 2026-09-17 | plus_ahead_follower_snapshot | 18/60 | 107.9 | 58.9 | 15.3% | 5.6% |
| 121 | 2026-09-14 | current_code_component | 29/112 | 169.2 | 97.0 | 9.8% | 16.6% |
| 121 | 2026-09-15 | current_code_component | 23/84 | 122.8 | 68.4 | 11.4% | 7.0% |
| 121 | 2026-09-16 | current_code_component | 33/114 | 112.8 | 67.2 | 6.6% | 13.9% |
| 121 | 2026-09-17 | current_code_component | 18/60 | 137.9 | 78.6 | 23.3% | 13.1% |

All checkpoint-weighted scores, per-landmark, lap availability and follower-identity strata are in `scores.json`. All five worst visit-averaged regressions for each predeclared comparison/stop/contract are in `top-regressions.json`. No cases were deleted.

Production comparator scope: exact current Winchester release functions with preSep10 fit, plus current marginal/lap code with preSep14 tables for Union and unsupported Winchester. This deliberately freezes historical calibration; it does not reproduce the current six-hour refit schedule, live belief mixtures, 30s absolute-arrival pooling, endpoints, repeated occurrences or ranking. Full rider validation remains mandatory before promotion.
