# Canonical occurrence study, fixed before scoring

This diagnostic repairs the research coordinate system; it changes no
production model. Inputs are the immutable public fleet artifact from run
35677536788, September3–20. September17–20 are reused development outcomes,
not a fresh holdout. The code base is61bb3d3; production comparator is the
86cb499 checkpoint overlay on contemporaneously recorded fallback forecasts.

Serialize one canonical runtime topology from TransitNetwork.build, preserving
publishedStops and the original topology hash. Rebuilding it must leave every
occurrence index unchanged. Reconstruct all visits with the current production
reducer, actual causal emission timestamps and future-prefix deletion checks.
Never translate stored indices with first indexOf, deduplicate repeated stops,
or close unfinished visits at archive EOF.

Classify major waits once from canonical visits known before September16
00:00ET: completed nongap passed/stopped visits, at least30 observations on
3 dates, standing-time p75 at least180seconds. Freeze those occurrence indices
for every arm. Keep the seven K values1,2,3,5,8,10,15, existing120-minute circular
clock weighting, weekday/weekend split,12 effective paths/3 material dates,
whole-group support and countdown expiry. Red keeps its45-minute path cap,
other routes90minutes. Frozen control uses pre-September16 history; daily
refresh uses history known before the previous ET midnight (full-day embargo).

Regenerate raw causal features and origins/release latches on that same
topology and wait map. Unique physical targets retain the prior unambiguous
logged-hop anchor inference for control parity. For repeated targets, both
fresh causal phase and nearest anchors must imply the same canonical target
occurrence from the logged hop count. Any disagreement is ambiguous and stays
on the deployed fallback. The historical from_stop_id is not a client anchor;
it and future outcomes never resolve an ambiguity. Record every reason and
retain raw input bytes unchanged. No wholesale route quarantine is applied.

IMPORTANT COHORT CHANGE: labels are reconstructed canonical physical visits,
not the old stored-label artifact. After freezing forecasts, find the next
physical visit to the target. Its canonical occurrence must match the causal
forecast resolution. Do not skip an earlier physical visit to label a later
occurrence; count intervening visits explicitly. Require close nongap targets,
same-route/same-provider continuous GPS, resolved departure and matching
forward occurrence progress. All candidates and the deployed comparator use
the identical reconstructed-label cohort. Report matches/disagreements with
old stored labels descriptively; do not use them to choose outcomes.

Keep candidate distributions occurrence-indexed, round wire seconds exactly
like production, count actual candidate source trips, and audit introduction
of early misses/false-now/order reversals plus entry, release and daily-refit
jumps for the same physical pickup. Report each route's generated, ambiguous,
resolved, labelled, changed and action-replay coverage; sparse logs are not a
fleet census. Run unchanged hypothetical1/3/5/10-minute walks,30-second buffer
and0/30-second response delay, including rendered lower-bound parity checks.
All promotion gates in useful-windows/PLAN.md still apply; no promotion from
this study. Archive coverage and missing-history limitations remain explicit.

Control checks: unchanged raw/training hashes; unique-route feature agreement
excluding deliberately recomputed wait latches; exact deployed-fallback join;
same-model unique-target parity with the original numeric worker; frozen and
rolling equivalence on September17; fixed-prefix invariance; fixtures for
repeated target ambiguity, source/target occurrence separation, whole-group
fallback and refusing intervening physical pickup visits. Heavy work runs on
GitHub hosted runners only.
