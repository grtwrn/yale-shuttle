# Independent review — missing-journey research slice 6

**Verdict: research_only. No blocking research findings.** The ordered-pickup prototype is credible enough for a separately scoped application proposal. It is not an integrated production change or new coefficient validation.

Exact supplied/reviewed HEAD: `77c32b80256215eb36516e7bb68c9d7664c7697e`.
Exact supplied base and verified merge-base: `8de0eed1c6a869606272824fd3dcac753ce32836`.
The checkout and index stayed clean throughout this review.

## Resolve the apparent candidate/research mismatch

HEAD merges current UX master into the previously approved smoothing candidate. Its parents are `b574a1c800654544685a8d9f1097ad3484ac13fc` and the supplied base. I independently required the complete `git diff base HEAD` bytes to equal `git diff b574a1c^ b574a1c`: they do. The same three files contain the positive-hop/same-traversal pooling repair, its eight tests and release documentation. No cycle-6 prototype code entered application source. I found no new blocker in the carried smoothing repair and independently reran relevant merged-checkout checks below. Round-5 approval and its retained accuracy tradeoff remain documented separately; this research verdict does not promote the new shell transform.

The frozen cycle-6 baseline is the approved smoothing candidate, not a claim that it was deployed. PR281 remains enabled. Current master’s added route/bus labels change the whole TransitMap file hash, but its complete live-option arithmetic block equals the frozen extraction exactly. Of 13 input hash checks, the sole merged-file difference is that presentation file; its frozen bytes match the original declared Git revision. The other inputs remain exact. The untouched cycle-6 verifier intentionally pins the old HEAD and whole-file hash, so it is not directly runnable on this merge. Use `review-round-6/verify_evidence.py` here; do not rewrite the frozen plan to conceal provenance.

## Independently established research results

The reviewer’s rerun of all three arms on the current modules reproduced all 4,688 baseline option/trace/ranking states and produced byte-identical decision files for baseline, ordered join and diagnostic fallthrough. The transform uses current wire rows only. Retrospective departure and destination outcomes enter scoring afterward; neither influences its boarding selection.

The 68 unavailable journeys are 34 bus-polls, ten source visits and twenty sessions. I checked every missing case’s raw coordinates, heading, route, pickup identity and served row/distribution against read-only SQLite and the saved full wire. Counts independently reproduce:

- 30 incoming h1 pickups before the first destination and before recorded departure;
- 24 outgoing h29 pickups before recorded departure;
- 14 outgoing h29 pickups after recorded departure.

The 34 saved native states all have a moving leading situation. Source inspection confirms the zero-hop output requires `standingAt >= 0`; a retained rest alone is insufficient. The observed-state harness uses the actual continuous warm server, release ON, and exact serialized-wire comparisons. I inspected its 11,081-poll / 160,496-row evidence and source provenance; I did not rerun that already-completed continuous prefix in this review. No tracking repair follows from raw `at_stop_id` disagreement alone.

The ordered arm restores exactly 30 full journeys with none lost, no bus identity change and no ranking change. All 2,344 nonzero-access decisions are unchanged; that is a property of these selected cases, not a general nonzero-walk guarantee. All 742 countdown/catchable-journey identity differences remain. Each new distribution is precisely the already-served same-bus destination distribution translated by final walking time. It neither adds pickup uncertainty twice nor invents a zero pickup or later horizon. The 38 outgoing cases remain unavailable.

I independently traversed **13,598 connected-leg uses** across the missing-case audit and all **1,400 matched outcomes**, requiring same bus/route occurrence, exact departure/arrival joins, no skipped earlier target and exact endpoint. Existing choices of alight stop plus modeled final walk remain intact. All 1,370 unchanged paired predictions remain exact. The 14 post-departure missing cases are not silently treated as valid current-source boardings.

The 30 changed outcomes span eight source visits and two reused dates. MAE reproduces **880.88 → 396.87 seconds**, with six source means improving and two worsening; full matched-sample MAE is **316.05 → 305.68 seconds**. These are descriptive selected-history results, not new-holdout accuracy. All three recomputed scoring artifacts equal the builder’s bytes. Absolute-arrival jumps over 60 seconds reproduce **117 → 83**; top-choice transitions remain 42.

The worst regression is retained: source63523 → target63632 at1789644066335, baseline error−339.06sec and prototype+781.89sec, a **442.83sec absolute-error increase**. The observed shuttle reaches the destination earlier than the restored forecast predicts. Source61907 also worsens. Nothing supports excluding either. Restored intervals have seven lower-bound misses, six upper-bound misses and mean width886.43sec; distribution-free fallbacks prevent a paired coverage/WIS improvement claim. No nominal calibration, normality or independent-date significance is established. Earlier follower/clock evidence remains score-dependent and date-confounded; this review authorizes no coefficients.

The fallthrough diagnostic changes displayed bus in all38 outgoing cases and changes rank16 times. Those alternative bus/lap outcomes remain unmatched rather than inheriting focal-bus truth. Its greater availability cannot justify release.

## Executed checks and rider behavior

All heavy work held the shared heavy.lock. Application commands ran from this checkout’s `services/shuttle-v2`; Python provenance checks ran from the repository root. Reviewer copies write only `review-round-6`; all original cycle-6 files/assets retain their entry hashes.

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/verify.sh` — **exit0** (`verify.log`). 163 tests in eight files, backend/frontend typechecks, normal Vite build, exact three-arm replay, 197 actual built-shell numerical/order comparisons, separate current-source prototype Vite build, and 13 prototype browser transition comparisons passed. Zero page errors.
2. `python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/verify_evidence.py` — **exit0**, `evidence.json/.log`: exact merge/diff/input provenance, raw/connected identities, restored quantiles, retained regression and builder-artifact preservation checks described above.
3. `python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/score_counterfactual.py` — **exit0**, `score.log`; subsequent independent aggregation confirmed all three score files byte-identical, six/two source means, all2,344 access decisions, tails and117→83 jumps (`score-verification.json`).
4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash -c 'set -eu; npm test -- src/server/serverEta.release.test.ts; ./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/join-boundaries.mts'` — **exit0**, `boundaries.log`: recorded release/position/both-occurrence/warm-checkpoint test and18 reviewer-authored boundary assertions passed. Total application tests in this review:164.
5. `git diff --check 8de0eed1c6a869606272824fd3dcac753ce32836 HEAD && git diff --exit-code && git diff --cached --exit-code && git status --porcelain && git rev-parse HEAD && git merge-base 8de0eed1c6a869606272824fd3dcac753ce32836 HEAD` — **exit0**, clean checkout/index and exact identities.

The 18 boundary assertions execute the exact declared transform with current planner/journey helpers. They cover normalized raw identity, reordered rows, another vehicle’s earlier destination, zero-hop priority, refusing the next lap when the first destination precedes pickup, missing destinations, folded/repeated pickups, preserved later pickup identity, catch-risk with a nonzero walk, invalid timing and input immutability. These are reviewer research checks, not submitted application regression tests.

In the actual merged shell,57454 at1789561481036 retains “At your stop” and#309; its destination total changes from14min/8:39a to39min/9:04a. The recorded endpoint is still about50.5min away. Prototype keyboard Enter/Escape/trigger focus, touch open/close,44px close action, phone reflow, stale/missing ETA removal and recovery all pass. Following-arrival text remains present. Browser numerical tolerance is0.001 in the existing UI harness; replay JSON is exact. No screenshot was needed. Tester identity and network interception prevent analytics contamination; contexts and browser close in finally blocks.

Transport, corrupt/old checkpoint rejection, warm checkpoint restoration, server/client parity and20 Docker import-closure checks passed among the targeted tests. No new runtime import or checkpoint schema exists. This does not certify the separately documented movement-kernel cold-process determinism issue. I did not rerun the full suite, build a Docker image, stage a backend or deploy. Those gates remain controller-owned for publication.

## Next coherent slice and cleanup

Coordinate shared TransitMap/helper ownership with UX, then implement the minimal ordered existing-pickup join without changing the raw pickup countdown. Carry these boundary cases into substantive application tests, add the actual raw-override/dwell gate with nonzero walking and both occurrence rows, and test restored destination availability in class-deadline presentation (unknown versus tight buffer versus supported lateness). Keep current zero priority, same-route/same-bus identity, missing destinations and first-destination conservatism. Re-run types/build/actual-shell checks and request independent code review.

Keep the38 outgoing cases, broader countdown/catchable identity wording and movement-cache determinism separately scoped. Do not repeat completed model screens or adopt the broad fallthrough arm. Latest UX01:54 progress confirms fullscreen focus work has no arithmetic overlap and explicitly defers the join.

Every owned session completed; no owned server, persistent process, browser or lock remains. Existing watcher and historical data were untouched. No dependencies, screenshots, source/index/branch/commit, controller files, other-team files, GitHub or publication state changed. Frozen research evidence was preserved. Review scope is complete; no unfinished experiment needs restarting.
