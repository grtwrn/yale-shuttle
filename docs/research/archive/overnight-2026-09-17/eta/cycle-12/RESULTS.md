# Keep uncertain current pickups; a later bus is not an availability fix

**Research only. No application, index, HEAD, branch or publication change.**
Current base is `8aa67bd7f3883598f9458d825d97a52cbc004e0f` (PR291).
UX is implementing the reviewed pickup projection and its consumer together;
this round does not duplicate that application change.

The previous broad diagnostic made 38 missing journeys available by switching
away from the bus reported at pickup. We now connect those alternative buses
to their **own** recorded pickup and destination, instead of assigning them the
original bus's outcome. Thirty-two decisions connect; six remain unresolved.
Among the 18 connected decisions before the original bus's recorded departure,
the alternative arrives 935–2,007 seconds later (mean 1,715 seconds). These are
18 repeated decisions from three original source visits, not 18 independent
rider trips. Recorded departure does not prove doors were open or that a rider
could board. The finding nevertheless gives no support for a blanket switch
solely to obtain a destination estimate.

All 32 connected alternatives also take longer than the existing direct-walk
estimate. Walking is modeled, not observed. We do not claim a tested ranking
improvement, a boarding guarantee, or a counterfactual rider outcome.

## Current production and integration supplement

`current-base.json` proves the entire numerical options memo and seven relevant
modules are unchanged from the independently reviewed cycle11 baseline d5a392f.
The original ETA patch applies cleanly to PR291. No fetch or remote deployment
verification was performed.

`eta-tests.patch` supplies nine normal-import Vitest tests covering actual
selector behavior with missing destinations, same-bus later visits, folded-route
missingness, normalized identity, immutable timing projection, option/poll
isolation, null/departed selections, pinned walking tolerance and raw current
evidence without a compatible forecast. All nine pass against current modules
and the reviewed artifact helper. Both virtual TypeScript programs pass with
the test represented at its intended repository path. These are supplemental
integration artifacts, not an unused metadata release. UX04:16 reports equivalent
substantive tests are already ported into its combined candidate; no duplicate
source change is requested.

The final code candidate still belongs to UX/controller review and normal
release gates. This round ran no Vite build, browser, full suite, staging,
Docker, CI or deployment. Earlier independently reviewed prototype browser
evidence is retained and is not claimed as a new run here.

## Frozen outcome experiment

`PLAN.json` and `OUTCOME_PLAN.json` were written before their respective work.
The cohort is exactly all 38 outgoing raw-at-stop decisions from cycle6: 19
bus-polls, nine original source visits, two previously inspected dates. Twenty-four
are before and fourteen after the original recorded departure. No case is dropped.
The diagnostic guard is the prior frozen require-modeled-zero-then-fallthrough
arm; there is no new threshold, fit, arm search, tracker change or ETA cap.

`prepare_current_pair.py` extracts the exact current shell block and applies
that one diagnostic guard. `current_pair.mts` checks the same 38 saved live
frames in both arms. **All 76 options and 76 traces equal the prior saved
decisions exactly**, and all frames remain unchanged. Thus this uses current
production behavior, including the ordered join and walking caution, not the
old release-OFF comparator. These zero-access cases are unaffected by the later
caution correction. Ranking and continuous replay experiments are not restarted.

Outcome matching selects the diagnostic's actual chosen vehicle and source
occurrence, never the nearest observed time to its forecast. Its source must
be the first chronologically eligible recorded visit, reached by an exact
connected chain from the alternative bus's most recent anchored visit at the
poll. Source-to-target chaining uses the reviewed leg/visit contract. Selected
hop counts must agree with served route position and destination order. Actual
raw bus coordinates, heading and route match the read-only database in all 38
cases. Forecasts are already frozen; future records enter only this scoring.
Collector flags are still reconstructed, not first-publication timestamps.

| Own-trip alternative result | Value |
|---|---:|
| Connected decisions / all decisions | 32 / 38 |
| Alternative source visits | 7 |
| Mean absolute destination error | 203.21 sec |
| p90 absolute destination error | 371.03 sec |
| Largest absolute destination error | 471.80 sec |
| Earlier than lower / later than upper bound | 0 / 2 |
| Connected before / after original departure | 18 / 14 |
| Unresolved before original departure | 6 |

These errors describe different trips from the current raw fallback. They are
**not paired estimator gains**, validated coverage, calibrated percentages or
independent-date validation. Bounds apply to 32 dependent decisions from seven
alternative visits. The largest two late misses are repeated #308 forecasts
for the same target visit57916, from source57679 in original session57454;
they remain in every applicable result. `alternative-outcomes.json` includes
every identity, leg list, forecast and error. Per-date/per-source summaries
remain in `alternative-summary.json`.

Both upcoming occurrences are accounted for, including unavailable forecasts
and unavailable outcomes independently:

| Occurrence | Contexts | Forecasts | Connected outcomes | Paired |
|---|---:|---:|---:|---:|
| First pickup | 38 | 38 | 32 | 32 |
| First destination after pickup | 38 | 38 | 32 | 32 |
| Second pickup | 38 | 38 | 30 | 30 |
| Destination after second pickup | 38 | 10 | 16 | 5 |

An earlier target row before the selected pickup is never attached to it.
Actual alighting stops can differ from the destination search: for example,
some Rosenkranz searches alight at stop3 and retain the existing final walk.
No missing second destination is replaced or extended beyond the served horizon.

## The six unresolved records stay unresolved

`unresolved-chain-audit.json` explains the failures without bridging them:

- Original source61907: four decisions for alternative #308. The predecessor
  chain reaches visit62174 at stop3, but its intermediate departure is missing.
  No future source identity is substituted.
- Original source65347: two decisions for alternative #300. Leg60621 reaches
  stop115 at1789657457878, but there is no matching arrival visit. Nearby records
  are inspected for diagnosis only and none are substituted.

Neither finding establishes a removable focal outcome error. The 38 original
raw-current missing journeys remain missing in production. All 1,400 previous
connected outcomes and the exact **442.82701916224846-second** legitimate earlier
error increase remain unchanged. No historical record is repaired or excluded.

## Verification and retained failures

`verify_outcomes.py` independently walks stored IDs, route indices and event
times without importing the matcher, checks chronological source identity,
both occurrences and numerical summaries, and preserves all frozen inputs.
It verifies **1,410 historical leg uses**, all 38 cases, the 1,400 prior outcomes,
the earlier regression, inherited database digest, exact HEAD and clean checkout.

Retained initial failures were in the artifact test harness: the Vitest alias
resolved to its CommonJS entry; a generated virtual test path duplicated the
service prefix; the folded-route fixture mixed normalized and hash-prefixed
names. Corrected resolver/path and consistently normalized folded fixture pass.
No production helper/selector was changed to accommodate the tests. Initial
logs and test source remain alongside final passing logs. The first outcome
summary counted only scored pre-departure cases under a short field name; final
output explicitly reports all24 and the18 scored subset. No matching or score
changed when those denominators were clarified.

Executed commands (TS/Vitest/typecheck commands use the v2 service cwd):

```sh
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/prepare.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/prepare_tests.py
./node_modules/.bin/vitest run --config /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/vitest.config.mjs
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/typecheck.mjs
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/prepare_current_pair.py
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/current_pair.mts
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/match_alternatives.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/verify_outcomes.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-12/audit_chain_gaps.py
```

Final logs are `tests-corrected.log`, `typecheck-final.log`, `current-pairs.log`,
`match-final.log`, `verification.log` and `chain-gaps.log`; all exit0. Initial
test/type logs are intentionally preserved. `prepare.py` regenerates only the
three runtime overlays; `prepare_tests.py` adds the virtual test manifest/path
and patch afterward. Run it before virtual typechecking on a new reproduction.

Next independent review should accept/correct the outcome attribution and
negative policy conclusion. The separate combined UX pickup candidate is ready
for its own review. After that, the remaining raw-current research needs actual
first-received collector/position evidence around a release transition; another
fit, broad fallthrough, or a repeated census would not answer that question.
There is no ETA release proposal from this round.
