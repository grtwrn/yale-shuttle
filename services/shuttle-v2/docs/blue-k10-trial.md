# Blue Day and Blue West K10 default

Blue Day and Blue West join Red's bounded default trial. Riders automatically
receive the current estimates without a model-version banner or chooser.
Blue Night and Blue Weekend retain their existing forecasts because neither
had enough qualifying historical support. `SHUTTLE_BLUE_K10=0` disables only the
Blue overlay; `SHUTTLE_K10_TRIAL=0` disables the entire trial.

Both Blue lines use Cedar Street as their major wait stop. The source is ten
stops before Cedar in the circular route order: Whitney / Edwards (southbound)
on Blue Day, and Howard / Park on Blue West. The target group includes every
subsequent stop through the remainder of that loop, excluding Cedar itself.
This is the broad group tested in research, not the first-ten-pickups variant.
The live route anchor and causal GPS tracker must agree on the source, wait
and upcoming target occurrences; a later-lap arrival cannot inherit the prior.

The mean and p10/p90 durations use the frozen independent Python fit. They are
weighted by departure clock time (circular 24-hour Gaussian, 120-minute scale),
with separate weekday/weekend paths. Each target needs at least 12 effective
paths on at least three dates contributing 5% or more of total weight. All
targets in a group must qualify. The 50 matching quantiles travel with the ETA.
Only completed training journeys before September 16 enter the fit. Blue's
historical path cap is 90 minutes; the live source clock still expires after
45 minutes. Keeping those distinct avoids censoring longer Blue training laps.

The isolated GPS tracker can recover ten-minute continuous warmup and a confirmed
source departure from up to one preceding hour of recorded GPS. Route changes,
ambiguous names and gaps longer than 60 seconds sever the clock. Evidence must
be at most 15 seconds old. A confirmed Cedar exit or observed drive/downstream
phase switches back to the entire current live forecast and its distribution.
A nearest-stop GPS shuffle during a confirmed wait does not switch it. A
latched departure prevents an old short-loop origin from becoming active again.
If any target countdown reaches 60 seconds, the whole group returns to live.

The prior expires September 28, 2026 at 00:00 America/New_York, like Red's.
Renewal requires evaluating a refreshed prior. Rider readings count in normal
accuracy. Legacy comparison page URLs now request current estimates too. API trial metadata
adds per-route replacement counts under `server_eta.trial.byRoute`.

## Qualification and limits

[Frozen research report](https://github.com/grtwrn/yale-shuttle/blob/63ff1ff/research/blue-k10/REPORT.md),
[corrected final replay](https://github.com/grtwrn/yale-shuttle/actions/runs/35653327666),
[model and independent forecast export](https://github.com/grtwrn/yale-shuttle/actions/runs/35654869160).
The deployment uses exactly the exported fit, not retrained or extended data.
Fixtures contain public fleet information only, with no rider identifiers or
report images. September 17–20 evaluation reused dates from earlier research,
so this is not a fresh global holdout. Counts of stops on a trip are correlated.

| Replaced forecasts, weighted by target visit | Usual MAE / width / coverage | K10 |
| --- | --- | --- |
| Blue Day: 30 visits, 21 source trips, 2 dates | 3:35 / 14:49 / 88.6% | 2:55 / 11:26 / 86.7% |
| Blue West: 22 visits, 12 source trips, 4 dates | 3:19 / 27:17 / 99.4% | 1:33 / 5:38 / 90.9% |

The tested subset had no added false-now readings and no adjacent-stop reversal
over 30 seconds in 1,222 pairs. Thirteen observed departure handoffs had a
maximum countdown-adjusted jump of 129 seconds; group-expiry fallback jumps
reached 327 seconds. This rollout preserves those tested transitions and does
not claim to smooth away the difference between the two estimates.

Hosted checks compare every exported Blue forecast/fallback decision, replay raw
GPS through the production tracker and startup recovery, and repeat Red's GPS
replay to catch changes to its behavior. Regular gates cover types, the full
application suite, build, staging API and a real-browser check that current estimates are used even on legacy URLs.

The production replay matched 8,335 available Blue clocks (4,899 before release,
3,436 released), all 413 sampled restarts, and all 2,100 replacement forecasts
(1,329 Day, 771 West). It introduced no extra fallback in the qualified cohort.
The broader count includes the reserved September 16 diagnostics and is an
implementation-parity result, not additional independent accuracy evidence.
Red's repeated replay matched 5,232 clocks and all 150 sampled restarts.
