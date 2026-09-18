# Independent ETA research review — round 1

Verdict: **research_only**. The no-integration decision is supported. No application proposal exists, and no production coefficients or ETA improvement are approved. No blocking finding prevents moving to the prepared clock/component audit.

Exact supplied base and independently observed HEAD are both `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`. The HEAD/base diff, working-tree diff, index diff and porcelain status were empty. Review began at 2026-09-18 02:44 UTC. All review outputs are under this team's artifacts; no tracked file was edited.

## What was independently verified

Read the team handoff/backlog/first task/progress/checkpoint, both cycle reports and plans, current CLAUDE ETA/data/verification guidance, current release documentation, earlier follower progress and identity reviews, and UX progress/requests. UX's pending correction is presentation-only; this review introduces no shared interface need.

- Verified 15 frozen input/code/plan hashes. The original 535 episodes, chronological partitions, existing exclusions and previously audited legitimate cases remain.
- Checked all 3,898 saved landmark outcomes against read-only SQLite and their observable event timestamps against pin/forecast times. All 1,070 visit/contract weight sums equal one. Source review confirms identities are latched at pin, latest route evidence comes from unconditional all-route anchors, and peer snapshots remain frozen while deterministic future elapsed time/clock advances.
- Independently reconstructed all 4,332 saved candidate forecasts from coefficients using separately written design and cumulative-hazard inversion. Maximum quantile difference: `6.821210263296962e-13` seconds.
- Reconstructed all 480 score rows, including weighted empirical median/p90 brackets, and all 16 top-five regression comparisons. Paired forecasts share timestamps, truth and coverage; no favorable case deletion or unreported missing candidate arm was found.
- Checked all 12 saved likelihood objectives, training-only support/duplicate-column selection and gradients without refitting. Maximum absolute gradient was `0.0002758631350602281`. The three fixed arms and L2=10 are implemented as declared.
- Executed current runtime comparator functions under the heavy lock. The pre-September-10 Winchester fit matches exactly, as do all 722 comparator forecasts: 297 release and 425 marginal/lap fallbacks. Union is correctly marginal. This checks the declared frozen component comparator, **not** live refreshed, pooled, mixture-weighted server forecasts.
- Verified the 31 regression records have complete non-gap stopped/rest evidence and outgoing legs. Confirmed the corrected audit no longer calls reconstructed pin clocks first publication, and the superseded artifact is marked. No new raw-GPS audit is claimed by this review.
- Independently reproduced cycle-2's top-five source selection at each regulator. Verified all 20 selected journey chains against bus, stop, leg order, times and endpoint `arrived_at`, plus their connected time identities.

Detailed numerical evidence is in `review-round-1/evidence-check.json`, `fit-contract-check.json` and `comparator-check.json`. Six builder contract tests were independently executed and passed.

## Interpretation and limitations

The negative integration decision is credible, but the evidence is **weighting-dependent**, not a universal absence of neighbor information. The report's primary result is equal total weight per visit over its eligible landmarks. Equal-checkpoint results are also retained and should be mentioned in future summaries:

| Comparison, primary arrival+15s contract | Visit-weighted WIS, baseline → combined | Equal-checkpoint WIS, baseline → combined |
|---|---:|---:|
| Winchester current-code component → ahead+follower | 44.5 → 44.0 | 46.1 → 48.4 |
| Union landmark core → ahead+follower | 65.2 → 65.5 | 59.8 → 58.0 |

At Winchester, primary MAE improves only about half a second for the combined arm (about one second ahead-only), only two of four dates improve primary WIS, and upper-bound misses rise from about 1% to 10%. Under equal-checkpoint scoring, combined MAE worsens from 73.2 to 78.3 seconds. Union's checkpoint gain is exploratory evidence, while its primary core comparison and early/late tail tradeoffs remain mixed. Neither justifies a new deployment. Increased upper misses alone are not proof of worse calibration: an 80% interval is expected to miss, and no calibrated nominal-coverage claim has been established here.

One nonblocking reporting detail should be corrected before reusing per-landmark tables: `weighting="visit"` retains the original `1 / eligible_landmarks_for_visit` weights even after filtering to `elapsed_0`, etc. At a fixed landmark, one forecast per visit has weights from 0.2 to 1.0, rather than equal visit weights. Label those rows as original-cohort-weighted; the existing `checkpoint` row is the equal-visit comparison at a fixed landmark. Do not choose a different weighting after seeing which arm wins. The overall visit-normalized summary is implemented correctly and was predeclared.

Weights depend on the number of observed eligible landmarks, hence eventual hold duration. This is an explicit retrospective visit/checkpoint sampling target, not evidence of calibration for a naturally timed rider request. All four development dates were previously inspected, and same/distinct follower groups remain date-confounded. There are no independent rider outcomes or fresh holdout in this round.

Tail behavior is uncapped and numerically tested. There are no training landmarks beyond the 1,800-second likelihood horizon in this cohort (maximum training remaining time 924.526 seconds), so right-censoring behavior is established by code inspection; it was not exercised by an actual long training observation. Existing synthetic tests verify finite extreme-hazard and beyond-horizon quantiles.

Availability proxies, retrospectively completed true-rest episode selection and inherited legacy lap history still require receipt-time/live-state validation before any integration. Recorded coordinates and reconstructed collector fields must remain distinguished. Current code components with frozen calibration omit server refresh, tracked mixtures, departure transitions, absolute-arrival pooling, future waits, repeated target occurrences, stability, catchability and class arrival; do not rename this comparator “current rider ETA.”

## Most useful next bounded experiment

Continue cycle 2, reusing its frozen selection and prior raw/origin audits. Trace current-production release-ON forecasts for Union 63523/57990 versus 57454/61538 through the observed post-departure route state. Decompose the predicted remaining journey into pre-Winchester travel/intermediate waits, future Winchester hold, and final travel, without feeding realized future events into an earlier forecast. Score both Division and Rosenkranz and both target occurrences before proposing a fix.

Independent retrospective labels sharpen where to look:

| Union source | Later Winchester visit | Union departure → Winchester pin | Winchester pinned hold |
|---|---:|---:|---:|
| 57454 | 57789 | 2,410.7 sec | 180.0 sec |
| 63523 | 63723 | 1,155.1 sec | 375.0 sec |
| 57990 | 58224 | 1,395.2 sec | 150.1 sec |
| 61538 | 61854 | 2,225.2 sec | 100.0 sec |
| 58510 | 58717 | 1,350.8 sec | 170.1 sec |

The two cases whose targets were much later than forecast (57454/61538) have the longest time **before** the Winchester pin and short Winchester holds. This is a localization clue, not a causal attribution or a future observable feature. That pre-pin interval contains movement and intermediate waits; do not call it pure drive time. Case 57990 shares Winchester visit 58224 and Division target 58260 with a selected Winchester case, so these source contexts are not independent trips. Reuse the shared downstream evidence instead of double-counting or rerunning it. Reproducible label extraction is `review-round-1/downstream_labels.py`.

## Actual commands and results

Working directory is the ETA worktree unless stated otherwise.

1. `git diff --exit-code 40af3c0bb8e2522972b4e9f0222b1756fbd3c227 HEAD && git diff --exit-code && git diff --cached --exit-code && git status --porcelain && git rev-parse HEAD` — exit 0; empty diffs/status, exact supplied HEAD.
2. `OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-1/test_landmark_contract.py` — exit 0; six tests passed.
3. `OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-1/verify_evidence.py` — final exit 0; all provenance/forecast/score/regression/chain checks described above passed. An initial reviewer harness run exited 1 because I incorrectly assumed endpoint labels were pin/anchor times; inspection confirmed the existing scoring contract uses `arrived_at`. Only the review harness was corrected, and the full check passed again after adding weighted-quantile and top-five checks. No builder data or score changed.
4. From `services/shuttle-v2`: `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock ./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-1/verify_comparator.mts` — exit 0; fit and all 722 comparator forecasts match exactly.
5. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock env OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-1/verify_fit_contract.py` — exit 0; all 12 training/support/objective/stationarity checks passed; no refit.
6. `python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-1/downstream_labels.py` — exit 0; five unambiguous downstream Winchester visits and their retrospective clock decompositions saved.

No application change required another typecheck, full test suite, Vite build, Docker check, browser or staging run; none was independently run or claimed. No persistent watcher/browser/server was launched or touched, no screenshot was created, and no dependency install was needed. All review commands completed and locks were released. No GitHub, commit, branch, merge or deployment action occurred.
