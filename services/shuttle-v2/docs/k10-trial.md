# Red K=10 trial

Open `/?eta_model=k10` to opt in. The page shows **Red ETA trial** and a
**Use usual estimates** link. Other riders keep the existing forecast. Disable
the overlay globally with `SHUTTLE_K10_TRIAL=0`.

For this trial, the last major wait is 344 Winchester (Red index 14). The
checkpoint is **Chapel / Church**, ten stops before it (index 4). Supported
pickups are indices 15–28, Winchester / Division through Amistad / Church St
South, on this lap. The prior stays fixed across those pickups; it does not
slide forward as the bus moves. Before index 8, on other routes, for another
lap, or without a complete live checkpoint, the usual estimate is used.

The estimate is the clock-time-weighted **mean completed checkpoint-to-pickup
duration minus actual elapsed time since checkpoint departure**. Bounds are
weighted p10/p90, expanded to contain the mean. The server also transports the
matching 50 quantiles; route position, standing state and drive-only metadata
continue to come from the shared live estimator. Support requires at least 12
effective paths across at least three materially weighted dates.

The handoff copies the entire usual forecast and its distribution after a
confirmed Winchester departure or a causal drive/downstream phase. A GPS shuffle
or the nearest-stop label moving ahead while the visit still says waiting does
not trigger it. The usual estimator continues to run on every collector poll,
so it is warm when selected; it accounts for live GPS progress and waiting,
rather than simply averaging from a stop label.

If the earlier countdown falls to 60 seconds while upstream, use the full
usual forecast. This prevents it reaching the UI's 15-second “now” threshold
during a 45-second snapshot lifetime. This is a fallback, not a claim that the
bus must arrive within one minute. Source clocks clear on a gap over 60 seconds,
route change, new lap or restart; the trial requires ten minutes of continuous
observations and a newly observed source departure. Unknown or stale evidence,
route-order changes and insufficient history also select the usual forecast.

The historical prior is deliberately frozen for this bounded trial. It contains
only public fleet durations from eight weekdays before September 16, 2026.
Generation uses strict connected visit/leg paths or independently verified raw
GPS continuity. Paths longer than 45 minutes are censored. It expires at
**September 28, 2026 00:00 America/New_York** and then falls back automatically;
renewing or broadening the trial requires evaluating a refreshed prior.

## Evidence and limitations

Research source: `research/earlier-checkpoint-2026-09-21`, export commit
`9739210`, [hosted validation](https://github.com/grtwrn/yale-shuttle/actions/runs/35645600276).
The frozen causal replay artifact is from
[run 35642308886](https://github.com/grtwrn/yale-shuttle/actions/runs/35642308886).
No rider identifiers, positions or report images enter the model or fixtures.

The additional expiry-fallback test reused September 17, 18 and 21 research
dates. It is a post-selection sensitivity check, **not a fresh holdout**.
Each physical pickup visit gets equal score weight; snapshots and different
pickups on the same bus trip are correlated.

| Pickup cohort | Usual error / width / coverage | K10 with expiry fallback |
| --- | --- | --- |
| Division / Prospect, 36 visits | 1:56 / 10:04 / 93.8% | 2:00 / 6:44 / 84.1% |
| All 14 pickups, 89 visits | 1:52 / 10:30 / 95.5% | 1:41 / 7:04 / 88.9% |

The expiry fallback removed all 54 recorded K10 false-now snapshots (ETA at
most 15s with actual arrival over 120s away) in the paired 14-stop cohort.
This does not establish zero future failures. Narrower bands have lower
coverage, and long Canal waits remain sparsely represented. The live overlay
also requires the ring and causal tracker to agree on the same-lap occurrence;
disagreement falls back and can change the live mixture relative to research.

Tests compare the TypeScript prior against 7,425 Python reference forecasts
across 14 pickups, verify exact handoff/fallback rows and distributions, replay
the live collector clock against raw GPS/reference causal features, and exercise
the opt-in/rollback in a real browser. Heavy tests run on GitHub-hosted runners.

Trial readings use `trip-k10`, `ride-k10`, `card-k10` surfaces and a `-k10` build
suffix. They have independent dedup keys and are excluded from default accuracy
and the usual-versus-upstream comparison. Query these surfaces explicitly for
trial evaluation. `/api/buses?eta_model=k10` includes `server_eta.trial` with the
prior version, expiry and number of rows replaced in that forecast snapshot.
