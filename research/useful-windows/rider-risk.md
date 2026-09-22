# Fixed-visit reminder risk proxy

Run only on a hosted runner:

```sh
python3 research/useful-windows/rider_risk.py --self-test
python3 research/useful-windows/rider_risk.py PATH_TO_INPUT_DIRECTORY
```

Inputs are `forecasts.jsonl.gz` and `raw_positions.jsonl.gz`. Forecast rows carry
the existing replay fields, exact `deployed` and `candidates` prediction objects,
and `label.{id,arrival,departure,outcome}`. The old logged `baseline` is retained
by the upstream experiment but does not drive this comparison. Predictions are
seconds; all timestamps and observed labels are milliseconds.

One hypothetical rider is armed per route/bus/pickup/physical-visit identity, at
the first observed deployed point ETA between 5 and 20 minutes while the bus has
not arrived. Every candidate uses that same arming instant. Simulated walks are
1, 3, 5 and 10 minutes, with immediate response and a separate 30-second response
sensitivity. Each point policy uses `eta - walk - 30 seconds`, matching the
current leave-now reminder; each hypothetical lower-bound policy substitutes
`low`. Per-second checks age the latest observation, and an observed replacement
takes effect at its timestamp. Lower-bound reminders are an experiment, not
current application behavior.

GPS must bracket arming through the **observed departure**, without route or
provider identity changes, gaps over 60 seconds or speeds over 22 m/s. Exact
duplicate fixes are deduplicated; contradictory simultaneous fixes break the
interval. Departure must be resolved. It is never invented as arrival plus a
nominal dwell. Causal prediction snapshots must continue until the reminder
decision or latest timely leave instant, with no more than 30 seconds between
usable observations. Loss of guidance before the decision is censored. A
completed decision remains valid if predictions later stop. This intentionally
admits a small cohort rather than extrapolating a stale forecast through gaps.

Riders who could not reach the stop even if they left immediately at arming are
reported as `already-too-late-at-arm`. Among initially catchable riders, a
reminder that has not fired by `departure - walk - response` is an avoidable
hypothetical boarding miss. Actual triggering records include hypothetical time
at the stop, lateness versus **arrival** and waiting time until arrival. Early
arrival below the forecast's initial lower bound is reported separately from
missing departure. The input arrival/departure labels are GPS-derived proxies,
not door-opening observations; passed and stopped visits have separate cells.

Outputs include a summary, every action record and every visit's inclusion or
exclusion reason. Paired results compare each candidate/policy with the deployed
point reminder on the **same scored visits**. They include newly introduced
misses and rescues. Censoring and late-at-arming counts remain visible. Wait
averages omit unknown reach times for never-timely reminders and must be read
alongside missed-boarding counts. No confidence or promotion claim is made here.

This is **not a full app journey simulation or observed rider missed-shuttle
rate**. Archive rows do not preserve the client's pinned/boardable bus selection,
notification delivery, background browser throttling, rider movement or door
state. The bus and stop occurrence are fixed, and no later bus substitutes for
the tested one. Current stop-alert lead notifications and rendered range
rounding are not simulated. Raw lower-bound tail risk is reported even when the
UI would suppress the range and print only a point. The existing 30-second
safety margin and these response assumptions do not establish real walk-time
coverage.
