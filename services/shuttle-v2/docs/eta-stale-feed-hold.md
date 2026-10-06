# Stale-feed far-side holds: reproduced, narrow guard rejected

Incident: `unionholdstale20261005`. Baseline: `ada033a94444`.
This proposal corrects an evidence comment and records a rejected experiment.
**It does not fix countdown behavior or change the estimator.**

## Reproduction and the source-comment overclaim

The far-side hold added in [#374](https://github.com/grtwrn/yale-shuttle/pull/374)
can accept a stale last-stop reading when a bus is far off both legs. Geometric
closing from the last top-leg fix does not establish an imminent arrival or
service at the next curb. The original comment said that all seven held buses
then reached their stops, treating the holds as successful approaches; retained
traces show why that conclusion was too strong:

- **Blue Night #40, 2026-09-23 22:09:25–22:10:35Z:** 180 York is
  1.6–2.0 km away, yet the forecast is one stop/about 20 s. The raw trajectory
  first reaches within 75 m at 22:44:20Z, about 35 min later, with a later
  25 s same-fix pause at 9 m. Eventual proximity does not validate the earlier
  imminent approach.
- **Orange Day #53, 2026-09-25 17:07:59–17:08:24Z:** College/George is
  284–314 m away, with the bus on a parallel street; the forecast is one
  stop/9–27 s. Raw positions in 17:00–17:20Z remain at least 137 m from
  College/George and 250 m from College/Crown. This pass misses both curbs.
  Collector arrival rows are not service truth.
- **Red #309, 2026-09-25 20:06:30–20:06:45Z:** State St Station is
  873–967 m away, yet the forecast is about 90 s. Raw positions first reach
  within 75 m at 20:18:19Z, about 12 min later, followed by stationary near-stop
  fixes. Those observations support geographic proximity/halt, not proof that
  doors opened or passengers boarded.

Warm all-bus replay of the baseline reproduced all three. A focused replay
produced a different Orange Day lead at some polls; the full all-bus sequence
is authoritative for that episode. Retained recorded posterior snapshots also
reproduce the three distant holds without rerunning the archive.

## Rejected local-posterior guard

The tested candidate required `mass[lead] + mass[next] >= LEAD_SWITCH_MASS`
(the existing 0.8 threshold) in `shortOfNextStop`. It added no distance threshold
or belief state and retained the existing Purple and Orange East far-side
approaches. Recorded gate tests failed on baseline and passed with the guard.
The candidate's Node 22/case-sensitive typecheck, full NY/UTC tests, and local
browser staging passed. **Those candidate logs do not validate this restored
documentation-only tree; its checks are recorded separately.**

Nevertheless, **the candidate is not a safe, useful repair**. Removing a held
lead restores ordinary following, whose origin can also be wrong. It can move
false imminence to adjacent stops and introduce a wrong-lap forecast at the
original target. Red's 89–98 s becomes 3,630–3,657 s (about 61 min), while
raw positions reach the station vicinity 694–709 s later (about 12 min).
Blue Night and Orange Day can still show zero at far-away targets.

The completed paired replay covers 20 archive bundles (09-15–10-04), all
requested routes/stops, and 2,651,215 route/bus prediction-polls. There are
594 changed arrival rows over 24 route/bus prediction-polls. Against
`stop_visits`, **changed-row** mean absolute error is 1,058 → 1,116 s,
with 0 severe episodes fixed and 1 introduced. Changed-row route MAEs all
worsen: Blue Night 1,470 → 1,494 s, Orange Day 217 → 321 s,
Red 1,274 → 1,352 s. Severe means one arm's absolute error is ≤120 s and
the other's is >600 s. These are not whole-network MAEs, and archive bundles
do not establish uninterrupted 20-day service coverage.

The introduced severe episode at Temple/Grove is a geographic pass, not
confirmed boarding. Other regressions have near-stop stationary evidence,
especially Red State St; rejecting collector truth alone does not remove
that harm. Secondary collector scoring's one apparent severe fix is
Orange Day College/Crown, whose purported later arrival is 570 m from
the curb: it is not a verified service improvement.

Orange East and Purple output rows are unchanged. Orange East #49's
geographic station approach is 285–320 m off the next line (archive day
09-17; UTC approach on 09-18), so a blanket next-line distance cap would
discard it. Its closest fix is 12 m, but the moving pass does not prove
passenger service. The original Purple fixture and its narrow card/countdown
tests are unchanged.

Served replay covers 30,401 watcher polls/333,238 bus-polls, with the
whole wire unchanged. The changed-wire-only card replay walks zero cards;
it cannot establish general own-countdown consistency. Separately, the
inherited cross-arm card metric compares both arms with the proposal arm's
countdown. Baseline-to-proposal agreement is not baseline own-countdown
consistency; proposal-arm count/hop coherence does not establish curb-arrival
accuracy.

## Follow-up requirements and scope

Do not ship the rejected guard or claim that disabling this override repairs
detour origin. A behavioral repair needs evidence for the **ordinary forecast
consequence**, not merely a test that `shortOfNextStop` returns false.
Recorded-sequence checks must cover the original target, adjacent stops,
and valid far-side approaches. `stop_visits` and collector arrivals are
imperfect geographic proxies; opposite curbs and moving drive-bys require
raw trajectory checks. Frozen near-stop fixes cannot by themselves prove
boarding or rule out a frozen feed.

Possible further investigation includes more reliable off-route origin
evidence or an explicit uncertain-forecast treatment. The original experiment
was a narrow gate change; this continuation is comments/documentation only.
Those task limits are not a new Garrett-approval requirement for routine
investigation or otherwise authorized in-scope work under the lead's standing
guardrails. A future behavioral candidate needs fresh reproduction, regression
protection, tradeoff evaluation, and independent review; this proposal neither
implements nor authorizes such a change.

## Evidence retained

The incident handoff retains `REPRODUCTION.md`, `COMMANDS.md`,
`analysis/REPORT.md`, `analysis/POPULATION-AUDIT.md`, exact replay
commands/exits, recorded posterior snapshots, rejected patch/test/fixture,
20-day paired outputs, and raw-trajectory audits. `RECOVERY-TESTS.md` records
the restored documentation tree's checks and source-equivalence hashes.
Raw archives, watcher recordings, completed replays, and rejected copies
were preserved. None is evidence of passenger boarding by itself.
