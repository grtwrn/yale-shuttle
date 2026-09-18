# Independent review 15 — cycle-16 measurement correction

**Verdict: research_only. No blocking findings for this bounded measurement correction; no production approval.** Exact supplied head/base and independently read HEAD/merge-base are `98e535b99649e74ca599d2e33bcfdc46df83d30d`; tree `d0ab5a7678483e956bd1e4072abe92b18a464218`. Candidate, working-tree and index diffs are empty. This is a correction to retrospective measurement, not an estimator proposal or production approval.

All final checks passed. The independently reproduced record multisets match the builder outputs exactly: 183,123 scored pairs, 8,228 lagged-origin records, 2,737 transitions, 206 unpaired keys, 341 tracking changes, 5,021 large tails, 13,352 unresolved-identity records and 5,570 label-change records. All aggregate fields match; only equal-ranked regression order and within-poll inventory order can vary with set iteration.

## Corrections verified

The new scorer requires a unique physical origin from all wire hop rows, a matching active rest, an exact unique historical pin and an exact connected path into the latest historical source. Both arms must agree. The guard then uses each target's actual cumulative wire hops from the proved earlier origin. I inspected the code and independently executed its SQL, raw-wire and cumulative-hop verifiers in a separate directory. Future completed outcomes enter retrospective scoring only; this review generated no forecasts, fit no model, and changed no historical records.

All **11** previously established current-arrival cases now refer to their earlier visits, retaining negative remaining time in explicit transition records. All **eight** previously shifted following arrivals refer to the first return. The broader proof covers **186 bus-polls, 176 earlier visits and 8,228 affected rows per arm**, including 8,211 nonzero-hop rows. It resolves 5,878 affected targets and preserves 2,350 unresolved target/path identities; sampling and warmup gates remain separate.

Every old scored row is accounted for: 177,564 unchanged, 5,335 with the same target but corrected chain origin, eight retargeted following arrivals, and 11 retained transitions. Another 216 become connected. The scored denominator is **183,123**; the newly connected cohort retains a 1,574.321-second error. Structural verification traverses 86,270 distinct paths and 1,911,868 leg uses; these are not independent rider journeys. All 5,021 raw large interval changes, 25 prior top regressions, availability, negative bounds, and backward numerical-lead event identities remain. Largest point-error regression remains 69 seconds; largest raw upper-bound increase remains 5,791 seconds.

All 4,925 saved connected rider options and 48,072 ride-leg uses per arm pass database/physical-hop checks. Their files are unchanged. The planner was not rerun, and this is not a new observed boarding or browser validation.

## Remaining identity uncertainty: independently audited, not removed

The reported **57 current / 58 diagnostic** zero-hop rows represent 58 physical poll/target keys. The reviewer independently joined every one to the saved wire, tracking state and original database, and retained corresponding reconstructed raw context. The builder's coarse uncertainty counts reproduce.

Additional cross-index pin checks explain why automatically accepting a nearby pin would be unsafe:

- 25 rows per arm match the exact pin of **another physical occurrence of the same stop ID**. Repeated route positions must remain distinct.
- Four per arm match a different stop entirely.
- 26 current / 27 diagnostic rows have no unique exact pin at any route index.
- Two per arm match the priced origin's earlier pin despite a changed tracked-rest index. Pink #307, poll 4553, visit 59757 has no recorded outgoing leg to latest visit 59764. Blue #44, poll 5846, visit 60594 has exact leg 56119 to 60628, but the tracked-rest index has advanced from 23 to 24 while retaining the earlier clock. These are specific longitudinal follow-ups, not permission to relax the guard or silently discard scores.

The first supplemental reviewer script wrongly assumed every same-origin pin had a direct leg; it failed on the Pink missing-leg case. Its original source/log are preserved. The corrected audit records missing links explicitly and passes, without changing any builder label or forecast.

Only **one** of the 58 uncertain physical keys has numerically different arms: Purple #330 at poll 508, index 11 / stop 24. Current is `[4151, 18, 5473, 16]`; diagnostic is `[0, 0, 0, 0]` (seconds and hops). The provisional join gives both visit 57120 at +155.740 seconds. This is an occurrence/identity ambiguity with a 5,473-second raw upper-band difference, not established evidence of a four-thousand-second prediction improvement.

Its absolute-error difference is -3,839.520 seconds. The inclusive MAE changes **269.082823 → 269.072812 seconds** (-0.010010). The complementary 183,065 rows change **268.884432 → 268.895392** (+0.010960). This is an exploratory sensitivity showing that the sign of the negligible mean difference depends on one unresolved identity. All rows remain included in the primary report; the complementary cohort is **not** certified as fully identity-correct and is not a replacement score.

## Statistical and rider interpretation

The builder's bounded conclusion is supported: no demonstrated useful ETA improvement and no release proposal. Median and p90 errors slightly worsen; WIS and miss counts are mixed. The unchanged selected rider error slightly worsens, **352.172350 → 352.216208 seconds**. Tiny dependent-row differences, particularly with unresolved identities, do not support calibration, nominal coverage or on-time percentages.

These remain the first 6,000 of 20,199 full-fleet polls, covering eight daytime routes in reused September 16 history. Later/night-route evidence is unfinished. Causal calibration and the single fixed diagnostic remain frozen; no family or coefficient search was performed. Reconstructed collector clocks are not original publication receipts; modeled access and egress are not observed boarding/walking. The older 38 pickup uncertainties and legitimate Red/442.827-second regressions remain untouched, not newly certified by this slice. Earlier neighbor evidence remains exploratory and score-dependent, with date-confounded groups.

## Commands and integrity

Reviewer directory `O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-15`.

- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/run.sh` — exit 0. Sequential `score.py`, `verify_alignment.py`, `verify_score.py`, `verify_semantics.py`, `compare_labels.py`, `zero_hop_inventory.py`; all outputs routed to the reviewer directory. Rescored saved wires, without replaying the prefix.
- `python3 $O/audit_remaining.py > $O/audit_remaining.log 2>&1` — final exit 0. All remaining zero-hop cases, cross-index pin identities, raw context and inclusive/complementary sensitivity independently audited. Initial direct-leg-assumption version exited 1 as described above.
- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock python3 $O/compare_reproduction.py > $O/compare_reproduction.log 2>&1` — final exit 0. Exact record multiset equality for all eight streams, score-field equality, all 115 inventory records, 25 retained regressions and unchanged rider input bytes. The first comparator exited 1 because it compared the inventory list order; independent inspection proved all 115 cases identical. Original comparator/log preserved as `compare_reproduction.initial-inventory-order.*`; the final comparison normalizes only that list ordering.
- `python3 $O/final_integrity.py > $O/final_integrity.log 2>&1` — exit 0. All 905 tracked files, 266 prior builder/reviewer artifacts and eight frozen inputs unchanged; exact head/base/tree and clean index/checkout. At capture: 437 shared images / 19,450,874 bytes; zero reviewer additions.
- Git head/base/tree/merge-base, candidate/index/working-tree diff, whitespace and status checks — exit 0, empty diffs/status. One unavailable `rg` command used the grep fallback; a read attempted before the integrity file existed returned 1, then the completed integrity command passed.

No application tests, typecheck, Vite build, Docker/runtime, browser, staging, CI or deployment checks were needed or claimed for this empty application diff. No dependency installation, feedback access, external contacts, screenshots, Git/publication action or watcher changes occurred.

## Next useful bounded task

Continue the same frozen arm-matched poll-6000 checkpoints to poll 9000 in a new sibling artifact directory, under the shared lock, using cycle-16's corrected scoring and preserved provisional-identity accounting. Do not regenerate the completed prefix or change the candidate. Preserve fleet order, global cache, causal calibration, both physical occurrences, connected rider paths, tails and all regressions. Verify source provenance if the controller updates HEAD.

Keep the new zero-hop census and poll-508 sensitivity alongside inclusive results. A targeted longitudinal provenance check of poll 5846 (rest-index advancement while the old clock persists), plus the same-stop repeated-occurrence cases, is the next measurement refinement. It can use saved wires/raw states; an exact clock alone is insufficient when its stop index or connecting leg disagrees. No production coefficients or cache patch are approved by this review.

All owned sessions 84802, 38252, 19463, 65453, 76761 and 85659 ended. No owned process, server, browser or shared lock remains. Existing watcher, other-team files, controller files, branch, index, historical inputs and source remained untouched. UX progress/requests through its 07:05 weather scope were read; no shared-interface work is requested. The controller retains all publication responsibility. Finalized 2026-09-18T11:09:31.079657+00:00.
