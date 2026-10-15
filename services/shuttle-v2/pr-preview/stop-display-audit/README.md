# Stop-display audit, October 15, 2026

Report 142 exposed disagreement between a confirmed Winchester stand and a
held display anchor. The Red fix is already deployed in d18a65cfa729. This
audit found the related physical-stop-row error on Green and Purple, where
the earlier fix had deliberately preserved the outbound/return occurrence.

The overview's list contains each physical stop once, so a confirmed stand can
place its badge correctly without choosing the pass. Internal canonical/travel
indices remain unchanged for their pass-specific pickup and get-off counts.
The overview's NEXT badge also used that de-duplicated row order: Purple
returning from Building 600 showed Building 400 as NEXT beside its next-lap
forecast, although Building 750 was the next call. Folded lines now take NEXT
from that bus's forecast call order, excluding the current physical stop;
simple loops retain their published next stop.
The two new recorded Green/Purple tests fail on the previous release and pass
with this change. Their moving, distant, approach and expired cases preserve
the old safeguards.

## Evidence

The sampled public input journals cover 07:00–13:51 ET on October 15 (412
minute snapshots, 7,360 bus observations). Under the previous release's code,
96 snapshot/bus combinations placed a confirmed stopped Green/Purple bus on a
different physical row. After the change, all 2,984 eligible stand-position
checks pass. All 60,431 pickup and 60,431 exit count checks on lines with no
repeated calls also pass, along with 2,349 NEXT checks on those lines.
Folded-line counts are explicitly excluded from this
physical-only count oracle (635 stand observations); existing recorded
Green/Purple pass-specific suites remain the direction checks.

- [Previous-release replay](recorded-before.json)
- [Fixed replay](recorded-after.json)
- [Actual SPA results](results.json): Green/Purple, 307px Android, 390px phone,
  1280px desktop; badge and pause chip on the confirmed stop, correct NEXT call,
  no horizontal overflow
- [Green, Building 800](green-390.png)
- [Purple, Building 600](purple-390.png)

Full local verification: 3,807 tests in 196 files, backend/web/auditor types,
production frontend build, the six Green/Purple browser cases, and the three
existing Red Winchester browser cases. Recorded data are public bus feeds,
with no reporter context, browser identifier or rider location. No ETA model,
training data, arrival-observation threshold or promotion gate changes.

## Why the existing watchers missed report 142

At 08:43 ET the fixed Red rider was already aboard #119, while the random
rider was watching Gold #123. Neither displayed #317's pickup details. The
runner checked boarding/arrival/feed health and a narrow alert contradiction;
it had no independent assertion relating a waiting-screen stop count to a
confirmed curb stand. The closed-loop learner measures forecast outcomes,
not stop-list rendering. The submitted-report watcher was installed later
that day: its first recorded check at 13:45 ET queued report 142 successfully.
That watcher discovers feedback after submission, not defects before submission.

The retained UI samples also lacked the served stand records. A raw `at_stop_id`
is a zone flag and can name a stop while the bus approaches, so treating every
raw zone/count disagreement as a confirmed defect would produce false alarms.
The new screen check requires model + GPS agreement at the curb and distinct
fresh observations; those lightweight served stand records are now retained.

The new per-minute all-line observer evaluates the actual production-version
display calculators independently of whichever bus the two riders happen to
follow. It persists confirmed incidents, bounds its storage and notifies locally;
three failed checks also generate a notification. See
[observer operation and limits](../../scripts/display-audit/README.md).

The latest pre-existing guardian incident (Blue #40, 12:42 ET timeout) was also
reviewed. The retained simulated ride never observed that bus within 135.7 m
of College/George; the app showed its passed-stop warning and the watcher
correctly queued a failed journey. The published upstream coordinate matches
the app. Those data do not establish curb service, a wrong stop coordinate,
or an estimator defect; the incident remains available for review and was not
converted into a successful arrival or used to loosen scoring thresholds.
