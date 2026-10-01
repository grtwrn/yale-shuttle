# Executable selected-pickup metadata without changing ETA decisions

**Research complete; no release proposal or application diff.** The reviewed
contract now has a typed implementation, an applicable ETA-only patch, and a
verified isolated application build. It preserves the selected pickup identity
when destination forecasts disappear and distinguishes a later visit by the
same vehicle. The existing display is intentionally unchanged: UX must consume
this metadata before the combined proposal can fix the rider-facing defects.

HEAD remains d5a392f533e8684320259ff0d323a3b0da75cc50. Application files, index,
branch and original web/dist are unchanged. Current local origin/master is
7e29064475315c2d621b77cdca130c05737d1ab8 (PR290). Its exact numerical option
block and seven relevant selection/display modules equal this experiment's
base; `current-baseline-check.json` records that check. Browser tests use the
frozen d5 presentation plus this overlay, not a fresh PR290 integration build.
No production deployment verification was performed.

## Concrete implementation

`livePickupSelection.ts` receives the exact `picked.match` and
`picked.boardable` objects from the current option. It neither scans the
research trace nor runs a second selector. It copies their normalized vehicle,
boarding stop, snapshot-relative hops and existing point/bounds. The relation
is same-visit, different-bus, same-bus-later-visit or raw-current. Client
selection time is explicitly distinct from server receipt time.

The raw override retains its selected vehicle as raw evidence, without
inventing a current forecast or borrowing a later-lap row. The optional type
is added to TripOption; two shell return sites populate it. Stale/missing,
departed/null selection, walking and future branches clear it. No display
consumer, manual boarding action, server wire, forecast, ranking, tracking,
coefficient or persistence code changes. The helper's imports of existing
types are erased; there is no new backend runtime/Docker dependency.

`eta-projection.patch` contains these three source paths and passes
`git apply --check`; it remains outside the worktree. `prepare.py` creates the
full overlay sources and exact generated numerical wrapper from frozen inputs.
`verify-overlay.mjs` compiles backend and frontend programs with a compiler
host overlay, then supplies the same three modules to Vite. The resulting
`dist/` is only in this artifact directory. All 82 repository modules present
in its sourcemaps match the overlay or the unchanged checkout.

## Results and limits

| Check | Result |
| --- | --- |
| Current versus overlay, historical and missing-target arms | 9,376 exact option, trace and ranking comparisons |
| Projection versus independently reviewed census | 9,376 exact metadata matches |
| Original historical decisions | All 4,688 retain exact previous values and rankings |
| Census in each arm | 2,490 same-visit; 1,456 raw-current; 742 different-bus |
| Existing connected outcomes | All 1,400 retain exact total and availability |
| Remaining raw unknowns | All 38 preserved; 24 before / 14 after retrospective departure |
| Existing largest ordered-join regression | Source63523 remains +442.82701916224846 seconds |
| Executable boundary groups | 17 pass, including folded routes, normalization, null/departed, tolerance and future clearing |
| Multiple simultaneous option isolation | 100 batches / 500 options exactly equal individual evaluations; all batches heterogeneous |
| Backend and virtual frontend types | Both pass, no diagnostics |
| Isolated Vite build | 128 modules; 5.00 seconds |
| Actual compiled SPA | Mobile and desktop each pass 12 states and keyboard Tab; zero page errors; resources closed |

The multiple-option check varies access walks on 100 saved frames to exercise
heterogeneous selections in one call. These are synthetic implementation
stress cases, not observed rider alternatives or a new incidence estimate.
The first attempt varied only pinned bus names; all first 100 frames selected
the same result, so it could not establish heterogeneous isolation. That
failed fixture assumption is preserved in `multi-option.*.first`; the final
fixture predefines 0/150/1000/10000-second walks and a non-nearby explicit
origin. It does not use outcomes or tune any forecast.

Browser states cover same visit, different bus, missing destination with the
same selected pickup, same-bus later visit with/without destination, recovery,
stale/fresh, raw-current walking caution, raw-current without destination,
departed clearing and recovery. Each state's current metadata matches its
selected wait. The first eight serialized options exactly equal the prior
production browser artifact after removing only the additive property. The
original wait/bus mislabeling still occurs because UX consumption is absent.
No display repair is claimed. The exact future-mode shell guard is tested
outside the browser; actual-browser future input, full manual-action lifecycle
and final integrated UX expectations remain acceptance work.

A useful contract nuance emerged: the picker may retain its pinned bus within
the existing 90-second walking tolerance with departed=false even if the
strict catchable list is empty. Metadata must project this result, not silently
tighten the selection rule. It is evidence of the current selected option,
not a physical boarding guarantee. The raw-current caution test also retains
catchRisk for a positive walk even with a modeled approaching pickup row.

All selected history is reused Red evidence on two dates. The 742 missing-target
cases are synthetic sensitivity, not observed outages; no same-bus later visit
occurs in that selected history. No new MAE/WIS/coverage/normality/calibration
claim is made. Exact paired numerical identity preserves all prior bounds,
distributions, stability and both occurrences; no new estimator replay or
fitting is needed for this additive prototype. Prior inputs and 29 frozen
cycle10 artifact hashes remain unchanged.

## Executed commands

Application-dependent commands ran from
`/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2`.
All commands below completed with exit0 unless their preserved failure is
explicitly noted afterward.

```bash
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-11/prepare.py
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-11/audit.mts
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-11/boundaries.mts
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-11/multi-option.mts
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-11/verify-overlay.mjs
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-11/browser-checks.sh
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-11/verify_evidence.py
```

From repo root, `git apply --check` against the absolute patch path and
`git diff --check && git diff --exit-code && git diff --cached --exit-code && git status --porcelain`
pass. No full Vitest run, npm-script typecheck, staging/API smoke, Docker build,
CI or deployment is claimed. The two actual TypeScript programs did compile
successfully through the documented overlay harness. Normal release gates
remain necessary for the final integrated code.

Preserved harness failures: the first compiler harness incorrectly asserted
that the backend imported a frontend-only planner helper; first browser
comparison mixed in-memory undefined properties with serialized JSON; second
browser selector omitted the action's leading emoji; the first added
raw/departed fixture misunderstood the existing pinned walking tolerance.
Files with `.first`, `.second` and `.raw-first` preserve these scripts/logs and
closed-resource reports. Final twelve-state checks pass. None required a
prototype source change or modification of historical input/output evidence.

## Next bounded slice

Independently review this executable ETA half, then have the controller scope
one combined ETA/UX proposal using `INTEGRATION.md`. UX should consume chosen
boarding identity even without a destination, distinguish vehicle from visit
for wait attribution, preserve single same-vehicle boarding action and focus,
and keep the countdown and both arrivals intact. Port substantive boundary
cases into repository tests and run final integrated application gates.

No owned browser, context, page, server or lock remains. No persistent process,
dependency install, screenshots, private-data access, external messages,
historical DB mutation, other-team edit, controller-file edit or Git mutation
occurred. Existing rider watcher remains untouched. Combined image size was
under 10 MiB at verification; this round added none. Remaining 38 raw tracking
cases and movement-cache determinism remain separate tasks.
