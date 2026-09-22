# Synthetic page-version continuity policy v1

Pinned September22,2026 before September23–29 observations. This supplements
selection protocol v1.1 at6dfbe4f and decoder contract a286c5b. It changes no
scenario, start, model, fit, outcome or frontend decision rule. No prospective
capture is processed by this document.

The public recorder cannot prove there was no unobserved deployment and rollback
between its health/bundle requests. For this predefined synthetic observer,
adopt the explicit assumption that the latest completely observed, exactly
proven frontend remains the page version until contrary release evidence is
observed. This is a conditional replay of a known version, not reconstruction
of every real rider's page load. Always retain the decoder's
`strictIdentityKnown=false` and `assumptionRequired=true` in results.

At the selected initial fleet receipt, accept only the decoder's unique
`candidate_under_continuity_assumption` with a complete verified HTML/resource
group, a source proof already known, safe capture clocks and no intervening
unresolved health/build/resource failure. The only currently supported tree is
39e7e9738975f45dfb5c443cc99961a39e9aa4ef, proven for source05a988194af3c376e5aa5da16682c29f797db2b2
by run35693019507; proofKnownAt is06:01:55UTC on September22. Record all hashes,
bundle observation, proof, prior health and causal attribution times. Do not
use a later bracket, retry or proof to make an earlier initial receipt eligible.

Missing, conflicting, invalidated, clock-unsafe or unproven version evidence at
that initial receipt makes the episode version-unavailable. Retain the episode
and its reason; do not seek a later fleet response or older supported release.
Every invalidation must shadow previously supported mappings. In particular,
dropping unknown entries from a release list and then selecting its last known
version is incorrect. An adapter must gate the exact initial receipt or include
explicit unknown/invalidation entries with their real knowledge time.

Once an episode has a supported initial page version, keep that frontend fixed
for its45-minute lifetime, matching the separately pinned no-reload policy.
Later health/build changes remain input evidence, not a request to switch the
loaded page. Server forecast/model versions remain the actually served ones;
frontend continuity says nothing about model validity, raw alignment or labels.

All baseline/candidate arms use the same version rule, independently of width,
accuracy, route choice or availability of a favorable candidate. Unknown-version
episodes count in full denominators. A new different bundle needs a separate
exact source mapping and parity gate before use, with genuine proof knowledge
time; it never inherits this initial mapping. No scoring is authorized here.

Report both the number of assumption-qualified episodes and the number without
strict contemporary version proof (the latter includes every qualified episode).
Do not label the conditional group as a verified reconstruction of live users.
Capture failures, unknown versions and missing model exports remain different
states. This policy cannot clear physical-pickup barriers or support a claim
that a rider could definitely board.
