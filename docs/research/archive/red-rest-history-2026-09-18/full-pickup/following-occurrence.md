# Following-occurrence audit

The history candidate produces little aggregate change to the following arrival. Individual regressions remain and are retained; this small, incomplete sample does not establish noninferiority.

Scored 321 fixed landmarks from 42 Winchester holds and 83 following target visits. 85/162 source-target paths had two explicitly observed, exactly connected target visits.

| Scope | Arm | Rows | MAE (s) | Width (s) | WIS diagnostic | Early / late |
|---|---|---:|---:|---:|---:|---:|
| All landmarks | core | 321 | 165.8 | 1044.2 | 127.6 | 6 / 10 |
| All landmarks | union | 321 | 165.3 | 1041.5 | 127.3 | 6 / 10 |
| All landmarks | history | 321 | 165.4 | 1041.8 | 127.3 | 6 / 10 |
| Changed landmarks | core | 216 | 154.3 | 973.5 | 117.9 | 6 / 0 |
| Changed landmarks | union | 216 | 153.6 | 969.5 | 117.3 | 6 / 0 |
| Changed landmarks | history | 216 | 153.7 | 970.0 | 117.4 | 6 / 0 |

All three arms use the same frozen travel/dwell tables, actual runtime lap support and forecasts. The following target is labelled only after tracing the first target and another full route loop through exact same-bus leg/visit identities. Missing paths remain unknown or censored; neither skipped stops nor missing observations are interpolated.

Coverage: 18 censored and 59 unknown paths; 18 eligible landmarks lacked a warm paired following forecast. 0 scored holds were absent from the frozen history lookup. Only 216 scored rows from 36 holds changed versus core.

Worst history median-error regression versus core: +29.9s at source visit67062, target48, elapsed180s; 0 raised-lower rows had an actual arrival before the history lower bound.
Worst history median-error regression versus union: +21.4s at source visit67062, target48, elapsed180s; 0 raised-lower rows had an actual arrival before the history lower bound.

The five-hold later extension contributes only 22 landmarks from 2 source holds. Other extension paths are unknown or censored; this is not a new independent day.

Measurement review retained the largest regressions: the top three distinct source holds have exact connected leg/visit paths with no gap completions. Future observed Union/Winchester waits account for genuine variation; they were used only as retrospective labels. Visit65237's audited invalid pin is explicitly excluded from landmark clocks, while its valid departure remains available to connect other paths.

Per-date, per-target, every fixed landmark, equal-journey weighting, exact path IDs, retained failures, and worst regressions are in following-occurrence.json. Repeated checkpoints are dependent. Final intervals are not asserted calibrated probabilities, and GPS arrival labels are not door-open ground truth. Completed-cohort matching is an offline intervention, not a demonstration of production feature availability.
