# Protected windows preserve within-route choices, but can change route ranking

Hosted [run35690856859](https://github.com/grtwrn/yale-shuttle/actions/runs/35690856859)
passed at `99df77327fbcea8be55a3d3700491862f5712c16`, against unchanged production
source `05a988194af3c376e5aa5da16682c29f797db2b2`. The plan was pinned at
`a275232` before execution. All 168 existing controls in six test files passed.
The `frontend-window-contract` artifact contains the exact summary and source
hashes. All computation ran on GitHub; no app changes or model fits occurred.

The deterministic audit called actual production functions. It found:

- 17,424 selector cases preserved the selected bus, occurrence, point,
  departed/missed-bus state, countdown-versus-boarding relation, raw-at-stop
  association and folded-route eligibility when only bounds changed.
- In 11,880 reminder cases, a protected earlier lower bound never delayed
  the same visit's leave threshold. 1,740 thresholds became earlier. These
  are synthetic combinations, not traffic-weighted frequencies or extra
  independent rider observations.
- Twelve live-adapter cases preserved the armed route and boarding visit
  after option-list reorder, including different-bus and later-same-bus
  boarding. The adapter rejected feed age at 45 seconds. Pure formatting
  tests at that age do not bypass that live freshness check.
- The prescribed counterexamples all reproduced: tightening a destination
  upper bound can promote a longer-commute route; moving its lower bound
  earlier can remove separation and restore a shorter-commute route.
  Earlier pickup low can change rank when destination arrival is unknown.
  Earlier pickup low can also turn the catch-risk warning on without
  changing the chosen bus or point.
- The separation test is strictly greater than 90 seconds. A live ranking
  change waits for 30 seconds of persistent advantage, and a reverting blip
  clears it. A new plan uses its new ranking immediately.
- A four-route example changed the collapsed list from A/B/C to D/A/B with
  every point and planned commute unchanged. Thus the change can affect
  which routes are visible, not merely the order of identical cards.

The reminder effect in `TransitMap.tsx` follows the armed route label and
boarding/alighting stops through `liveReminderInput`; it does not automatically
retarget to the first ranked route. Within that route, changed roster, point,
freshness or physical-phase evidence can still change boarding selection.
This audit held those inputs fixed and cannot certify tracking changes.

The route-ranking differences are expected behavior, not evidence that a rider
would miss a bus. They establish that fixed-visit action parity is insufficient
to claim whole-app boarding safety. Historical all-option replay or prospective
complete public-fleet scenarios are needed to measure their real prevalence and
consequences; individual logged bus-stop forecasts cannot automatically be
treated as a complete simultaneous option set.

No full React/browser/geographic plan replay, historical frequency, actual rider
miss rate, distribution calibration or deployment readiness is claimed. Bounds
alone do not define a coherent replacement for the existing 50-quantile arrays.
The frozen physical/support/accuracy gates still apply; this diagnostic does not
select a K or excuse any failing candidate.
