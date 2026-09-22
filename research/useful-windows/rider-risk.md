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
sensitivity. The three policies share the existing 30-second walking buffer:

- `point` uses `eta - walk - 30 seconds`, matching the current leave-now reminder.
- `lower` substitutes the raw `low` bound, without display rounding.
- `rendered_lower` uses the earliest minute printed by the primary pickup
  window, reformatting the aged bounds on every one-second reminder tick.
  A low endpoint below one minute prints `<1`, whose earliest possible time is
  now. Other low endpoints are floored to minutes. All valid narrow and wide
  windows qualify. Missing, nonfinite, reversed or expired windows fall back to
  the aged point countdown, preserving point-only behavior.

An observed replacement takes effect at its timestamp. Raw-bound and rendered
reminders are experiments, not current application behavior. Both `point` and
`rendered_lower` require a valid point ETA but can handle missing bounds; `lower`
requires a valid bounded forecast. Their different support remains visible.

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
misses and rescues. `pairedRenderedAgainstRawLower` separately compares display
rounding against the raw-bound policy for the same forecast arm. Its paired
cohort and both policies' statuses are explicit; earlier reminders may remain
judgeable on visits that become censored before the raw-bound decision. Reminder
timing and added waiting are compared only when both policies emitted a timely
reminder. Censoring and late-at-arming counts remain visible. Wait
averages omit unknown reach times for never-timely reminders and must be read
alongside missed-boarding counts. No confidence or promotion claim is made here.

This is **not a full app journey simulation or observed rider missed-shuttle
rate**. Archive rows do not preserve the client's pinned/boardable bus selection,
notification delivery, background browser throttling, rider movement or door
state. The bus and stop occurrence are fixed, and no later bus substitutes for
the tested one. Current stop-alert lead notifications are not simulated. The
primary pickup table uses
`web/src/ArrivalDetails.tsx` and `web/src/arrivalDetails.ts:predictionWindow`:
it displays all valid widths, floors the lower minute and ceils the upper
minute. The older stop-row/chip path through `etaBand.displayBand` instead hides
ranges narrower than 3 or wider than 15 printed minutes. Those legacy display
limits do not describe the primary pickup table. Only `rendered_lower` follows
the primary table's rounding; `lower` remains the raw-bound comparison. No
already-at-pickup override is simulated because all arms start before arrival
and their bus/visit stays fixed. The existing 30-second safety margin and these
response assumptions do not establish real walk-time coverage. The hosted
self-test covers rounding transitions, bounds aging, narrow/wide and subminute
windows, point-only fallback, replacement timing, deadlines and missing data.
