# Equal-weight checkpoint ensembles — frozen development plan

Plan-only commit from `2d12fe800f0c661bb000dd5d519b812a065f69f1`. Await root review before implementation or hosted execution. No production changes, new/prospective dates, local replay/fitting/tests, cap changes or outcome-driven choice of K/weights/calibration strata. Keep the rejected 90-minute retention treatment rejected; source lifetime stays 45 minutes.

## Question and fixed comparisons

For the same upcoming physical pickup, does averaging absolute arrival forecasts from the causally available stops 0 through K before its previous major wait improve on one source? Test **K=5 and K=10**, equal weights, **all 14 routes**, frozen and daily refreshed history. Every route and zero-change cell is reported. Routes with no qualified major wait, too short a loop, missing traversal evidence or inadequate support remain unsupported, not failed estimators.

The primary policy preserves the current one-way **wait-release to live** handoff. Therefore K0 cannot join the primary pre-wait ensemble. A separately named extension permits continuation after a strictly confirmed departure from that same wait; only this extension can include K0. Never describe a post-wait result as evidence for averaging alone.

For each K/model-history mode retain these comparisons:

1. Exact immutable deployed comparator and original single-K checkpoint arm.
2. Traversal-matched single-K point control: use only offset K, but require the exact same new source/traversal/component gates as the ensemble. This separates averaging from stricter evidence selection. In the post-wait extension this is explicitly a new single-K continuation control, not the old released checkpoint.
3. Equal-weight point diagnostic, primary and separately named post-wait extension. Keep the served deployed bounds as unchanged reference metadata. Record when the proposed point is outside those bounds; do not clamp the point into them, silently widen them, or call this combination a valid rendered forecast/window improvement.
4. Separately supported empirical-residual interval diagnostic around the ensemble point, primary and post-wait extension. It returns the exact deployed triple when any required model or calibration gate fails. Also calibrate the traversal-matched single-K point by the same residual mechanism, so a window difference can be attributed to averaging rather than different interval construction.
5. A separately fixed **joint physical-journey empirical-vector interval** around those same points. This uses complete same-target vectors and reports both raw intervals and an earlier-lower protected diagnostic. It is not claimed to be calibrated. Matched single-K uses the identical vector rows and weights, projecting each vector onto offset K, so both interval mechanisms have a fair averaging control.

The extension equals the primary before release, uses its separately labelled post-wait rule afterwards, and falls back in the release/confirmation gap. Report pre-wait and post-wait outcomes separately, as well as full-route results. No adaptive choice among these arms.

## Pinned data and unchanged evaluation cohorts

- Frozen raw/predictions from run 35677536788: SHA256 `3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9` and `5bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de`.
- Canonical run 35684356219: topology `eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc`, preparation `2edd09127b7d41357ef6ecb6bf461f75c4f0b59c33d37ad2dd11cff24269df0d`, training visits `a3aa7065e7e82e018f2d0671b5a3044df766d033b7098462e4f257115d880fd5`, features `b2268eb15fc913a5c5cbf039d2dfbb8d518eefe25e6149776f7a930bd2eb5bb3`, unscored comparator `4eb4f2d24429d948e282670c213a807a32eb3858f235b2ded48168cd78c31312`.
- Evaluate only the original **September 17–20** canonical forecast keys, with immutable physical labels from highway run 35688081446. **Highway25 is primary; highway50 is the already fixed sensitivity.** Keep original22 membership and highway-added membership separate. All arms and deployed share identical labels within each policy; do not regenerate, repair or extend evaluation labels. Non-Green/Purple quality and label membership must match the canonical control.
- The comparator is the pinned `deployed` reconstruction of the checkpoint overlay, not historical `baseline` and not a newly recomputed production head. Keep its known occurrence/comparator limitations visible and preserve its bytes.
- Source-discard run 35693174975 and retention run 35694625063 provide provenance/control references. Their independent strict physical ledger is proof, never a way to recover missing model history.
- Existing earlier dates in the same frozen raw/prediction files may be used only for chronological fitting and residual calibration. September 21 and later remain unopened. September 11/14/15 daytime GPS gaps remain missing; stored finalized visits cannot fill them.

## Causal traversal and active offsets

Fit/materialize every integer offset **0 through 10**, including the previously absent 0,4,6,7,9. Existing `Models.KS` and saved fixed-K forecasts alone cannot supply this study. Keep original feature rows immutable and add an independent causal ensemble-evidence stream.

For each route/wait/K, seed one traversal at the actual reducer emission of its offset-K departure. Its identity includes public name, observed provider identity/route continuity epoch, canonical source occurrence and strict physical departure/emission identity. A source must have a finite pin, arrival and departure, resolved non-gap outcome, unique occurrence, and `departure <= known_at <= asof`; it must also be an origin genuinely inserted into the causal model history, with departure no later than the current phase start. No open/null/unpinned pass, finalized visit insertion, EOF closure, reset recovery or prior-lap reuse.

Maintain unwrapped forward occurrence progress from that seed, respecting the existing at-most-five-hop progression rule, plus exact strict departures for every required offset. Require phase/nearest/logged-hop evidence to agree on the upcoming target occurrence; historical `from_stop_id` is not the client anchor. Repeated stop IDs never stand in for occurrence indices. Future target labels are unavailable to this assignment. Provider continuity means observed IDs, not proof of physical vehicle identity.

Before the wait, the active set is a **contiguous suffix `M={m,...,K}`, m>=1**. A nearer offset joins only when its departure is actually emitted. Offsets not yet reached are not missing observations; an offset that causal progress has already passed but whose strict departure is missing or ambiguous invalidates the whole candidate. Require every active constituent and every target in the fixed downstream target group to have support. Never drop an unsupported constituent and renormalize, average only the favorable sources, or substitute an older-lap origin. A one-source suffix is allowed and reported separately; it must equal the matching one-source calculation exactly.

Retain the existing 15-second feature freshness, 10-minute warmup, 45-minute source-age cap, resets, quality policies and target grouping through the next major wait. Any required source expiry invalidates that traversal irreversibly; a delayed emission cannot revive it. A new physical offset-K departure creates a new, separately identified traversal. It must not overwrite an older traversal still associated with an earlier upcoming physical target: retain immutable source/traversal identities and use causal unwrapped progress plus logged hops to establish a unique applicable occurrence. If current evidence cannot distinguish overlapping traversal/next-lap assignments, fall back and record ambiguity; never choose the latest source by index or use the future label to decide. Preserve missing/ambiguous reasons and full denominators.

At the first original release evidence, permanently leave the pre-wait regime. The primary falls back to deployed. The extension also falls back until the same traversal's wait departure is strictly emitted; it then requires the **complete set `M={0,...,K}`**, still within the original age cap and without any intervening discontinuity. Departing-wait phase or eventual backdated departure alone is insufficient for K0. A return to hold never resurrects pre-wait evidence.

Keep the fixed whole downstream group; do not trim away expired earlier targets to obtain support for a later target. Every active component's unclamped mean countdown to every group target must exceed the existing 60-second guard. Once this countdown guard expires the traversal, it stays expired. Thus the post-wait extension may have little usable scope; report that fact rather than changing the target group or guard.

## Constituent fitting and absolute-time average

Evaluation major waits remain the canonical classification using only visits emitted before **September 16 00:00 ET**. Frozen fitting uses that cutoff; daily refresh keeps the full calendar-day embargo (`cutoff = previous date 00:00 ET`). Raw fixes, bracketing quality evidence and all source/intermediate/wait/target visits must be known before the applicable fit cutoff.

Keep existing duration means, circular time-of-day Gaussian weights (120 minutes), weekday/weekend split, path caps (Red 45 minutes, others 90), minimum 12 effective paths and three material dates. Explicitly preserve source and target visit IDs, required wait-visit ID, occurrence progress and traversal provenance in training paths. For j>0 the wait must belong to that source-to-target traversal; j=0 starts at its confirmed wait departure. No independent ID-keyed maps that overwrite repeated occurrences. Training uses the first intended downstream target occurrence after that identified wait; earlier visits to the same physical stop **before the wait** remain audited intermediate visits, not target labels. At a forecast, no still-upcoming physical pickup may be skipped to choose a later occurrence. This clarification was agreed before any paths/scores; source-to-wait-to-target travel can span more than one loop while its sources still belong to that uniquely identified traversal. Audit stricter traversal/wait proof exclusions separately from the original single-K training controls.

For source j, departure `d_j` in epoch seconds, and the fitted remaining *total source-to-target duration mean* `mu_j`:

```
A_j = d_j + mu_j
A_ensemble = sum(A_j for j in M) / len(M)
eta_ensemble = A_ensemble - shared_forecast_time
```

Translate to one common absolute arrival clock first; subtract the shared server clock once and round once at the final wire boundary. Do not average raw durations, already-clamped countdowns, lower/upper endpoints or window widths. Save all unrounded constituent predictions and the exact offset mask. One-source parity, epoch-translation invariance and target identity must be asserted.

Pre-score occurrence-proof clarification: completed-visit modulo hops alone cannot rule out an unresolved intervening lap. Training endpoints must additionally join a causal raw-phase/active-pin ledger: same observed identity and unwrapped occurrence epoch, source-to-wait progress exactly j, and source-to-target progress exactly j plus the fixed downstream distance. The ledger observes actual pre/post reducer states at their own observation timestamps, uses an active pass's occurrence (including passing closest-time evidence), and never constructs an active pin from a finalized/emitted event. Missing exact prior pin or ambiguous/gapped progress is unavailable. Full-poll provider-to-name/name-to-provider transition evidence also gates training continuity, preserving old control pools separately. These are proofs required by the original same-traversal contract, pinned before fitting/scoring; they do not change a threshold or authorize recovery.

## Chronological empirical-residual diagnostic

There is no independence assumption or `sqrt(N)` narrowing. The calibration unit is the error of the **whole ensemble** to one physical target, so the shared future wait remains in its error. Constituent effective counts do not constitute calibration support. No covariance matrix will be estimated from unrelated marginal paths.

Generate past calibration forecasts only at original sampled prediction keys in the frozen archive. For calibration date D, build every constituent using only the prefix before **D-1 at 00:00 ET**, and use only raw evidence at or before that forecast's asof. Resolve the same active-mask/traversal/regime rules. A past target outcome may become a residual only after its actual known-at time and complete outcome path are before the later calibration-bank cutoff.

To avoid importing the September 16 wait selection into earlier forecast features, classify the calibration fold's waits from its own allowed visit prefix, using the unchanged n>=30/three-date/p75>=180 rule. A residual can join a current wait/target stratum only if that earlier fold independently qualified the same wait and exact target-group occurrences; otherwise report it as unavailable. Evaluation keeps the frozen September 16 wait map. These already examined data still cannot provide fresh validation, and model/wait selection remains part of the development history.

For each frozen arm, freeze its residual bank before September 16; for each rolling date, use the same embargoed cutoff as its component fit. Do not use same-day residuals, future target emissions, random-row splits or leave-one-row-out residuals. An entire physical source traversal, its target visits and all repeated snapshots stay out of their own earlier fit and calibration bank. Record fold cutoff, latest training emission, forecast asof, target known-at and bank cutoff for each residual.

Calibration strata are fixed as **quality policy, route, wait occurrence and exact downstream target group, target occurrence, K, full offset mask M, pre/post-wait regime, weekday/weekend**, and estimator (ensemble versus traversal-matched single-K). Do not pool different masks merely by size or borrow another route/target to repair empty cells. Use the first chronological eligible sampled forecast per physical target/traversal/mask/regime/date; report cross-date repeats and keep each physical target's total weight at most one. Equal journey base weights receive the unchanged 120-minute circular Gaussian weight using the offset-K departure clock, with matching day type. Require at least 12 effective **distinct physical traversals** and three material dates (each >=5% of total weight) for every downstream target in the group. Report raw/effective traversal counts, target visits, source IDs, dates and unavailable reasons.

For each admissible past row, residual is `actual_target_arrival - A_point`. Its weighted empirical q10/q90 define:

```
low_absolute  = min(A_point, A_point + q10)
high_absolute = max(A_point, A_point + q90)
```

Only afterwards subtract the current common clock and apply the existing nonnegative wire representation/rounding. Report any endpoint clamping explicitly. These are **development empirical residual intervals**, not confidence intervals, independent samples or guaranteed 80% coverage. Earlier-fold models are trained on shorter histories than the final frozen model; report fit age/support and this transfer limitation. Optimized weights, bias correction and support relaxation are out of scope.

Empty or inadequate calibration cells are exact deployed fallback in the interval stream. Still complete the point diagnostic, calibration coverage ledger and residual-mechanism fixtures; do not invent an interval to answer the window question. In particular missing daytime GPS and the small number of earlier weekend dates may make interval support much rarer than point support.

## Joint physical-journey empirical-vector diagnostic

Pin this mechanism before any new scores, so absent prequential support does not lead to an outcome-driven new interval recipe. It is a distinct duration-distribution estimator and can answer the practical width question even where no honest calibrated residual interval is available. Its empirical coverage and tails must be measured; a nominal q10/q90 construction is not an 80% coverage guarantee.

Within each fit cutoff/policy/route/wait/target/K/exact active mask, form one vector per complete historical physical source-to-wait-to-target traversal. Every component must identify the **same physical target visit, same wait visit and same traversal**, with its own strict source departure and occurrence. Target occurrence and whole downstream target-group membership must match the query. Never cross-join marginal paths from different trips, choose a later target after an earlier physical opportunity, or fill missing components. All vector emissions and quality evidence must precede the fit cutoff. Report joint-vector support separately from marginal constituent support.

Use the original fixed 120-minute circular Gaussian weight for the **farthest source K departure clock**, and the original matching weekday/weekend type. A vector gets this single weight, shared across every component. Require at least 12 effective distinct complete traversals and three material dates for each target in the whole group. Do not multiply component weights, choose weights from eventual waits/errors, or narrow by the number of offsets. The query's actual source departures and existing constituent means still define its unchanged equal-weight absolute point.

For vector h and active offset j, let `D_hj = target_arrival_h - source_departure_hj`, with one physical target arrival shared across j. Define:

```
L_h = mean(D_hj for j in M)
L_bar = weighted_mean(L_h, fixed_vector_weights)
Z_h = L_h - L_bar
draw_h = A_ensemble + Z_h
```

Take weighted empirical q10/q90 across complete-vector draws and enclose the unchanged ensemble point. Centering preserves that point despite the joint population differing from the marginal fitting pools; this modeling choice is explicit, not an observed-error bias correction. It retains covariance because the entire vector is drawn together. For the matched single-K interval, use **the identical vectors and weights**, set `L_h = D_hK`, center around its own weighted mean, and translate to the unchanged single-K absolute point. Joint support is identical for that pair.

Persist raw numeric intervals. The prespecified rider-facing diagnostic protects the early bound:

```
eta  = proposed_point
low  = min(deployed.low, raw_joint.low, proposed_point)
high = max(proposed_point, raw_joint.high)
```

Apply it before the final wire rounding, with all terms on the same clock. This preserves an earlier-or-equal lower bound only; the point changes and can still create missed point reminders. Test those actions explicitly. Neither version changes source/quality/support/countdown gates or current deployed forecasts. Unsupported whole-group vector support is exact deployed fallback. Report raw versus protected windows and tails without choosing a winner after scoring.

## Reporting and rider tests

Lead every route with all original sampled keys, resolved/unknown labels, physical target visits, strict source traversals and dates. These are sampled user-forecast surfaces, not fleet-time exposure. Report full-route metrics with exact fallback first; then the fixed common union of any supported/changed ensemble or matched-single arm, and the intersection where averaging and single-K have the same traversal support. Preserve original22/addition splits and every K/mode/phase, including zeros. No smallest-window winner selected from changed-only cohorts.

Point diagnostics report visit-weighted MAE/bias, early/late point errors, same-visit point actions, and point-outside-served-envelope counts. The reference bounds have exactly zero width change by construction. Only supported residual/joint interval streams enter interval/rendered-width comparisons. For those report raw and actual production-printed widths, coverage, early tails at 30/60/120 seconds, severe-early and false-now counts, plus per-stop/date/source concentration and actual calibration/vector availability.

As a descriptive explanation only, calculate per-offset error covariance/correlation on the **same physical-target snapshots and exact mask/regime**, with visit-normalized weights and corresponding journey/date denominators. Report zero-variance/insufficient-pair cells as undefined, not zero. Compare within-snapshot point dispersion (standard deviation and range across absolute component arrivals) with absolute ensemble error and signed error; use fixed dispersion bins 0–30,30–60,60–120,120–300,>=300 seconds plus unknown. Retain single-active-source cases separately. Correlation or agreement is not proof of correctness, and these diagnostics cannot select weights, K, masks or interval widths.

Run the unchanged walk/response action grid on the fixed bus/physical boarding visit. Preserve all original attempt eligibility, missed/no-timely-trigger outcomes, waiting and censor reasons. Report paired new/rescued misses and waiting versus deployed, original single-K and traversal-matched single-K. Do not require an interval to evaluate the proposed point action; do not count a point with unchanged reference bounds as a deployable three-number forecast.

Audit entry of each new source, first/last source expiry, missing-offset invalidation, wait release, departure confirmation, post-wait entry, countdown expiry, reset, daily refresh and candidate/fallback handoffs. Same-pickup arrival-clock jumps and actual displayed spans are separate from unmatched, gap and next-occurrence transitions. First chronological examples only, not cases selected by gain. Averages can jump when a constituent enters; no smoothing is added after seeing results.

Existing rider-risk failures/censors remain failures/censors. Fixed-visit actions do not establish full-app route ranking or boarding safety: destination bounds affect trip ranking and its stability hold, and pickup low affects catch-risk. No rollout or fresh-holdout claim follows from this study.

## Hosted validity gates and bounded execution

1. Hash immutable inputs and labels before/after; independently reproduce original feature/single-K/deployed controls before interpreting new forecasts. Evaluation keys and labels must be identical across arms. Strict new evidence exclusions are exposed, never silently written into old controls.
2. Test offsets 0/4/6/7/9, all-offset support, one-source/equal-arrival parity, averaging absolute clocks before rounding, identical/shared errors that do not narrow with duplicate estimates, cancelling errors that can narrow, rejection of cross-journey vector components, matched-single projection on identical vector rows/weights, unequal same-stop occurrences, overlapping traversal ambiguity, prior-lap K0, missing middle source, late emission, provider/reset discontinuity, age expiry, release return-to-hold, post-confirmation gap and no EOF closure.
3. Physically delete future raw/visits/predictions for the existing quarter/midpoint/three-quarter feature prefix checks, plus first/last fitting and calibration cutoffs. Independent caches must yield identical eligible features, traversals, fits, calibration rows/banks and prior forecasts. Full outcomes may be used only in the later calibration/outcome stages.
4. Persist unscored points, interval eligibility, component predictions, source ledger, fold/support audit and calibration-bank provenance before joining the immutable September 17–20 labels. Fail closed on control/chronology/identity assertions before reporting scores.
5. Run synthetic checks, replay, fitting, scoring, rendering and actions only on GitHub-hosted runners. Reuse immutable artifacts; no copying new archive dates or altering collector/schedules. Upload complete streams plus concise full-route and support-first reports, including unsuccessful or entirely unavailable arms.

The postponed width/covariate diagnostic remains unexecuted. Its notes: distinguish actual deployed overlay attribution from experimental candidate reasons; physical motion is not established by the saved hold/drive proxy; lead full denominators and unknown coverage. It is not part of this ensemble experiment.
