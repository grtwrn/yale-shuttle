# Independent research review request: selected pickup bus and occurrence

Outcome requested: research acceptance or concrete corrections, not release
approval. No application proposal exists. HEAD is unchanged production
`d5a392f533e8684320259ff0d323a3b0da75cc50`; checkout/index clean.

Read `RESULTS.md`, `CONTRACT.md`, `PLAN.json`, current team requests and latest
UX requests. Reproduce `prepare.py`, `audit.mts`, `boundaries.mts`, the locked
`browser-contract.mjs` and `verify_evidence.py` into reviewer-owned outputs.
The scripts intentionally pin the current head/input hashes. If the controller
integrates UX meanwhile, preserve this comparator and explicitly verify any
adaptation rather than silently replacing it.

Please check:

1. Exact production numerical block/wrapper and pickupState forwarding; all
   4,688 historical decisions/traces/rankings match and no row/occurrence is
   deleted from the original evidence.
2. The projection uses the existing selected `match`/`boardable`, never future
   observations or a new selector. Client selectedAtMs and relative stopsAhead
   must not be presented as a server timestamp or persistent physical visit ID.
3. The destination-row ablation keeps aligned distributions, pickups and
   selection/wait intact. Its 742 attribution changes are synthetic outage
   sensitivity on nine source visits, not observed production incident counts.
4. Actual built-SPA DOM confirms missing-target bus/wait misattribution and
   same-bus later-visit wait misattribution; the latter has zero observed cases
   in the selected Red census. No app patch or browser injection changes
   selection. All source modules in the reused dist match current sources.
5. Raw-current identity remains separate from compatible forecast identity.
   All 38 old unlinked cases, 14 already after recorded departure, stay unknown;
   nothing maps their h29 row onto the current physical visit.
6. All 1,400 connected outcomes and the 442.827-second added-error case remain.
   No new fitting, exclusions, forecast gain or calibration claim is made.
7. The proposed ETA/UX contract covers stale/departed/future metadata clearing,
   folded-route missingness, normalization and manual boarding without
   replacing the countdown or introducing two same-vehicle buttons.

Builder verification: exact census4,688; missing-target arm4,688;13boundary
cases;8browser states; clean head/index;11frozen input hashes. First verifier
decimal-copy mistake is preserved in `.first`; both browser runs passed. No
full tests/types/build/staging/deployment claim; those are later implementation
gates. Every owned browser/context/page closed, no persistent process or new
screenshots, watcher untouched.

Next builder after acceptance: coordinate the type/helper/two shell projections
with UX consumption as one coherent tested proposal. Do not restart neighbor,
clock or service-role screens or bundle an estimator/cache repair.
