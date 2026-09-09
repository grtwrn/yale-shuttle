# Full-day Red rider replay: independent completed-results summary

All four frozen replays completed successfully. The original scoring watcher finished both days, and the separate recording qualifier verified every wait had exactly one tick record: September 4 baseline2,385/candidate2,361; September 8 baseline2,273/candidate2,256. There are zero duplicate, missing or orphan recording IDs. No duplicate scorer or replay was launched by this audit.

These are the original **phase versus ordinary baseline** replays on frozen source `e332cba`, not the subsequently rejected held-motion experiment. September 4 is development and September 8 is regression. Neither is new independent holdout evidence.

## Primary accuracy

Mean absolute error in seconds; first estimates compare each rider's original first issue against the first available Red bus at their curb. All-wait scores average matching future ticks within each rider, then riders equally.

| Day / original population | Eligible paired riders | First ETA: baseline → phase | All-wait ETA: baseline → phase |
|---|---:|---:|---:|
| Sep 4 uniform Red | 1,213 | 134.88 → 132.36 | 85.78 → 88.14 |
| Sep 4 Winchester → Division/Prospect | 146 | 112.93 → 95.31 | 52.09 → 59.10 |
| Sep 8 uniform Red | 1,296 | 115.63 → 117.76 | 78.39 → 80.23 |
| Sep 8 Winchester → Division/Prospect | 124 | 105.92 → 63.72 | 47.53 → 40.64 |

The Winchester-chain first-ETA improvement is 17.61 seconds on Sep 4 (arrival-cluster 95% interval −23.30 to −12.23) and 42.21 seconds on Sep 8 (−61.01 to −23.48). Its all-wait error **worsens** by 7.01 seconds on Sep 4 (+1.58 to +13.68) and improves by 6.89 seconds on Sep 8, with the latter interval spanning zero (−15.09 to +1.64). Uniform Red first changes are small; both vehicle/day intervals span zero. Uniform all-wait errors worsen on both days. This supports a specific Winchester first-estimate gain, not a claim that Red accuracy improved uniformly.

The independent served-occurrence sensitivity agrees in direction: Sep 4 chain first MAE109.77→92.70 across137 riders; Sep 8 chain remains105.92→63.72 across124 riders. The primary keeps the original 45 m curb arrival; this sensitivity separately corroborates a served 50 m crossing within 30 seconds rather than replacing truth with a different bus.

## FIXED / INTRODUCED

For the format-independent event “original first ETA absolute error exceeds 120 seconds,” the exact paired transitions are:

| Cohort | FIXED | INTRODUCED | Bad first estimates: baseline → phase |
|---|---:|---:|---:|
| Sep 4 uniform | 38 | 16 | 374 → 352 |
| Sep 4 Winchester →48 | 16 | 2 | 60 → 46 |
| Sep 8 uniform | 45 | 33 | 374 → 362 |
| Sep 8 Winchester →48 | 38 | 8 | 45 → 15 |

The predeclared simulator's **legacy point-format** diagnostics are separate:

| Cohort (all paired wait records) | STRAND fixed / introduced | ≥180s jump fixed / introduced | Reversal fixed / introduced |
|---|---:|---:|---:|
| Sep 4 uniform (1,434) | 2 /18 | 24 /77 | 1 /143 |
| Sep 4 Winchester →48 (156) | 4 /18 | 5 /6 | 0 /36 |
| Sep 8 uniform (1,479) | 8 /12 | 3 /155 | 1 /158 |
| Sep 8 Winchester →48 (127) | 3 /2 | 5 /7 | 0 /29 |

Those worsening point-format diagnostics must be preserved. They are **not literal current UI outcomes**: the merged presentation uses `fmtBusRange` during a hold, while this simulator retains the older point-format token logic. The raw ETA errors above remain numerical evidence independent of that text. Pin-change and vanished-countdown flags have zero fixed and zero introduced cases in these four reported populations.

## Coverage and first issue times

| Cohort | Original requested riders | Wait records baseline / phase | Paired wait records | Eligible primary pairs |
|---|---:|---:|---:|---:|
| Sep 4 uniform | 1,972 | 1,449 /1,440 | 1,434 | 1,213 |
| Sep 4 Winchester →48 | 156 | 156 /156 | 156 | 146 |
| Sep 8 uniform | 2,001 | 1,501 /1,507 | 1,479 | 1,296 |
| Sep 8 Winchester →48 | 131 | 127 /127 | 127 | 124 |

Uniform model-dependent planning exclusions are explicit: Sep 4 baseline523/phase532 skipped, with 15 baseline-only and 6 phase-only wait records; Sep 8 baseline500/phase494 skipped, with 22 baseline-only and 28 phase-only wait records. They mostly reflect the planner boarding elsewhere, plus the recorded no-option cases. No requested ID is unexplained. The chain has no unmatched wait IDs; Sep 8 both arms skip the same four riders who board elsewhere. Uniform/targeted membership was retained before deduplication, and these recorded populations have zero overlap.

**All first issues match exactly** for every rider shown in both arms: 1,434 uniform and 156 chain on Sep 4;1,479 uniform and 127 chain on Sep 8. There are zero later or earlier first issues, so the chain's first-estimate improvement is not produced by waiting longer before showing the candidate estimate. The same-original-first sensitivity is therefore identical to the eligible primary for these cohorts.

Initial already-at-curb cases, unavailable arrivals and target-track gaps remain excluded and counted under the frozen criteria. There is no current-visit or future-label change to model/history features. Each day has only three vehicle/day blocks, so tight rider-level intervals must not be mistaken for broad fleet generalization.

## Evidence

The [compact checked-in results](data/red-rider-full-days-2026-09-09.json) retain both populations and their negative outcomes. The [local archive](../services/shuttle-v2/store/red-rider-full-days/) preserves the complete score reports, qualification and scripts with hashes; full recorded ticks and immutable inputs remain in the original replay worktree.

- Original frozen scoring: `/tmp/accuracy-followup/score.py`; it was not changed.
- Full paired result: `/home/gwarren/wt/pr184-feedback/services/shuttle-v2/store/accuracy-followup/paired-report.json`.
- All recorder counts and first-issued-time audit: `/tmp/accuracy-followup/recording-qualification.json`.
- This audit's detailed read-only summary: `/tmp/accuracy-followup/independent-summary.json`.
- First-error transition decomposition: `/tmp/accuracy-followup/first-error-transitions.json`.

The summary JSON records source-report, scoring-lock and recording-qualification hashes. No further candidate, parameter adjustment, partial-day score or deployment was started.
