# First bounded task: causal neighbor snapshots for remaining wait

Timebox: 75–90 minutes from worker start. Read HANDOFF.md first. Own only this team's artifact directory; initially make a research candidate, not application changes. No new agents; root provides reviewer capacity.

## Question

Does currently known neighbor progress improve **remaining-wait distributions** after accounting for own lap and clock, and is any improvement large enough to justify complete served-arrival integration? The existing ahead/behind experiments answer only departure in the next 15 seconds. Their future covariates cannot simply be looked up from recordings when generating an ETA.

## Frozen experiment to write before scoring

1. Copy causal cohort/identity extraction helpers from the corrected ahead/follower scripts into a standalone `cycle-1` script. Do not execute source scripts' fitting/output sections. Read SQLite with `mode=ro`; record hashes. Preserve the already-documented fit/calibration/development partitions and all original outcomes. Do not inspect later-afternoon outcomes to select model families or support.
2. Construct forecast landmarks at elapsed pinned wait 0, 60, 180, 300 and 480 seconds for episodes still continuing then. At each landmark use only peer events known by that forecast time under the primary arrival+15-second/clearance contract, with completed+120-second sensitivity. Keep no-feature and unsupported-lap cases with explicit fallback. Record first-published pin limitations; these are initially conditional true-rest component predictions, not live GPS predictions.
3. Latch peers causally at pin using the reviewed departure-order definition. Keep identity, missingness, staleness, same-as-ahead, known fleet count and per-landmark reached/progress values. Check latest all-route evidence for reassignment. Do not switch follower using eventual physical arrivals or derive a neighbor from the current outcome.
4. Fit one **landmark remaining-time** family, with a small predefined arm set: lap/elapsed/clock only; plus ahead snapshot; plus ahead and follower snapshots. Prefer a regularized discrete residual-survival model because existing NumPy/logistic helpers and stable survival checks are available. At a landmark, each future-risk row may use deterministic future elapsed time/clock and the peer snapshot known at the landmark. It may never use events after the landmark. Train that same frozen-snapshot forecasting problem, rather than fitting dynamic observed peer values and freezing them only at inference.
5. Avoid unbounded complexity: use a fixed shared penalty (existing neighbor L2=10 is a defensible initial choice), training-only support/duplicate-feature removal, and no chosen winning stop. A small jointly shrunken progress/clock family is preferable to dozens of tuned interactions. If repeating landmarks contributes multiple survival likelihoods for one visit, normalize landmark contributions per visit or otherwise declare the intended visit/checkpoint weighting. Do not claim risk rows are independent trials.
6. Compare the existing production conditional release CDF as well as the new matched landmark baseline. At Union, distinguish component hazard comparison from the actual still-marginal production estimator. Do not label a gain against the weak new baseline a gain against production.

## Required outputs

- `cycle-1/PLAN.json`: exact features, fixed arm set, penalty, weighting, cutoff, baseline version, availability contract, support policy, input hashes and creation time before scoring.
- Reproducible standalone script and per-visit/landmark predictions with identities/provenance, all arm outputs and unavailable cases.
- `cycle-1/RESULTS.md`: per-stop/per-date MAE, WIS, width, early and late bound misses, median/p90 error, number of visits and landmarks, supported/unknown cases, and same-versus-distinct neighbor strata. Brier and log loss can be supplemental; they do not replace remaining-time results.
- Top five genuine regressions with exact IDs and component explanations; inspect raw/connected clocks when available, retain outcomes unless there is affirmative independent detector-error evidence.
- `cycle-1/REVIEW_REQUEST.md`: ask independent reviewer to check landmark weighting, feature-time leakage, forecast-tail semantics, identity overlap/date confounding, and whether effect merits complete route replay. Include command output and known limits.

## Decision

Advance one frozen candidate only if it improves the remaining-time proper score and useful typical errors against the real comparator with gains spread across dates, and regression inspection supports the user's accepted tradeoff. A roughly 1% component gain with contradictory scores or a large new early-arrival tail is not enough for deployment. Do not keep searching penalties/stops on the same development outcomes until a winner appears.

If no useful candidate emerges, document the result and move to the consistent episode-clock audit in BACKLOG.md. If one emerges, the next cycle implements a guarded experimental branch and runs continuous **current-production versus candidate** served-arrival replay, including first/second target occurrences, tracking parity, departure response and uncertainty. The already-used September 17 afternoon can check robustness but must be labeled reused evaluation, never new holdout.

No application integration, real-time neighbor telemetry expansion or production coefficient publication is justified by completing this component screen alone.
