# Independent review request: pickup smoothing occurrence identity

Review the current source diff over6220b860a69f5567557926f41de59ed1af72d2f8, `RESULTS.md`, and **traversal-guard/FINAL_STATUS.md**. Final source is the traversal guard; root-level cycle5 output is the rejected exact-hop guard, whose destabilizing regressions are preserved.

Please independently check:

1. A zero-hop already-arrived row remains exact zero, including all50 quantiles and legacy contaminated memory. Both current and following rows bypass incorrect h29/0 and h58/29 aliases, with ordinary stop146 and Winchester evidence.
2. The ring-derived traversal comparison preserves valid within-traversal forward-hop smoothing and allows legitimate ETA increases; ambiguity/gaps/hop increases use fresh estimates, with no cap or dropped arrival. Consider boundaries h=N versus N+1, reverse hypothesis changes, repeated polls and current checkpoint restoration. Other routes remain outside the existing Winchester smoothing gate.
3. Reproduction uses current HEAD baseline release ON in both arms, continuous raw prefixes and identical causal calibration, not old release OFF or an unprimed fresh-process checkpoint. Generated baseline sources are git-HEAD copies with only imports rewritten. Native candidate source hashes must match the frozen plan/snapshot; existing movement-cache behavior is deliberately unchanged.
4. Final broad150,020 target forecasts, both-occurrence availability,46,790 position beliefs and302 full-server comparisons; exact archived release-ON baseline parity; preserved first/second connected labels and legitimate regressions. Final completion/counts are in FINAL_STATUS. No fresh-holdout, calibrated interval or complete-ETA accuracy gain claim.
5.149 newly available journeys, no availability losses, and exact identities when matching1,382 connected outcomes. All1,240 already-available paired journeys retain the same point. Newly restored full forecasts sometimes score worse than old planned-ride fallback (largest+228.51sec absolute error); review these retained cases and distinguish the selected/hypothetical/model-walk scope from actual riders.
6. Remaining68 raw-at-stop/no-modeled-zero-board cases and countdown/catchable-bus distinction are deferred, documented coordination needs. No planner/display/wire changes are hidden here.

Final verification script under the shared lock runs the full suite, both types, Vite, continuous fleet replay, decision replay, bounded actual-shell browser parity and full paired replay. Scorers run read-only. Browser uses tester helper and intercepted network, takes no screenshots and closes every resource. Controller retains staging/CI/commit/PR/merge/deployment ownership; nothing has been published by this builder.
