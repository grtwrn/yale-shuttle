# Independent review 12 — cycle-13 receipt provenance and cache determinism

**Verdict: research_only. No blocking findings for the bounded research conclusions. No application proposal or production approval.** Independently verified HEAD, supplied base and merge-base all equal `8aa67bd7f3883598f9458d825d97a52cbc004e0f`. The candidate diff, working tree and index are empty. Evidence and executable reviewer checks are in `review-round-12/`.

## What the evidence supports

The current movement kernel caches by rounded tenth of a cell but constructs the distribution from the first unrounded mean. That makes later forecasts depend on which vehicle/poll populated a bucket first. I inspected the actual current source and the artifact's single replacement, then independently rebuilt both arms and ran their warm and fresh-process replays under the shared lock. All four replay outputs are byte-identical to the builder's originals. The frozen historical calibration and current release-enabled source are shared by both arms; old release-OFF predictions are not used.

The run contains 2,178 input polls **including** the 78-poll window (2,100 preceding polls), not 2,178 preceding polls plus another 78. Both checkpoints restore three buses. Same-process restoration matches all 78 wires in each arm. Current code differs at all 78 windows after fresh-process restore; the canonical-mean diagnostic matches all 78 exactly. My separate comparator joins route-qualified bus/stop/hops and independently accounts for 6,786 first and 3,806 second occurrence rows:

| Comparison | Changed arrival rows | Changed quantile vectors | Maximum median / upper-bound / quantile difference |
| --- | ---: | ---: | --- |
| Current warm vs current restart | 1,817 | 7,044 | 21 / 3,768 / 4,153 sec |
| Diagnostic warm vs diagnostic restart | 0 | 0 | 0 / 0 / 0 sec |
| Current warm vs diagnostic warm | 1,373 | 4,834 | 21 / 3,751 / 4,150 sec |

There is no availability or served-position-label loss in this selected window. Every posterior remains normalized; both occurrences and all eight pre-existing negative lower bounds remain. No cap, valid-outcome deletion or threshold modification was introduced. The original scoring and verification failures remain preserved: distribution shape, row reordering, negative-bound assumption and receipt Counter reporting. The corrected identity-based comparisons reproduce independently.

An additional reviewer unit check extracts the exact production kernel and isolates its cache in independent VM contexts. Current code is order-dependent in all 396 represented buckets. The diagnostic passes 1,188 forward/reverse-order comparisons against an independently calculated normalized gamma formula, plus eight clamp-boundary checks. This establishes the cache mechanism; it does not establish all-route rider performance.

The builder's JSON exporter retains complete beliefs and wires, but not every ModelEntry field. To make the stronger state claim precise, I added a separate 78-poll test from the saved canonical checkpoint in two fresh processes: one prepopulates every kernel bucket in reverse order and the other starts empty. Their complete per-vehicle entries, including **belief, floors, releasePin and releaseSmoothing**, plus seenAt and all wires, match exactly. Maps and typed arrays are explicitly serialized, rather than silently reduced to empty JSON objects. This is model-state parity; server counters and all global process state are not claimed equal.

The tail probe independently reproduces the existing mixture gate: #308 at stop115 has lead mass 0.80760696 warm versus 0.78623037 after restart, crossing 0.8; the diagnostic has 0.79731575. A 5-second median can coexist with an upper bound changing from 8 to 3,776 seconds. The possible alternate position places the target a lap away. This explains the discontinuity; it does not show whether including or excluding that tail is more accurate. Warm diagnostic changes include both increases and decreases, so narrower typical bands or unchanged medians cannot establish a rider gain.

## Receipt provenance

Copied and rerouted receipt scripts independently regenerate five byte-identical report/data outputs. All 487 whitelisted samples and candidate sets match original file/line provenance; 130 observed_at records match read-only raw database records exactly on the specified transit fields. The only reconstructed-field differences in those matches are 70 lap-age differences. Source inspection confirms the response-time lap calculation and the watcher's handler clock. No server_eta was archived.

The decision denominator remains **38 decisions / 19 bus-polls / nine source visits**. There are zero exact selected-decision captures, eight unique-compatible cases under the declared matching contract, 14 ambiguous and 16 unmatched. Four source windows have no archived samples; the approximately 22.9-hour recording gaps are coverage limits. Compatibility is not recovered exact collection identity or proof of what was published by a decision time.

My additional read-only database audit verifies all nine source identities and anchored/pinned/departed clocks. All five covered visits have at-stop responses handled after recorded departure. At source65347, collection itself retains that flag at +4.975, +9.990 and +15.137 seconds. The code derives the flag from nearest-stop residence and radius, separately from movement evidence. It is not proof of immobility or open doors.

Small wording clarification: source65347's excursion is **95.42 m from the prior standing plateau**, but **65.28 m from the immediately previous captured point**. My first supplemental assertion incorrectly assumed those were the same point and failed; the preserved source/log (`receipt-timing-audit.first.*`) documents it. Checking both actual steps resolves the fixture assumption without changing application/builder evidence. Return to the at-stop state retains the same pinned clock. Neither this maneuver nor retrospective pre-departure status resolves the 38 unknown pickup choices.

All 1,400 prior connected outcomes and the exact older 442.82701916224846-second regression remain. These are retained historical evidence, not new accuracy results. Cycle-12's interrupted outcome review still has no final verdict; this review does not silently approve it. UX's combined pickup and ride-recovery review remains separate; current UX progress/requests through 04:47 ET were read without modification.

## Commands independently executed

`O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12`. Application-dependent commands use this checkout's `services/shuttle-v2` cwd. Copies change only output/prior-artifact paths, preserving original app imports and input hashes.

- `python3 $O/audit_receipts.py` and `python3 $O/verify_receipts.py` — both exit 0; 487 original samples/candidate sets, 130 database matches, 12 frozen input hashes, 38 decisions and prior outcomes verified.
- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/cache/run.sh` — exit 0; fresh builds, kernel-order examples, two 2,178-poll warm replays and two 78-poll fresh-process continuations pass.
- `python3 $O/cache/score.py` and `python3 $O/cache/verify.py` — both exit 0; current mismatch, exact diagnostic parity, both occurrences, ordered vectors/bands and eight unchanged negative bounds verified.
- `./node_modules/.bin/tsx $O/cache/tail_probe.mts` — exit 0; posterior mixture crossing reproduced without advancing forecasts.
- `node $O/kernel-audit.mjs` — exit 0; 396 buckets, 1,188 diagnostic checks, eight boundary checks.
- `python3 $O/independent_compare.py` — exit 0; four byte-identical replay outputs, five byte-identical receipt outputs, independent physical-key joins and all 58 builder files preserved.
- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/fullstate.sh` — exit 0; two fresh processes, complete ModelEntry/seenAt/wire equality on 78 polls.
- `python3 $O/receipt-timing-audit.py` — initial exit 1 on the previous-point assumption above; corrected reviewer fixture exits 0, verifies nine source clocks and the physical transition details. Failure preserved; no acceptance condition on the product was weakened.
- `git diff --check`, `git diff --exit-code 8aa67bd7f3883598f9458d825d97a52cbc004e0f HEAD`, `git diff --exit-code`, `git diff --cached --exit-code`, `git status --porcelain` — exit 0 and empty. Exact head/base/tree and 58 preserved builder files are in final-integrity.json.

A read-only rg invocation briefly failed with executable unavailable (exit127); grep completed that inspection. No application test failed. No application typecheck, full suite, Vite/browser, staging, Docker, CI or deployment was run or claimed for this artifact-only review.

## Next bounded task

Keep the diagnostic fixed. The controller should scope complete current-production-versus-canonical replay on the existing Red history and available all-route recordings, in separate processes with matching causal calibration, actual input order and connected target outcomes. Measure both occurrences, availability, MAE/WIS, early/late misses, absolute-arrival jumps, route-forward behavior and rider decision changes. Inspect legitimate regressions, especially full-mixture threshold crossings. Test multiple fresh-process restarts and bus-order permutations, including folded/repeated-stop routes. Preserve eight negative lower bounds as a separate transport/display audit. Do not alter mixture thresholds or tune to this selected window.

The dates and this difficult window have already been examined: there is no fresh holdout, calibrated probability, nominal coverage or normality claim. Earlier neighbor/service-role evidence remains exploratory and score-dependent (small log-loss gains, flat/worse Brier and date-confounded identity groups); none authorizes coefficients. Future receipt resolution requires a bounded tester-identified same-response raw+server_eta capture during service, leaving the existing watcher untouched; no second persistent watcher.

All owned sessions (3218, 71427, 85024) completed. No owned process, lock, browser or server remains; zero screenshots. No tracked source, index, branch, historical records, other-team/controller/publication files or watcher settings changed. No dependencies, private feedback, external contacts or publication actions were needed.
