# Brown handoff audit: frozen input and scope

This diagnostic retains BOTH Brown window-only leads, frozenK8 and rollingK5,
without choosing a winner. Input is window-only run35685527686 at379ea69,
canonical reconstruction35684356219 at3f7b5e9, and unchanged raw artifact
35677536788. Only existing September17–20 forecasts/outcomes are read. No new
dates, fitting, smoothing, thresholds, model changes or deployment.

Classify every existing same-physical-visit handoff for both arms, preserving
the original audit's consecutive-snapshot<=30s rule and excluded/gap counts.
Use causal feature clocks and completed reducer visits with known_at<=asof to
distinguish confirmed wait departure, stale/missing tracking evidence, group
countdown expiry, actual source-origin switches, and other explicit causes.
Do not call a release latch or phase/progress change a confirmed departure
without recorded confirmation. A source removed by the existing45-minute
feature horizon is age expiry, not evidence of missing GPS. Report unknown
causes explicitly rather than inventing a narrative.

Compute absolute predicted arrival times before/after every transition and
their signed jumps, then subtract the deployed absolute-time jump to identify
the extra estimator movement. No arbitrary threshold defines a bad jump.
Report raw GPS/provider/route continuity between snapshots and through observed
pickup departure, freshest fixes, phase/index/anchor/origin changes and causal
visit emissions. Future departure evidence is used only for retrospective
continuity, never to explain what the model knew at the transition.

Retain record-level cases and show chronological first and largest additional
bound movement per cause, with exact times and neighbouring route occurrences.
Require transition identity/count/parity with the previous summary and unchanged
byte hashes for prior forecasts, labels, scores, action results and raw inputs.
Focused classification fixtures and all diagnostics run only on GitHub.

After documenting causes, write a prospective protocol retaining both leads,
their complete existing groups, unchanged parameters/gates and chronological
training/knowledge cutoffs. Any future transition experiment must be motivated
by the audit, fixed before later unopened outcomes, and evaluated separately.
