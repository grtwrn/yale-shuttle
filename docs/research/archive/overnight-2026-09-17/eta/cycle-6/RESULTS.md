# Remaining missing-board journeys: diagnosis and bounded prototype

**Research only; application source and HEAD unchanged.** The 68 remaining
unavailable journeys are fully accounted for. A temporary shell prototype
restores 30 using already-served pickup/destination rows. The other 38 need
different treatment; a blanket board-now or fallthrough rule is not supported.

Baseline is the independently approved pickup guard at
`b574a1c800654544685a8d9f1097ad3484ac13fc`, parent `6220b860`.
This report makes no deployment claim. Existing 40 selected Red sessions and
4,688 decisions are reused. There is no new holdout or model fit.

## What was missing

All 68 decisions enter the shell's raw-at-stop override, then fail its strict
`stopsAhead === 0 && eta === 0` join. They represent 34 bus-polls, ten source
visits, twenty sessions, and two destinations per poll. All have zero access
walking; all 2,344 decisions at the 150 m offset are unchanged by the prototype.

| Current served state | Decisions | Recorded timing |
| --- | ---: | --- |
| Pickup h1, 4–12 seconds ahead, before first destination | 30 | All before source departure |
| Only next-lap pickup h29, first destination already before it | 24 | Before source departure |
| Only next-lap pickup h29, first destination already before it | 14 | 5–15 seconds after source departure |

Every missing case's raw GPS coordinates, route and heading match read-only
SQLite. Connected destination paths, bus identity and route distance were
checked for all 68; post-departure rows remain explicitly unboardable under
their recorded source outcome. Recorded departure is retrospective labeling,
never a forecast input. Collector at-stop flags in this archive are reconstructed.

Native continuous replay observed all 34 states while exactly reproducing
1,172 complete saved wires / 160,496 rows across 11,081 input polls. Every
missing case's leading situation is moving. The first group is on the incoming
leg without established rest; the latter groups are on the outgoing leg.
`startChain` deliberately emits a zero pickup only with `standingAt >= 0`.
Retained rest metadata alone cannot establish board-now: it is still present
in twelve of the fourteen post-departure decisions. No new tracker repair is
established, and neither tracking nor the separate movement-cache issue changes.

## Frozen counterfactuals

`COUNTERFACTUAL_PLAN.json` froze two artifact-only arms after classification,
before their scores. Both use the existing live wire and actual shell arithmetic;
all stable board/alight plans stay fixed. The baseline reproduces all 4,688
saved options, traces and ranking states exactly after JSON serialization.

1. **Ordered pickup join:** in the existing raw-at-stop branch, keep its zero
   pickup when available. Otherwise, solely for the full-journey join, use an
   existing same-bus pickup that precedes that bus's *first* destination.
   The pickup countdown/identity/distribution remain as before. There is no
   synthetic zero, ETA threshold, horizon extension, tracking change or new fit.
2. **Require zero then fall through:** require a modeled zero pickup before
   entering that branch; otherwise run the existing ordinary arrival picker.
   This is a diagnostic, not a proposed release.

| Measure | Approved baseline | Ordered join | Fallthrough diagnostic |
| --- | ---: | ---: | ---: |
| Full journeys available | 4,620 | 4,650 | 4,688 |
| Changed decisions | — | 30 | 68 |
| Changed displayed bus identity | — | 0 | 38 |
| Different ranking from baseline | — | 0 | 16 |
| Absolute-arrival jumps >60 seconds | 117 | 83 | 78 |
| Top-choice transitions | 42 | 42 | 42 |

All 742 countdown/catchable-journey identity differences occur in the 150 m
offset sessions and remain unchanged by the ordered arm. Both upcoming wire
occurrences and all destination distributions remain untouched. The 38 cases
not repaired by ordered joining retain their original fallback and missingness.

The fallthrough arm swaps away from the raw at-stop shuttle in all 38 outgoing
cases. Twenty-four are before its recorded departure; fourteen are after it.
Those changed alternatives do not receive the focal bus's outcome. Its broader
availability and lower jump count cannot justify promoting it without separately
matching alternative bus/visit outcomes and addressing the rider already at pickup.

## Connected outcomes and retained regressions

The ordered arm's thirty changed decisions have exact same-bus/current-source
connected destination outcomes, across eight source visits and two dates.
Their total-arrival MAE changes **880.88 → 396.87 seconds**; median absolute
error **664.64 → 284.67**, p90 **1,944.21 → 828.86**. Six source means improve,
two worsen. All 1,400 previously matched outcomes retain their identity; their
aggregate MAE changes 316.05 → 305.68 seconds. The other 1,370 predictions are
unchanged. This is restored access to existing forecasts, not improved estimator
coefficients or new evidence of general population accuracy.

September 16: 22 changed decisions / six visits, MAE 1,009.62 → 382.48 seconds.
September 17: eight decisions / two visits, 526.86 → 436.44. Both dates are
reused history. No independent-date uncertainty or calibration claim is supported.

The largest regression is retained: source **63523**, target **63632**
(Rosenkranz), timestamp **1789644066335**. The fallback predicts arrival 339.06
seconds before the observed arrival; the restored full forecast predicts it
781.89 seconds after the observed arrival, increasing absolute error by
**442.83 seconds**. The shuttle therefore comes earlier than the restored forecast.
Source 61907 also worsens (mean 136.40 → 201.60 seconds). These are previously
audited legitimate journeys, not exclusions. `counterfactual-scores.json` retains
the five largest changed-row regressions and per-source results.

The restored distributions have seven lower-bound misses (the shuttle arrived
before the displayed interval) and six upper-bound misses (after it), with mean
width 886.43 seconds. The replaced fallbacks have no full-journey distribution,
so there is **no paired interval/WIS/coverage improvement to claim**. The original
1,346 matched full distributions are unchanged. Walking is modeled, not observed.

## Actual browser evidence

Baseline built SPA and a separate Vite build with only the frozen ordered-join
source transform each passed 197 mobile numerical/order comparisons across the
complete 57454→48 and 58224→48 sessions. Zero page errors, no screenshots.
The prototype writes only `cycle-6/ordered-dist`; app source and normal web/dist
are untouched. This is an exploratory browser prototype, not a submitted patch.

At **1789561481036**, source57454, the actual baseline says “At your stop” and
**14 min / 8:39a** because the journey join fails. The prototype preserves the
pickup wording and uses the already-served destination: **39 min / 9:04a**.
Recorded connected arrival is about50.5 minutes away, so this remains an imperfect
forecast. The h29 missing cases remain unchanged, including their fallback.
Supplemental prototype checks cover keyboard/touch details,44px close, stale and
missing wire removal/recovery, and phone page width; see transitions evidence.
No native screen-reader, physical phone, all-route or arbitrary-device claim.

## Reproduction and limitations

From repository root:

```
python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6/audit_missing.py
python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6/prepare_arms.py
python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6/score_counterfactual.py
python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6/verify_evidence.py
```

The scorer needs counterfactual output first. Native state observation and shell
replay use local `./node_modules/.bin/tsx` from `services/shuttle-v2`, scripts
`observe_states.mts` and `counterfactual.mts`, each under the shared heavy.lock.
Browser scripts `browser_missing.mjs`, `build_ordered.mjs`, `browser_ordered.mjs`,
and `browser_ordered_transitions.mjs` also run from that directory under the lock.
Exact executed commands/results are in PROGRESS.md and corresponding logs.

The first counterfactual run failed because deep equality compared in-memory
`missedBus: undefined` to saved JSON, which omits that property. Its script/log
are preserved. Corrected comparison serializes actual values first, with no
numerical tolerance or forecast change. No application assertion failed.

No application types/full suite/staging/deployment run was needed or claimed.
Any integration still requires shared-shell ownership, substantive folded-route
and repeated-visit regression tests, typechecks, full release gates and independent
review. No historical database, watcher, controller or other-team file changed.
