# Follow-up diagnostic, after the prespecified result

The first run (35651990480, source 95645f6) produced no replacements for the full target groups. K10 limited to ten downstream pickups replaced 201 Blue Day forecasts (31 visits), but coverage fell from 72.6% to 38.7% on that changed subset. The frozen 45-minute source-to-target cap could truncate Blue's longer trips, especially for targets reached after wrapping around the loop.

Before inspecting any further results: rerun the SAME four arms with the training path cap increased to 90 minutes. Keep the training cutoff, weekend split, raw GPS continuity requirements, support thresholds, handoff rules, 60-second group fallback, and test labels/cohort unchanged. This tests whether the borrowed Red journey cap causes unavailable support or optimistic estimates. It is a post-result sensitivity analysis, not another holdout and not a candidate authorized for deployment.

Audit physical wait durations and complete source-to-target durations for the worst misses; count held-out journeys exceeding 45 minutes. Report per-stop, per-day, and clustered bus/source departure counts; these correlated snapshots cannot be treated as independent. Audit adjacent-target ordering, fallback/handoff discontinuities, and the delay scenario. Preserve the original run's result and headline alongside this diagnostic.

Outcome-matching audit: explicitly exclude logged forecasts a full lap or more ahead when matching the next physical arrival. The candidate replacement guard already excluded them; this additionally protects fallback-only totals. The final audit must reproduce the original changed-subset comparisons exactly.
