# Highway-context quality study — frozen before ETA scoring

This study changes only the research speed-rejection clause. It is an isolated branch from ebf720ce40cf0f821285ad35f56327715674f164, and leaves canonical run35684356219 unchanged. September17–20 outcomes are reused development data. No September21+ input, production deployment, local replay, watcher change or schedule change is authorized by this study.

## Pinned inputs

- Raw positions: k-sweep run35677536788, SHA2563990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9. Original prediction bytes remain SHA2565bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de.
- Canonical features, unscored deployed/candidate rows, reconstructed visits, fixed wait map and original labels: run35684356219. Feature rows and occurrence/origin/release-latch evidence are reused byte-for-byte, not recomputed from expanded labels.
- Canonical topology SHA256eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc.
- Occurrence-indexed published-leg geometry: route-context run35686813146, geometry.json SHA256a51695be4548c855af0de70d22a41b72e007e5b78a16f5cbabb60e732d82f477. Bridged/unavailable legs remain unavailable.
- CTDOT I-91/I-95 mainline snapshot and manifest already frozen in research/canonical-route-context/data; original bytes SHA256aaeccc535103efcbc23ac092f544894a506167224b160d47ae1a7118ef2dd2fa. The2025 reference geometry is context, not a speed-limit assertion.

## Three fixed policies

1. `original22`: reproduce the canonical research quality rule exactly.
2. `highway25` (primary): retain22m/s everywhere, except the narrow clause below.
3. `highway50` (prespecified sensitivity): identical to highway25 except mainline proximity50m instead of25m. It is not a model-selection alternative; report it regardless of ETA gains.

For an adjacent GPS pair rejected solely for speed under original22, the highway clause can remove that speed condition only when ALL are true:

- Both fixes retain the same explicit, nonmissing provider ID and route ID; that route is Green9 or Purple10.
- Positive elapsed collection time, at most the existing60-second gap limit, and original planar speed >22m/s and <=35m/s. Original milliseconds-to-seconds and latitude-scaled distance implementation remain unchanged. In particular, the observed0.407-second extreme-speed burst remains rejected because its speed exceeds35m/s.
- Five fixed chord positions at0%,25%,50%,75%,100% are EACH within the policy's25m/50m mainline distance and within75m of that route's predeclared intercampus-leg geometry. Use the already validated local metre projection and exact segment projection. Distances are inclusive at the boundary.
- Green's transfer from-indices are10,11,19,20; Purple's are3,4,13,14. Distances are to this declared route's union of available transfer-leg segments, not to an arbitrary route. Overlapping direction/occurrence candidates are not forcibly resolved. No direction, smoothing or speed-limit inference is added to admission.

No non-speed condition is removed. Route changes, provider changes/contention, duplicate/conflicting timestamps, missing boundary observations and every existing validity/chronology condition continue to reject using the existing screen's exact semantics. At interval level, admission solely by the clause means original22 rejected, the revised policy passed, and every original failing edge was a newly permitted speed-only edge. Count combinations where an allowed speed edge exists but another condition still rejects.

## Causality and implementation boundaries

The clause uses only the two edge endpoints and pinned static geometry. It never uses neighboring/future fixes, smoothed speed, model error, labels or the eventual next stop. Training visits must have actual causal emission known before cutoff, and raw observations are physically restricted to collected_at < cutoff before a training quality instance is built. Keep the full calendar-day embargo: frozen before September16 ET midnight; refreshed history before the previous ET midnight. No feature or live anchor can read an edge whose endpoint exceeds its original forecast-asof, because the original causal feature artifact is immutable and the new clause is used only for historical path quality and post-forecast outcome evaluation.

Retain fixed major waits, all seven K values1,2,3,5,8,10,15, explicit occurrence indices, source-origin/release latches, whole-group support/expiry,12 effective paths and3 materially weighted dates,120-minute circular-clock weighting, weekday/weekend split, Red45-minute and other90-minute training caps,45-minute outcome horizon, next physical pickup only, close valid target and matching forward occurrence path. Every model/cutoff/policy has an independent cache.

The rider-action replay has its own22m/s edge rejection in Connectivity. Apply the exact same highway clause there for policy consistency, while preserving its separate boundary rules, identical-export deduplication, conflicting-boundary handling, continuity through departure and all arming/action/rendering rules. Action-time features remain unchanged; full future pickup/departure data are used only as evaluation outcomes. This does not expand the allowed physics clause or alter an action decision rule.

## Fitting, labels and comparisons

Persist all fourteen frozen/refreshed candidate forecasts for a policy before attaching that policy's outcomes. Preserve the exact deployed checkpoint overlay/fallback from each original unscored row. Original22 must reproduce every original candidate, evidence field, fallback reason and physical label before any new score is accepted. Non-Green/Purple routes must match across all three policies for paths, candidates and labels.

Within each policy, all candidates and deployed baseline use an identical labelled cohort. Report all generated/resolved/labelled/changed snapshots, physical visits, actual source trips, dates and exclusion reasons per route. Also report separately:

- Original canonical cohort: every policy on these same original labels; compare refitted arms with both deployed and original22 same-K arms.
- Newly added labels: all policy arms and deployed on this addition cohort, with original rejection reason and newly permitted quality intervals. Original-label exclusions or changed physical labels are asserted absent; any exception aborts scoring.
- Highway25/highway50 common cohort and original/frozen/refreshed changed-arm unions, with identical denominators for each paired comparison. Report sensitivity-only additions separately. Do not pick the sensitivity by its scores.
- Accepted training paths newly admitted solely by each policy, grouped by route/K/wait/target/source/date, plus remaining quality/support exclusions.

Report width, MAE, coverage, early misses(any/>30/>60/>120s), late misses, severe new early visits, false-now, stop ordering and same-physical-pickup handoffs. Keep existing hypothetical1/3/5/10-minute walks,30-second buffer,0/30-second response delay, point/raw-lower/rendered-lower policies, exact common deployed arming and renderer parity. Report action availability and newly missed/rescued fixed physical visits; these are simulations, not measured rider behavior.

## Hosted gates and stopping rules

Before ETA scoring: fixtures for speed22/35 boundaries, road25/50 and declared-route75 boundaries, other-route refusal, wrong route/provider, temporal gaps, conflicting duplicates, boundary bracketing, and non-rescue of the shared burst; projection parity; unchanged original22 and unchanged non-target-route screens; edge/policy nesting(original subset primary subset sensitivity); physical future-prefix deletion checks of the new clause/training paths; immutable feature/input digests. Stop if those fail. Every comparison result retains the pinned plan/hash and policy definition.

No promotion follows from this reused-date study. Existing accuracy/early-tail/action criteria and subsequent uninspected-date support gates still apply. Any beneficial window result is provisional until independently verified; road proximity alone is not proof of a valid observation or legal speed.
