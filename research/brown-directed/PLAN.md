# Brown-only directed-leg experiment: parity gates before scores

Pinned before implementation. Research only: existing raw35677536788 and
canonical35684356219 ending September20, with clock controls35687958726. No new
dates, production changes, new labels, guard sweep, or outcome-selected scope.
Both original frozenK8 and rollingK5 remain unselected. Option A (checkpoint-only
phase provenance) stays a documented proposal and is not implemented here.

Use EXACT directed-leg adapter from commitc80ab5ff32f75cab078f61093e3c27c70923c54e,
guard.ts SHA256472c2e7a5babebcb3e2d31736aa4d3ddb013d11bb73ebd157d3daf65719719f6,
but invoke its prepare only for Brown route19. Other routes use the unmodified
network/reducer. Preserve all existing conditions: same provider/route/name,
strict chronology,gap<=60s, existing current/retained leg, both projections<=75m,
forward move>8m,25m/s plus16m bound, repeated fixes only retain a valid certificate,
endpoint-only replacement with no endpoint rewind, baseline recovery on failure.
No special correction targeting a named outcome or stop.

Run identical full archived raw polls through baseline and Brown-only adapter,
using production detector/departure reducers, all-route canonical topology,
actual chronological emission knownAt and no EOF completion. Persist both
complete event/visit streams, guard decisions, physical/anchor difference
ledgers and raw hashes before downstream work.

Gates, in order, ALL required before any aggregate model scoring:

1. Baseline semantic visit stream reproduces canonical exactly; ignore only
   global synthetic ID and replay audit fields. Every non-Brown detector/visit/
   leg emission is byte-identical, with actual emission poll attached. Compare
   non-Brown features exactly in the later feature stage as well.
2. Brown physical-event multiset matches EXACTLY on bus name, provider ID,
   canonical route/stop occurrence, actual arrival/departure and actual knownAt.
   Include unresolved/pinned visits explicitly. A physical event is any visit
   with pinned_at OR arrived_at OR departed_at nonnull. Only truly unpinned
   null-arrival/null-departure bookkeeping passes are excluded from this physical
   identity gate, and every exclusion remains in the ledger. Do not pair by
   anchor time alone, round timestamps or drop duplicate physical occurrences.
   Record anchor/pin/closest/outcome/how changes separately; eligibility changes
   also block the later path/source gate.
3. Reconstruct causal origins/release/phase features with original45min source
   and<=15s freshness clocks and10min warmup. Source departure/knownAt multisets
   must match; phase/release differences are expected but must be causal and
   explicit. No new departure from an unpinned pass. Future raw-prefix deletion
   at existing fitting cutoffs and named Brown anomaly edges leaves earlier
   emissions/features unchanged. Route/provider/name gaps remain unavailable.
4. At the original frozen and daily rolling cutoffs, require semantic Brown
   training-path and fitted-duration/support parity under original90min path
   cap,120min weighting,12 effective paths/3 material dates, weekday/weekend
   split and q10/q90. Compare source/target physical identity and duration, not
   unstable global emission ordinals. Preserve the original models/fit outputs;
   no tuning or refitting around a discrepancy. If candidate reconstruction
   adds/removes a training path or changes its fit, HALT before scoring.
5. Original two-lead controls, raw hashes, exact physical labels/truth, deployed
   baseline and original projection identity remain identical. Persist all
   candidate forecasts before attaching those fixed labels.

A physical/knownAt/path/fit discrepancy means STOP without scores. Write the
first and largest exact discrepancies and route/date/stop denominators; do not
relax the gate, switch to candidate labels, adopt a new input cohort or pick only
the exact named case. Staged hosted runs may complete early evidence gates first;
passing them does not authorize bypassing the remaining gates.

ONLY IF every gate passes: compare original and Brown-directed variants for
both leads (four arms) on all labeled Brown rows and the same all-arm changed
union, plus fixed original-lead union. Unsupported groups use exact deployed
fallback; keep whole-group support/countdown<=60s and all target groups/waits.
Keep eta=deployed.eta, low=min(deployed.low,candidate.low,deployed.eta),
high=max(deployed.eta,candidate.high). No coherent distribution export.

Reuse every raw/printed0,5,15,30s/action/handoff/order/tail and full-route support
gate. Common point5–20min arming, walks1/3/5/10min,30s buffer,response0/30s;
report additional waiting and censoring with same-policy pairs and no actual
rider-miss claim. Require original action/point identity. All prior promotion
thresholds and unopened-date support remain; no production promotion here.
Heavy replay/tests/fitting/scoring occur on GitHub only.
