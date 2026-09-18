# ETA overnight team handoff — 2026-09-17

## Mission and ownership

Improve reliable rider arrivals, especially Red at Winchester and Union, by understanding repeatable operating behavior in recordings. A rider needs to decide whether to walk, when to reach the pickup, and whether the entire trip gets them to class. A narrower interval is useful only if its early/late misses and decision errors remain acceptable. The user accepts modest worsening on genuine outliers for substantial typical gains; they do not authorize deleting inconvenient outcomes.

Work through **2026-09-18 07:30 America/New_York (11:30 UTC)** in bounded builder/reviewer cycles. Root coordinates persistent workers, integration, review, and deployment; this bootstrap agent has made no app changes, builds, fits, commits or deployments.

- App worktree: `/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17`
- Initial HEAD: `40af3c0bb8e2522972b4e9f0222b1756fbd3c227` (latest master supplied by root).
- Artifacts: `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta`
- ETA owns model, calibration, filter, measurements and related API contracts. UI team owns visual components, copy and presentation. Coordinate any shared interface/planner change through root before overlapping edits.
- Never edit another team's worktree, historical input databases, or original research artifacts. Copy scripts into this artifact directory and replace their hardcoded paths/output names before running.
- Do not deploy or merge independently of root's review queue. Prepare concrete reviewed changes; root has standing authorization to complete deployment.

Read current `CLAUDE.md` and `docs/red-current-release.md`. Root `AGENT.md` is archived v1 guidance and conflicts with the explicit v2 migration in CLAUDE.md: **the deployed app is `services/shuttle-v2`, not either archived v1 service**. No AGENTS.md was found. Current normal checks are `npm run typecheck`, `npm test`, and `cd web && npx vite build`; deployment is the normal GitHub CI pipeline, including staging and smoke checks. Node 22 is specified. This new worktree initially has no node_modules; root should provide isolated dependencies or approved existing dependency links. Do not commit dependency symlinks.

## Production baseline that must remain the comparator

Current deployed changes include restart-truncation recovery (PR 279), correlated sampled future laps (PR 280), and Winchester current-wait stabilization (PR 281, plus the latest follow-up at this HEAD). Existing production uses:

1. Continuously warm **server** position belief and arrival distributions. `/api/buses.server_eta` is authoritative; missing/stale server estimates fail closed, not browser cold-started estimates.
2. Forward route progress on a ring; GPS deadband is about 30 m. A repeated coordinate is censored movement evidence, not proof of being motionless. `bus_name` is the stable identity, not reissued `bus_id`.
3. Winchester-only 15-second logistic current-release hazard, using elapsed wait, lap fixed at pin, and a first harmonic of 15-minute wall-clock phase. Server fits completed historical data, with 60 observations / three dates / 40 laps support, a bounded six-hour fit cache, startup warming, and conservative fallback.
4. During a tracked Winchester rest, 30-second absolute-arrival quantile pooling. It ends when the tracked rest ends, not at an oracle retrospective departure. It preserves both target occurrences and the distribution. The lower-side widening remains; extra upper-side widening and old median ceiling are bypassed only for supported current-release pricing.
5. Future layovers retain existing marginal tables and sampled lap dependence. Union remains on the prior estimator because its complete rider predictions did not consistently improve.

Relevant implementation: `web/src/eta/{arrival,index,release,tables,filter}.ts`; `src/calibrator/releaseFit.ts`; `src/collector/collector.ts`; `src/server/serverEta.ts`, `v1compat.ts`; `src/network/TransitNetwork.ts`. New runtime imports must enter Dockerfile's explicit shared ETA COPY closure. Topology replacement must retain fitted models, not merely periodic calibration. Fit content participates in cached-table fingerprints. Checkpoint persistence must preserve any new forecast memory.

The prior final replay used 16,253 actual raw frames, 150,020 forecast rows, 46,790 identical tracking-belief comparisons, 302 full-server parity checks, and no differential forecast loss. At Winchester +60 seconds, afternoon Division MAE was 216→81 seconds; Rosenkranz width was 814→622 seconds. Jumps over 60 seconds fell 4→1 and 9→2. Immediate departure Division MAE worsened 23→43 seconds, +15 seconds 25→36, and recovered by +60 seconds. The next occurrence did not materially narrow. **These are baseline deployment results, not achievements of this overnight team.**

## Honest covariate inventory

The authoritative earlier inventory is `../red-window-data/covariate-inventory.md`; also read `operating-pattern-review.md`, `release-policy-review.md`, `ahead-trigger-review.md`, `follower-progress-report.md`, and `follower-identity-review.md`.

| Covariate / structure | Current evidence and implication |
| --- | --- |
| Own lap fixed at pin | Useful; deployed. Negative lap/hold association is partly a shared clock partition, so it does not prove driver regulation. Validate total arrival, not only hold component. |
| Elapsed wait and 15-minute clock | Useful in current release model; deployed at Winchester. Conditional waits are not necessarily normal or monotonically narrowing. A missed release phase can legitimately increase remaining uncertainty. |
| Hourly service role | Most repeated same-bus departures are near hourly cycles; daily offsets can change for the same vehicle. A two-prior-departure phase predictor had useful Union center gains but mixed survival/tail results. A fixed bus-number effect is not a driver effect. |
| Bus number, hour, weekday, prior-departure headway, geometric neighbor spacing | Specific guarded/additive versions were screened; no consistent additional gains warranting a new deployed rule. This does not exhaust interactions or establish no structure. |
| Ahead bus persistent reached-stop flags × clock | Winchester departure per-hold log loss 3.1923→3.0649 (~4%), improving three of four development dates. Union ~0.4%. Before-event departures also increase, so shared schedules/anticipation remain explanations. NOT deployed; not a measured rider ETA gain. |
| Behind bus progress / reached flags × clock | Union ~1–1.4% log-loss gain, but Brier flat/slightly worse. Winchester adds ~0.1% beyond ahead progress. NOT deployed. Distinct-neighbor Union ~3–4% gain is confounded with date; September 15 has no distinct-follower cases. Do not enable a rule simply for three buses or discard that date. |
| Same-stop encounters | Seven both-stopped Red overlaps, all at the two regulators. One pair departed 35 seconds apart after 450 seconds overlap; the other six departed 345–835 seconds apart. Too sparse for a dependable coordination rule. |
| Recent own/fleet/opposite-regulator residuals, anchor-to-pin, phase grids, lap×hour/bus×hour | Several versions already screened, mostly small/mixed. Read prior arms before repeating. A consistently defined approach/pin/departure episode remains a structural lead. |
| Weather, passenger load, driver/shift, class schedules | Not established in current data. Do not manufacture measurements or add unavailable hindsight features. External data collection needs a concrete causally available hypothesis and later validation. |

All covariate percentages above are **one-step departure score** gains unless explicitly labeled otherwise. No study established an optimal feature set or a deterministic driver dispatch instruction.

## Data and evaluation ledger

Workspace archive root: `/home/gwarren/projects/yale-shuttle-watcher`.

- `conditional-replay-data/outcomes.db`: original read-only historical outcomes (102 MB).
- `conditional-replay-data/raw-frames.jsonl`: 12,654 observed frames, September 16–17 through `1789665240913` = September 17 13:14:00.913 ET.
- `release-integration-data/outcomes-complete.db`: separate completed-afternoon snapshot (103 MB), original untouched.
- `release-integration-data/raw-complete-frames.jsonl`: 16,253 frames through the later afternoon; original prefix is identical.
- `release-integration-data/validation-split.json`, `frozen-candidate.json`: prior pre-afternoon declarations.
- `release-integration-data/production-replay.mts`: reusable paired warm replay, but currently hardcodes archive outputs and release-off baseline. Copy and adapt it; overnight comparator must be **current production release ON**, not the obsolete release-off comparator.
- `release-integration-data/final-meta.json`, `final-{development,holdout}-score.json`, `final-next-occurrence-review.py/.json`, `final-regression-audit.py/.json` preserve deployment evidence.
- `red-window-data/full-path-score.py`: exact connected first-target score; use `--candidate-key candidate --min-warm-sec 600` with new paired output and correct read-only DB.
- `red-window-data/follower-progress-screen.py/.json`, `follower-progress-plan.json`, `follower-identity-review.py/.json` and `ahead-trigger-barrier.py/.json` preserve causal feature contracts. Some scripts execute prefixes of other scripts: inspect dependencies and output paths before copying/running. Files named `before-causal-fix` are superseded.

Original chronological research fit dates: September 3, 4, 8, 9; calibration: September 10–11; already-inspected development: September 14–17 through 13:14 ET. Original hazard cohorts were Winchester 102/58/99 and Union 112/61/103. The later September 17 afternoon was used to validate the current release and select Winchester-only scope. **It is now used evaluation data, not an untouched holdout for a new overnight candidate.** Preserve this distinction in every report.

Use blocked chronological validation within existing history for new exploration. Freeze any candidate before fetching/scoring later recordings; new service dates are genuinely prospective only if not used in selection. A small early-morning sample cannot establish calibrated probabilities. Keep one fixed version as the prospective shadow, not a different winner every hour.

## Data integrity and causality rules

- Keep genuine short and long waits in all arms. No residual trimming, no arbitrary two-day cutoff to hide wide windows, no selection based on model disagreement.
- Only independently proven restart truncation visit 65237 (#316, Winchester, pin `1789656325854`) is quarantined from fitting; its database record remains. PR 279 addresses the detector cause.
- Prior audited legitimate cases: 64318, 58224, 65347, 48550; afternoon 67957 and 68304. Follower-regression cases 51469, 54002, 52633, 52168, 54777, 53429 have complete rest evidence and remain. The last group was not newly raw-GPS-verified; do not embellish that review.
- `arrivals.dwell_sec` in legacy data is anchor residence, not physical standing time; do not subtract it from identical segment residence to infer travel.
- Pin time can be backdated relative to first published pin evidence. Neighbor arrival+15 seconds and completed+120 seconds are conservative availability proxies, not recovered exact receipts. Live implementation must use receipt/known times or a documented conservative contract.
- Latch predecessor/follower identity causally. Follower in departure order is not guaranteed physical nearest bus. Account for same-as-ahead, missing/stale identity, route reassignment, tied/co-located buses, and service entry/exit.
- Most critically: **never integrate a future hazard using the neighbor's realized future positions or next arrival.** Use a causal forecast with propagated uncertainty, or train remaining time directly from the neighbor's presently known snapshot.
- Missing/incomplete endpoint chains stay visible as censoring/exclusions or unavailable forecasts; never turn recording end into departure or silently drop one arm's failures.
- Preserve forward route-position behavior. Prefer pricing/calibration improvements first. If a concrete tracking defect is found, root must approve the ownership scope and replay all affected routes with both repeated target occurrences.

## Rider-centered acceptance metrics

Report paired current-production versus candidate forecasts, same cases and same observed warmup. At minimum: first and second occurrences; source +0/+60/+180/+300 standing and departure +0/+15/+60; destination endpoints (Division 48, Rosenkranz 4); passed and stopped targets separately; MAE, median/p90 error, WIS, interval width, early misses (bus arrives before displayed lower bound), late misses, forecast availability, and >60-second absolute-arrival jumps. Count visits and dates alongside repeated checkpoints.

For route decisions, evaluate pickup catchability given walking time, destination deadline miss, total walking burden, and ranking churn. A late-arrival probability must be evaluated on joint pickup/ride/walk scenarios; averaging a range or conflating pickup confidence with class-arrival confidence is not adequate. Do not invent a validated percentage from the plotted quantiles.

Inspect the largest genuine regressions before accepting a typical gain; retain them and explain the physical behavior. Check systematic subgroup shift separately from a few extreme cases. Use day/visit-clustered uncertainty or honest descriptive counts; thousands of dependent risk bins are not thousands of buses. A useful small production fix is preferable to a sophisticated unvalidated replacement.

## Coordination with UI team

ETA should give UI an explicit semantic contract: pickup versus destination arrival, current predicted distribution versus recorded comparable journeys, cohort/support and age, uncertainty versus following-bus headway, and forecast freshness. UI should emphasize the next action and total arrival time, use concise stable text, keep optional evidence expandable, and distinguish actual historical dots from modeled outcomes. Existing user requests include shorter minimap text, wait duration adjacent to the correct bus (`X/~Y` with clear meaning), recent historical dots emphasized, recency-weighted historical summaries, less route-rank churn, and fewer routes that offer no worthwhile saving over walking. Do not change UI copy from this team; send evidence and requested contracts through root.

## Cycle and handoff protocol

For each 45–90 minute cycle write `cycle-N/PLAN.json` before evaluation, then `RESULTS.md`, machine-readable paired results, and `REVIEW_REQUEST.md`. Include input hashes, comparator commit, model family, all tried arms, split status, feature availability, support/fallback, regressions, runtime cost and exact reproduction commands. The reviewer works independently and returns blockers or acceptance; builder addresses blockers without rewriting the experiment history. If a candidate fails, record why and advance to the next bounded task rather than rerunning unrestricted hyperparameter searches.

Reserve the final 60–90 minutes before 07:30 ET for integration, appropriate full checks, review, root-controlled deployment if justified, and a self-contained morning report. A failed research candidate is a legitimate finding but does not by itself complete the night: move to the next actionable backlog item. Do not force an unvalidated model into production merely because the night is ending.
