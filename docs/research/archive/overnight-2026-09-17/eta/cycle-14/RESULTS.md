# Cache determinism holds across routes; complete Red outcomes change little

**Research only. No application patch or release candidate.** HEAD remains
`98e535b99649e74ca599d2e33bcfdc46df83d30d` (PR292); checkout and index are clean.
The fixed diagnostic is the single canonical-tenth movement-kernel change
independently reviewed in cycle13. No parameter, mixture threshold, fit,
exclusion or ETA cap was changed or searched. This round extends that evidence
with complete Red outcomes and a multiple-route restart fixture. It does not
establish all-route outcome performance or a rider decision benefit.

## Current baseline and causal inputs

`PLAN.json` froze the work before evaluation. Each arm ran in a separate fresh
Node process over the same 16,253 original Red observation frames and original
bus order. Both use current production source, release ON, pre-September-14
marginal tables, the pre-September-10 release fit, and the already-declared
causal fit refresh at September17 13:14:00.913 ET. No fit was rerun. The later
September17 afternoon is reused evaluation, never a fresh holdout. Original
raw coordinates are recorded; collector clock fields in these frames are
reconstructed, not recovered original receipt/publication clocks.

The target-scoped real estimator produced 150,020 rows per arm, with 151
full-ServerEta target parity checks per arm. Current baseline reproduces all
150,020 archived release-ON target values exactly after the existing rider
adapter's nonnegative normalization. This corroborates the comparator; the
old release-OFF arm is never used. Raw output bounds are retained unmodified.

Important scope: these inputs contain **Red only**. Current kernel caching is
process-global, so another route's first call can change its warm kernels.
This complete Red result is not a replay of the original full-fleet server
process. The next outcome round must preserve full-fleet input order in both
arms. No Red-only claim substitutes for that check.

## Connected outcomes and availability

Both occurrences are explicitly retained. Pairing uses bus/time/target and
first-versus-second future traversal (`hops > 29`), while retaining both arms'
original hop counts. All202 changed hop counts differ by exactly one hop
(134increases/68decreases), with no changed traversal
classification, lost or gained forecast in the 150,020 pairs. The first-score
contract treats `hops == 29` as the first future occurrence; the second audit
continues to report all 3,251 such rows separately as its boundary limitation.
There are 93,380 first and 56,640 second rows.

The separate verifier checks 327 connected source-to-target journey uses,
6,674 exact historical leg uses and 3,309 checkpoint truths directly against
the read-only database. These share source/target visits; they are not
independent observations. Exact prior source/target chains and missingness
remain. Second occurrence has 801 paired checkpoints and 318 absent in both
arms. No missing journey was bridged or converted to a departure.

| Fixed checkpoint cohort | Rows | MAE current → diagnostic, sec | WIS current → diagnostic | Early / late misses current → diagnostic |
|---|---:|---:|---:|---|
| First, earlier evaluation | 1,908 | 129.117 → 129.117 | 91.142 → 91.131 | 56 / 61 → 56 / 61 |
| First, reused afternoon | 600 | 106.363 → 106.430 | 79.719 → 79.740 | 5 / 13 → 5 / 13 |
| Second, both periods | 801 | 206.188 → 206.154 | 145.483 → 145.483 | 23 / 16 → 23 / 16 |

Full source/target/checkpoint, date, passed/stopped endpoint, p90, width and
miss summaries remain in the three `full-*-score/review.json` files. Here
“early” means the bus arrived before the displayed lower bound, and “late”
means after the upper bound. These are measured misses, not nominal coverage,
normality or calibrated on-time probabilities. There is no meaningful typical
ETA gain in this slice.

First-occurrence upward absolute-arrival jumps over60sec remain 5 in earlier
evaluation and 3 in the reused afternoon. Downward jumps change 59→61 and
19→20. An ETA is allowed to increase when evidence changes. Largest fixed
checkpoint error regression is20.954sec (source67419, Division, approach−600).
All previously audited legitimate cases in this time window remain:64318,
58224,65347,67957,68304. Earlier48550 and six September15 follower cases lie
outside this raw replay; their old audits/data remain, without a new validation
claim. No historical record was changed. The older442.827sec trip-join
regression and38unresolved pickup decisions belong to unchanged earlier
artifacts; this kernel experiment does not resolve them.

## Full trajectories, tail changes and route progress

Supplemental all-poll scoring uses the same exact connected chains and
source/previous-target boundaries as the fixed-checkpoint scorer. Shared
source contexts are deduplicated by physical bus/target-visit/poll/occurrence:
115,088 source contexts become83,757 poll-targets (59,882first/23,875second).
This weights long observed journeys more heavily; it is descriptive and does
not replace the checkpoint summaries. First MAE128.249→128.292sec,
second213.346→213.360sec; WIS likewise changes slightly upward. First tail
status has one early miss resolved, one introduced and one late introduced;
second has one early miss introduced. Largest point regression across these
polls is39.299sec (source59364→target59826). Ten largest such rows and the
large connected tail are retained with exact endpoint/source records in
`change-audit.json`; no exclusion is supported.

All raw Red pairs contain five bound changes over60sec. One falls inside the
connected pre-arrival score: #316's second Rosenkranz forecast at1789660280391
has upper bound7793.529→7860.147sec, a66.618sec increase. Its exact target66228
arrives3675.304sec later, inside both windows; its median changes by1.008sec.

The other four are two current/following pairs just after the detector's
arrival label. For #309 at1789596500179, target61959 was recorded10.034sec
earlier; the first upper bound changes8.093→3761.302sec. For #300 at
1789670426971, target67028 was recorded15.077sec earlier; high13.034→3755.555sec.
Both following rows also change. These are **not removed**: all raw values and
nearby target records remain in `all-large-tail-target-context.json`. They do
not meet the existing pre-arrival scorer's endpoint window. Nearby timestamps
are not substituted as new truth labels. The existing position-mixture gate
can put mass on a following lap; this round does not alter that gate or
establish that these rider-facing tails are harmless.

Among46,790 tracking rows, lead differs63times across55short windows and
rest-stop attribution differs36times across4windows. Rested/rest-origin
fields remain equal. Both arms have zero numerical backward lead transitions
under the declared modulo29 audit (delta>14 within60sec); that is a bounded
trajectory check, not proof of all possible forward behavior. Raw negative
low bounds are137current/136diagnostic; every value remains saved. They are a
separate pre-existing transport/display question, not repaired or hidden here.

## Eight-route restart and order fixture

`FIXTURE_PLAN.json` declares all40polls of the repository's actual server
fixture, covering route IDs1,2,3,8,9,10,15,19. Routes9/10 include repeated stop
occurrences. Each arm is built independently from the same current source.
For each arm run normal and reversed incoming bus order in fresh processes,
then restore its own checkpoints at polls10,20,30 in three additional fresh
processes. Each checkpoint restores15vehicles.

Wire comparison joins route/bus/stop/hops and associated50-quantile vector;
complete ModelEntry maps/typed arrays and seenAt are explicitly serialized and
sorted. Normal versus reversed input is exactly equal for40/40polls in both
arms (the existing server ordering already handles this fixture).

Across all three restart windows the diagnostic matches60/60complete states
and physical wires, comprising35,066 row comparisons. Current code matches
0/60. It changes2,293matched rows and13,085quantile vectors, and123hop-qualified
keys are replaced by123others. Those replacements are changes in occurrence
keys, **not a demonstrated loss of123total arrivals**. All detailed route and
window counts remain in `fixture-comparison.json`. This is functional
repeatability with a fixed captured payload, not chronological all-route
calibration or connected ETA accuracy. Counts from overlapping restart
windows are repeated comparisons, not independent trips.

## Prepared next full-fleet input

Read-only inventory found12routes in the preserved complete-outcome DB.
`export-all-route.mts` uses the existing real collector reducers to reconstruct
20,199fleet polls from197,354raw rows, preserving all known lap-age fields.
`verify_export.py` checks every fresh bus row exactly against the original
coordinate/time/name/id/route/heading/last-stop tuple, with zero missing or
extra rows, and rechecks the unchanged DB hash. Carried stale buses remain in
the export and the estimator must apply its normal freshness rules.

Files: `all-route-raw-frames.jsonl`, `all-route-export-verification.json`,
`all-route-inventory.json`, `ALL_ROUTE_PREPARATION.json`, and
`all-route-topology.json`. The latter records published versus actual repaired
network sequences and repeated-stop IDs; future outcome matching must use
correct positions, including repaired routes8/9/10, without deduplicating stops. The input
is already extracted: do not repeat it merely because the next agent is new.
No all-route outcome replay or all-route accuracy claim was made this round.

At the original16,253Red poll clocks, the export has the same46,790Red bus
rows and availability. Only the intentionally expanded lap maps differ;
projecting back to original keys11/121 makes every row exactly identical.
`compare_export_red.py` verifies this. Future paired arms must share the same
expanded input; differences versus the old Red-only run are not cache effects.

## Commands and gates

Run TS/Node commands from the assigned checkout's `services/shuttle-v2`.
Let `O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-14`
and `L=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`.
These are exact executed command forms (with paths expanded in logs/tool calls):

```sh
flock -w 900 "$L" bash "$O/run.sh"
python3 "$O/pair_score.py"
flock -w 900 "$L" bash "$O/run-fixture.sh"
python3 "$O/compare_fixture.py"
python3 "$O/verify.py"
python3 "$O/longitudinal.py"
python3 "$O/audit_changes.py"
python3 "$O/tail_context.py"
flock -w 900 "$L" env TZ=America/New_York REPLAY_DB=/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db ./node_modules/.bin/tsx "$O/export-all-route.mts"
python3 "$O/verify_export.py"
python3 "$O/compare_export_red.py"
python3 "$O/finish.py"
env TZ=America/New_York REPLAY_DB=/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db ./node_modules/.bin/tsx "$O/export-topology.mts"
```

All completed successfully. No application source was changed, so no new app
unit/type/Vite/full-suite/browser/staging/CI/deployment gate is claimed. No
coefficient fit, dependency installation, screenshot, historical write or
watcher change. No command altered branches, HEAD, commits, PRs, publication,
controller files or the other team's artifacts. Build scripts make exactly
one artifact-only source substitution per canonical bundle. All replay/score
outputs remain in this directory; input paths are fixed read-only archives.
Copy/reroute this directory for reproduction to preserve builder evidence.

## Next bounded work

Independently review this slice, especially occurrence joins, baseline parity,
exact chains, the post-arrival tail cases and the scope of the eight-route
fixture. Then replay a predeclared bounded full-fleet slice across all12routes
using the saved export and fixed diagnostic. Preserve input order, causal
calibration, repaired/repeated-stop positions, connected first and following
outcomes, missingness, forward progress, tails and rider decisions. The cache
repair's justification is reproducibility; do not market the near-zero Red
score changes as better ETA accuracy. No source integration until that
remaining scope and independent review support a coherent proposal.

Final integrity: exactHEAD/cleanindex/source hashes/bundle substitutions verified.
Shared image census at finish: 297files/14058930bytes; no ETA images added. All owned command sessions completed.
