# Brown clock factorial results

Hosted run[35687958726](https://github.com/grtwrn/yale-shuttle/actions/runs/35687958726)
passed atd46e882, after the full protocol was pinned ate2b19c3. Both original
leads remain research leads; none of these results authorizes promotion.
No September21 or later outcomes were scored and no production code changed.

## Identity, causality and support

The current45min/15s feature control matched all2,032 Brown generated rows.
All4,064 original-lead comparisons reproduced forecast/reason/evidence and
hybrid bounds. Eight actual future-prefix deletion checks passed, including
cutoffs in the extended source-age/freshness ranges. The common route/provider
reset guard introduced no original-control discrepancy. Original raw hashes,
prior forecast/label/score/action bytes, exact control handoffs and1,440 original
deployed/control action records were preserved. All1,280 candidate point-action
decisions matched deployed. Production rendering parity had1,440 arming and982
trigger checks with zero mismatches. Point changes, later lower bounds and
unsupported changes were all zero.

There are1,555 labeled rows/35 physical pickups and477 unlabeled generated rows.
The common union of rows changed by any of eight arms has611 rows/18 pickups on
September17–18 only; the original-two-lead union has511 rows/the same18 pickups.
Consequently original arms have different averages on the new common union
despite byte-identical forecasts. Do not compare those averages with an old
all-K/changed-only subset as if they described identical rows. September19–20
have no evaluated Brown support here, which is not evidence of absent service.

## Same eight-arm union

Reference raw mean width1105.87s; printed mean width1165.05s. Equal weight per
physical pickup, then equal weight per logged snapshot within that pickup.
Every cell has raw coverage99.185% and printed coverage99.481%, unchanged from
deployed. No late misses occur on this union; existing early tails are unchanged.

| Lead | Source horizon / freshness | Sources | Raw narrowing | Printed narrowing | Printed narrower / wider | Observed handoffs |
|---|---|---:|---:|---:|---:|---:|
| FrozenK8 | 45min / <=15s | 9 | 72.34s | 73.38s | 41.6% /7.4% | 9 |
| FrozenK8 | 45min / <45s | 9 | 72.53s | 73.55s | 41.7% /7.4% | 5 |
| FrozenK8 | 90min / <=15s | 10 | 71.00s | 72.25s | 47.0% /11.8% | 10 |
| FrozenK8 | 90min / <45s | 10 | 71.19s | 72.42s | 47.1% /11.8% | 6 |
| RollingK5 | 45min / <=15s | 13 | 81.36s | 83.16s | 51.8% /21.7% | 18 |
| RollingK5 | 45min / <45s | 13 | 81.28s | 83.07s | 51.9% /21.8% | 12 |
| RollingK5 | 90min / <=15s | 13 | 81.36s | 83.16s | 51.8% /21.7% | 18 |
| RollingK5 | 90min / <45s | 13 | 81.28s | 83.07s | 51.9% /21.8% | 12 |

These are modest mean gains with substantial inconsistency. All arms widen on
September17 and narrow on September18: frozenK8 ranges+44.5..+51.6s on the first
day and−166.0..−169.2s on the second; rollingK5 ranges+22.8..+23.2s and−164.7..
−164.8s. All-row improvement is only34.1..43.0s across35 pickups, with unchanged
93.022% coverage. The changed-union>=60s numerical gate does not establish a
route-wide>=60s gain. Fresh-date and handoff/occurrence gates remain unresolved.

## What each clock factor changes

Freshness<=15s→<45s changes only two labeled frozenK8 rows/two pickups and three
rollingK5 rows/three pickups. Those are the same THREE short GPS-delay episodes
previously audited. It eliminates all4 frozen and6 rolling freshness edges;
ordinary absolute bound movement is retained rather than replaced by a
fallback/recovery pair. Mean raw-width change is−0.19s for frozenK8 and+0.08s for
rollingK5 on the common union. No coverage/tail/paired action decision or waiting
change was measured. This is narrow evidence about three delays, not general
validation of stale tracking. The strict45s boundary, identity resets and
no-fabricated-progress rules remain essential.

Source45→90min changes no rollingK5 forecast. For frozenK8 it changes110 labeled
rows/five physical pickups/five source-target clusters:

| ET source departure | Source | Pickup | Changed rows | Changed interval |
|---|---|---|---:|---|
| Sep17 07:43:41.452 #126 | State St6 | Divinity47 | 8 | 08:28:45–08:30:30 |
| Sep17 08:33:55.516 #126 | State St6 | Humphrey/Whitney172 | 1 | 09:28:45 |
| Sep17 09:34:08.513 #126 | State St6 | Humphrey/Whitney172 | 4 | 10:20:00–10:23:15 |
| Sep17 11:01:52.958 #126 | Winchester/Sachem1 | Union121 | 53 | 11:47:00–12:00:00 |
| Sep18 09:34:02.251 #304 | State St6 | Divinity47 | 44 | 10:19:15–10:30:00 |

The longer source horizon widens frozenK8's mean interval1.34s on the common
union. Some cases narrow and others widen: the first Divinity case keeps an
upper bound447–486s later and a lower bound122–192s earlier than the45min cell.
The Union case has upper bounds9–327s earlier with unchanged lower bounds.
No outcome-based exclusions remove either behavior.

## Handoffs still matter

All retained matched transitions have continuous same-route/same-provider GPS
between snapshots and through the observed departure. That establishes causal
tracking continuity under the existing gap/speed rules, not that a large
estimator change corresponds to physical travel. Every transition preserves the
deployed point; jumps below are absolute clock changes after elapsed time.

With90min source lifetime, the three frozenK8 age-expiry edges disappear, but
the matched set includes two confirmed-departure and two group-expiry edges:

- Sep17 08:30:45, #126 Divinity: actual Union wait departure now explains the
  handoff, but the upper clock jumps−568s,−486s beyond deployed's update; lower
  jumps+134s,+149s beyond deployed. This moves the cliff to actual evidence; it
  does not make the interval coherent across that event.
- Sep17 09:29:00, #126 Humphrey/Whitney: while still holding at Union5, whole-group
  countdown expiry moves lower+486s (+472s beyond deployed) and upper+124s
  (+114s extra). There is no confirmed departure here.
- Sep17 12:00:15, #126 Union: another group expiry moves upper+342s.
- Sep18 10:30:15, #304 Divinity: confirmed Union departure moves lower+133s,
  upper−15s.

The frozenK8 phase4drive→6drive fallback and6drive→5hold reentry at Sep18
10:14:45/10:17:15 remain under every clock policy, using the same old source.
They have no retained completed wait departure proving a physical return;
neither factor fixes that occurrence ambiguity. RollingK5 retains five
progress-only releases, five newly known source entries, one confirmed wait
departure and one group expiry. Its largest remaining progress-release upper
jump is+253s actual/+266s extra at Sep18 10:14:45.

Excluded transitions remain explicit. Frozen45min cells exclude8 unlabeled,
1 snapshot gap and6 different pickups; frozen90min cells exclude8 unlabeled
and7 different pickups. Rolling cells exclude3 unlabeled,1 gap and9 different
pickups. Handoff counts are therefore not interchangeable denominators.

## Rider waiting and censoring

All tested walks1/3/5/10min, both response delays0/30s and all three reminder
policies have zero additional paired hypothetical misses or later reminders.
Point timing is exactly unchanged by construction. No actual rider misses or
rescues are claimed. Twenty physical visits qualify for common arming; at
3min rendered guidance only13 have common usable outcomes, with7 deployed
actions censored. At1/5/10min the common counts are10/14/16; the10min cohort also
has3 already-too-late-at-arm visits and1 censored visit.

For3min rendered reminders, frozenK8 adds mean0.85s waiting (maximum11s) and
rollingK5 adds0s, under every clock cell. Freshness alone changes no common
action waiting in any fixed policy/walk/response cell.

The source90 effect is larger at a10min walk. FrozenK8's mean added waiting
versus deployed rises from1.56s to15.69s across16 common rendered pairs. The
maximum is226s: #304/Divinity on Sep18 leaves at10:25:42 instead of10:29:28,
waiting489.155s instead of263.155s. This extra3m46s is a rider cost despite no
added missed-boarding proxy. Another Humphrey pickup changes from censored to
immediately triggered at09:28:45 for1/3/5min walks, leading to598.52/478.52/
358.52s waiting; those are outside the corresponding common pairs and cannot
be called rescues. RollingK5 adds mean0.31s waiting at10min (maximum5s).

## Constraints and prospective status

Zero introduced false-now/severe-early events and zero introduced point/low/high
ordering reversals were recorded (70 labeled adjacent pairs and129 generated
pairs). Printed bands are available throughout scored aging sensitivities;
rounding does not change the result's direction. None of this resolves two-date
sampling, wide/inconsistent intervals, group countdown expiry or the K8 source
ambiguity. Requiring30 changed-scope pickups,12 source journeys and3 unopened
dates remains material; there are only18 pickups/two development dates, and
frozenK8 has9–10 sources.

Retain both original Brown leads and all eight diagnostic cells. The freshness
factor is a bounded stability lead for further validation;90min source lifetime
has mixed effects and is not an automatic improvement. Do not select a winner
from these data or silently fold either factor into prospective validation.
The prospective reference protocol remains fixed and unopened; any additional
clock or occurrence experiment must be separately pinned before new outcomes.
Record-level evidence and all cohort variants are in the hosted artifact.
