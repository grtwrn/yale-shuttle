# Independent research review requested

There is **no application candidate** in this round. Exact HEAD remains
`b574a1c800654544685a8d9f1097ad3484ac13fc`; the prior approved smoothing repair
is not changed or superseded. Controller retains its publication gates.

Review `RESULTS.md`, `PLAN.json`, `COUNTERFACTUAL_PLAN.json`, and final
`verification.json`. All scripts/results/browser overlays are local artifacts.

Please independently check:

1. Accounting of68 missing decisions as34 bus-polls/ten sources/two endpoints,
   the30 h1 versus38 h29 split, raw GPS provenance and exact connected chains.
   Fourteen outgoing decisions are after recorded departure; their current
   source cannot supply a boarding outcome at that poll.
2. Native state observation stays read-only and reproduces160496 saved wire
   rows. Every selected leading situation is moving; retained rest alone
   does not imply a missing zero is erroneous. No tracker change is proposed.
3. The artifact-only ordered arm differs from the actual current shell only
   by `ordered-transform.json`; it chooses an already-served same-bus pickup
   before the FIRST destination, for the journey join alone. It preserves
   strict zero pickup priority and does not synthesize an occurrence. Confirm
   all30 restored distributions equal their original destination distributions.
4. All4688 baseline results/ranking states reproduce exactly after ordinary
   JSON omission of undefined fields. Source inputs are causal wire data;
   `score_counterfactual.py` applies later outcome labels only afterward.
5. The30-case MAE reduction and fewer large jumps are descriptive selected
   history. Retain63523's+442.83sec absolute-error regression,61907, all
   existing outliers, and no paired coverage/WIS claim where baseline lacks
   a distribution. Zero-access results do not establish general catchability.
6. The alternative fallthrough arm changes bus identity in38 cases; its
   other-bus/lap outcomes are deliberately unmatched. Do not promote that
   arm from availability/jump counts or assign it focal bus truth.

Useful independent reproduction: `python cycle-6/verify_evidence.py` from the
repo root (use its absolute path); repeat lightweight scoring if desired.
There is no need to refit models, repeat cycles1–5, or repeat the full native
prefix merely to inspect the34 saved state records. Browser evidence covers
407 numerical comparisons total and prototype keyboard/touch/freshness
transitions. The prototype build is not an application typecheck or release.

If research checks pass, the next builder/controller should coordinate one
small shared-shell change with UX: preserve the raw pickup presentation and
use the existing correctly ordered pickup only to join its destination.
Add substantive repeated-stop/folded-route and missing-destination tests,
nonzero-access regression, both typechecks, build and actual-shell checks;
keep24 pre-departure and14 post-departure h29 cases separately visible.
Do not bundle a movement-cache, tracking, ranking or raw board-now policy change.
