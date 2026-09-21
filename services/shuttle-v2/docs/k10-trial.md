# Red K=10 trial

K10 is the **default for Red's tested section**. The page shows **Red ETA trial**
and a **Use previous estimates** link (`/?eta_model=usual`). **Use updated
estimates** returns to the default. The original `/?eta_model=k10` link still
selects K10. Disable the overlay globally with `SHUTTLE_K10_TRIAL=0`.
Blue and other routes retain their current estimator. K10 historical backtests
have covered Red only; ordinary application regression tests cover other routes.

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

If any downstream countdown falls to 60 seconds while upstream, use the full
usual forecast for the **whole downstream group**. Likewise, every pickup in
the group must have sufficient historical support. A pickup-specific fallback
could make a later stop appear to arrive before an earlier stop. The shared
guard prevents both that mixed-model boundary and reaching the UI's 15-second
“now” threshold during a 45-second snapshot lifetime. This is a fallback, not
a claim that the bus must arrive within one minute. Source clocks clear on a gap over 60 seconds,
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
`01a1979`, [hosted validation](https://github.com/grtwrn/yale-shuttle/actions/runs/35647393979).
The frozen causal replay artifact is from
[run 35642308886](https://github.com/grtwrn/yale-shuttle/actions/runs/35642308886).
No rider identifiers, positions or report images enter the model or fixtures.

The additional expiry-fallback test reused September 17, 18 and 21 research
dates. It is a post-selection sensitivity check, **not a fresh holdout**.
Each physical pickup visit gets equal score weight; snapshots and different
pickups on the same bus trip are correlated.

| Pickup cohort | Usual error / width / coverage | K10 with expiry fallback |
| --- | --- | --- |
| Division / Prospect, 36 visits | 1:56 / 10:04 / 93.8% | 1:58 / 6:49 / 84.7% |
| All 14 pickups, 89 visits | 1:52 / 10:30 / 95.5% | 1:48 / 7:07 / 88.4% |

The expiry fallback removed all 54 recorded K10 false-now snapshots (ETA at
most 15s with actual arrival over 120s away) in the paired 14-stop cohort.
The shared guard also removed three pickup-order reversals introduced by the
pickup-specific expiry guard: zero reversals over 30 seconds in 189 paired
adjacent-stop readings, matching the usual estimator in that subset.
This does not establish zero future failures. Narrower bands have lower
coverage, and long Canal waits remain sparsely represented. The live overlay
also requires the ring and causal tracker to agree on the same-lap occurrence;
disagreement falls back and can change the live mixture relative to research.

Tests compare the TypeScript prior against 7,425 Python reference forecasts
across 14 pickups, verify exact handoff/fallback rows and distributions, replay
the live collector clock against raw GPS/reference causal features, and exercise
the default/opt-out/restore flow in a real browser. Heavy tests run on GitHub-hosted runners.

New default readings use ordinary `trip`, `ride`, `card` surfaces and count in
default accuracy. Explicit Red opt-outs use `trip-usual`, `ride-usual`,
`card-usual` and a `-usual` build suffix; other routes keep ordinary surfaces
even on an opt-out page. These comparison rows and the earlier opt-in
`*-k10` readings have independent dedup keys and stay excluded from default
accuracy and the usual-versus-upstream comparison. Query comparison surfaces
explicitly when evaluating the trial. Default `/api/buses` includes
`server_eta.trial` with the prior version, expiry and count of replaced rows;
`/api/buses?eta_model=usual` returns the previous estimator without that marker.
