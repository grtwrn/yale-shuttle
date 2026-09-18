# Service-role component screen

Inspected development data only. Original-cohort overall weights give each visit total weight one; restricted groups retain original landmark weights. Early means departure before lower bound; late means after upper bound. Seconds throughout. These are known-continuing-rest component forecasts, not served rider ETAs.

| Stop | Contract | Arm | Visits / checkpoints | MAE | p90 | WIS80 | Width | Early | Late |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 11 | confirmed120 | landmark_lap_elapsed_clock | 99 / 352 | 74.18 | 160.58 | 46.77 | 309.31 | 2.0% | 7.2% |
| 11 | confirmed120 | plus_two_history_phase | 99 / 352 | 73.75 | 160.11 | 46.23 | 301.38 | 2.0% | 8.6% |
| 11 | confirmed120 | plus_recursive_role | 99 / 352 | 74.10 | 160.38 | 46.33 | 299.45 | 2.0% | 9.5% |
| 11 | confirmed120 | current_code_component | 99 / 352 | 71.72 | 136.36 | 44.52 | 297.38 | 6.1% | 1.0% |
| 11 | confirmed240 | landmark_lap_elapsed_clock | 99 / 352 | 74.18 | 160.58 | 46.77 | 309.31 | 2.0% | 7.2% |
| 11 | confirmed240 | plus_two_history_phase | 99 / 352 | 73.75 | 160.11 | 46.23 | 301.38 | 2.0% | 8.6% |
| 11 | confirmed240 | plus_recursive_role | 99 / 352 | 74.10 | 160.38 | 46.33 | 299.45 | 2.0% | 9.5% |
| 11 | confirmed240 | current_code_component | 99 / 352 | 71.72 | 136.36 | 44.52 | 297.38 | 6.1% | 1.0% |
| 121 | confirmed120 | landmark_lap_elapsed_clock | 103 / 370 | 103.37 | 279.78 | 65.24 | 329.33 | 14.0% | 4.8% |
| 121 | confirmed120 | plus_two_history_phase | 103 / 370 | 101.82 | 282.40 | 64.22 | 323.01 | 13.5% | 5.0% |
| 121 | confirmed120 | plus_recursive_role | 103 / 370 | 101.74 | 282.21 | 64.12 | 322.49 | 13.5% | 5.0% |
| 121 | confirmed120 | current_code_component | 103 / 370 | 135.30 | 313.28 | 77.86 | 359.32 | 11.5% | 13.0% |
| 121 | confirmed240 | landmark_lap_elapsed_clock | 103 / 370 | 103.37 | 279.78 | 65.24 | 329.33 | 14.0% | 4.8% |
| 121 | confirmed240 | plus_two_history_phase | 103 / 370 | 101.82 | 282.40 | 64.22 | 323.01 | 13.5% | 5.0% |
| 121 | confirmed240 | plus_recursive_role | 103 / 370 | 101.74 | 282.21 | 64.12 | 322.49 | 13.5% | 5.0% |
| 121 | confirmed240 | current_code_component | 103 / 370 | 135.30 | 313.28 | 77.86 | 359.32 | 11.5% | 13.0% |

Date, elapsed, support/history and identity-stratum results with both weightings: scores.json. Every paired visit is retained in paired-visits.json. Continuation is a conditional component diagnostic only; no real movement, pin receipt or two-occurrence rider replay is claimed.
