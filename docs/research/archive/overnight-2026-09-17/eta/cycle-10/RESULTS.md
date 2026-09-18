# Pickup identity disappears with destination forecasts

**Research complete; no application change.** Current production retains the
selected pickup internally but does not carry its occurrence through the trip
option. This makes a missing destination forecast erase a known boarding bus
from the presentation, and makes a later pickup by the same vehicle look like
the first pickup. `CONTRACT.md` specifies a coordinated ETA/UX repair without
changing bus selection, countdown, waits, ranking or ETA arithmetic.

Entry and exit HEAD: `d5a392f533e8684320259ff0d323a3b0da75cc50`, clean checkout
and index. This supplied baseline includes published PR289. Prior model,
clock, smoothing and ordered-join experiments were reused, not restarted.
No application file, prior artifact, controller file or other team's file was
modified. Publication and independent review remain controller-owned.

## Exact current-production census

The frozen `PLAN.json` precedes this evaluation. `prepare.py` extracts the
unchanged numerical options block from the actual shell and forwards the
current `pickupState` argument. Wrapper instrumentation records only the
existing picker and journey calls; telemetry is suppressed. The research
metadata projection never selects a new row.

All **4,688 current options, traces and ranking states** exactly equal the
independently reviewed ordered-join results. All original wire rows and both
occurrences remain intact. The source changes since that earlier capture are
the approved at-stop caution/UX integration; every selected historical output
is explicitly checked rather than assuming parity.

| Existing selected pickup relation | Decisions | Sessions | Source visits |
|---|---:|---:|---:|
| Same forecast visit as countdown | 2,490 | 40 | 10 |
| Raw current stop observation | 1,456 | 20 | 10 |
| Different vehicle from countdown | 742 | 18 | 9 |
| Same vehicle, later pickup | 0 | 0 | 0 |

These groups overlap in their sessions/source visits. The full cohort is 40
selected Red sessions, ten source visits and **two already-used dates**,
September 16–17. Checkpoints are dependent. There is no all-route prevalence
claim and no new holdout.

Current destination windows are present for 4,650/4,688 decisions. The 38
remaining raw-current selections lack a compatible forecast pickup. They are
exactly the prior 38 outgoing cases, with only an h29 next-lap pickup: 24
before and 14 after retrospective source departure. They remain unlinked.
Departure outcomes classify them after the forecast; they never decide the
earlier selection. No raw board-now forecast is manufactured.

## Missing-destination experiment

For each input, remove only the option's destination rows and their aligned
distributions. Preserve all bus positions, every pickup occurrence, source
times, the saved plan and the unchanged production code. This is a **synthetic
missing-data sensitivity**, not an observed outage count.

- All 4,688 selected pickups, countdowns and waits stay identical.
- All destination windows become unavailable, as expected. Existing total
  estimates can change to their planned-ride fallback; no all-value equality
  or fallback-accuracy claim is made.
- For all 742 distinct-vehicle selections, `tripBusIdentity` falls back to the
  countdown bus because `journeyArrival` is absent. The selected boarding bus
  was already known independently of the missing target.
- The 30 previously restored approaching raw joins lose their optional
  forecast link without destination ordering evidence; raw vehicle identity
  stays known. There are now 68 raw-unlinked selections in the synthetic arm,
  not an additional 30 historical tracker failures.

`pickup-census.jsonl` retains all 9,376 paired records, snapshot-relative
occurrences, identities, waits and totals. `summary.json` includes cohorts and
exact example keys. No score-based case selection or exclusion was used.

## Actual browser reproduction

The existing built SPA is tied to current source: `verify_build.py` checks all
81 local source modules in its sourcemaps and records 20 asset hashes. The
browser uses real planner/transport/rendering on sorted synthetic wires over
the checked-in Red topology. Every request is intercepted; `seedTestId` is
used. There are no analytics writes, screenshots or production requests.

The locked browser script passes eight states with zero page errors and all
resources closed. It first renders an ordinary same-bus trip, then exercises
distinct boarding, destination loss, same-bus later boarding with/without a
destination, recovery and stale/fresh forecasts.

Concrete output (`browser-contract.json` includes full options and DOM text):

| State | Existing selected wait | Expanded detail |
|---|---:|---|
| Countdown #307, selected #309, destination known | 1,070.95 sec | `17 min`, `#309`, two named boarding actions |
| Same pickups, destination removed | 1,070.95 sec | `now-2 min`, `#307`, only “I'm on it” |
| #307 selected on its later visit | 2,500.95 sec | `now-2 min`, `#307`, no later-visit explanation |
| Later #307 destination removed | 2,500.95 sec | Same misleading short wait |

The rendered `17 min` is existing formatting of roughly 17.85 minutes. These
are reproduction fixtures, not measured rider waits or new historical
incidence. The same-bus later case does **not** occur in the selected historical
census; its existence and rendering defect are established here.

Thirteen direct boundary checks execute production picker/journey/display
helpers: both same-bus visits, destination loss, distinct buses, no catchable
bus, normalized names, folded-route evidence and missingness, raw current
without a valid modeled pickup, stale/departed absence, future absence and
changing relative hops. `selectedAtMs` names client selection time honestly;
it is not a server snapshot timestamp or a durable visit identity.

## Existing outcomes and limits

`verify_evidence.py` preserves all 1,400 previously connected outcomes, matching
the current total and availability exactly. The source63523→63632 regression
remains +442.827 seconds of absolute error: old diagnostic fallback error
−339.063 seconds, current restored journey error +781.890 seconds, both
**predicted minus actual**. This is preserved older join evidence, not a new
comparison against today's production. No coefficient or ETA distribution
changed this round; no new MAE, WIS, coverage or calibration gain is claimed.

The first evidence verifier used an incorrectly hand-transcribed precise
regression decimal and failed. The original script/log are retained as
`.first`. It now checks the published rounded value 442.83 while retaining the
exact original outcome record and its frozen hash. No data, pairing or score
changed. The six-state successful browser artifact is also preserved before
adding the two stale/fresh states. Both browser invocations passed.

## Executed commands

Run from
`/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2`.
All reports below are in
`/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10`.

```sh
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/prepare.py
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/audit.mts
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/boundaries.mts
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/verify_build.py
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/browser-contract.mjs
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/verify_evidence.py
git diff --check
git diff --exit-code
git diff --cached --exit-code
git status --porcelain
```

Final results: all exit0. Audit proves 4,688 exact decisions/rankings and 4,688
paired missing-target selections; boundaries13; browser8states; evidence1,400
outcomes/38unlinked cases/11frozen input hashes/retained regression. Exact logs
are `prepare.log`, `audit.log`, `boundaries.log`, `build-provenance.log`,
`browser-contract.log`, `evidence.log`. No application source changed, so no
new typecheck, Vite build, full suite or staging run is claimed. Those become
required when this contract is implemented.

## Next bounded task

Independent research review should verify the contract, causal projection,
occurrence semantics, source extraction, ablation and actual DOM reproduction.
Then controller coordinates one ETA/UX implementation: retain the existing
pickup selection in TripOption, consume it for ride identity/wait text, and
test all lifecycle/manual-boarding paths while proving numerical equality.
Keep the remaining 38 raw-unlinked cases and movement-cache determinism
separate. No estimator refit, arbitrary cap, ranking change or physical visit
relabeling is warranted.

All owned command sessions completed; no owned browser, server or lock remains.
The existing watcher is untouched. Combined screenshot census at verification:
178 files / 8,046,753 bytes, zero additions from this round. Latest UX03:16
focus/copy correction request was read; no source overlap or action dependency.
