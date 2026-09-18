# Captured stop signals do not establish a board-now forecast

This is a provenance audit, not an ETA accuracy comparison or release proposal.
Current checkout/base is `8aa67bd7f3883598f9458d825d97a52cbc004e0f` (PR291).
The combined pickup identity consumer has a separate UX review; it is not
modified or certified by this report. Cycle12's interrupted review remains
incomplete; its already-saved outcome evidence was not rerun or relabeled approved.

The raw “at stop” signal is present in actual watcher samples around five of
the nine selected source visits. It can persist after recorded departure and
can disappear and return during a pre-departure excursion. These findings do
not support treating the signal as proof of stationary position, open doors,
or a current zero-second modeled pickup. The current walking caution remains
appropriate. No tracking, selection or estimator change is proposed.

## Inputs and receipt contract

`PLAN.json` freezes the exact 38 outgoing decisions from cycle6: 19 bus-polls,
nine source visits, two destinations per poll, on previously inspected dates.
Five immutable watcher chunks were scanned, with windows from each pin minus
60 seconds to recorded departure plus 90 seconds. Both existing Red and
rotation streams were read without changing their daemon or files. Only bus
fields, sample time, response-age clock and original file/line provenance are
exported. DOM text and unrelated fields are not exported.

The watcher's response handler reads the body then records `feedAt=Date.now()`;
the sample stores `feedAgeMs=now-feedAt`. Thus `sampleAt-feedAgeMs` recovers
that handler clock, not the bus's collection time or the server's first
publication time. The sample's own `now` is captured before awaiting DOM text;
a response can update while that await runs. We use the paired clock fields,
not an assumed fixed delay. Successive sampled responses bracket observed
state changes but can omit intermediate polls. They cannot identify the exact
first publication. `runner.mjs` contains this contract at lines40 and81.

When `observed_at` exists, collection identity must match exactly, along with
bus ID/name, route, coordinates and heading. Without it, all matching positions
and movement clocks in the preceding120seconds remain candidates. A unique
candidate under that contract is compatibility, not proof. No nearest-time
assignment or retrospective target error is used to select a frame.

## Coverage and verification

| Evidence | Count |
|---|---:|
| Original samples scanned | 4,736 |
| Whitelisted samples in source windows | 487 |
| Source visits with retained samples | 5 / 9 |
| Exact collection matches in those windows | 130 |
| Exact collection matches at the 38 decision timestamps | 0 / 38 |
| Decisions with a unique compatible older sample | 8 / 38 |
| Decisions with ambiguous compatible samples only | 14 / 38 |
| Decisions with no compatible sampled response | 16 / 38 |
| Decisions with a source-stop signal within ±15sec receipt time | 26 / 38 |
| Archived server ETA snapshots | 0 |

The 130 exact matches are surrounding samples for source65347, not the selected
missing-journey poll itself. All agree with the original read-only database
on bus, route, GPS, heading and upstream last stop. All reproduced collector
fields agree except lap age:70 samples have1–3second differences. The server
serializes lap ages using its response clock while reconstructed frames use
the collection clock; this is consistent with that difference. It is not a
new ETA defect or demonstrated cause of the large missing-journey discrepancy.

The four uncovered visits are60836,61538,61907and63523. Neither watcher stream
has any sample in their windows. Both retained streams have an approximately
22.9hour gap enclosing them (82,317–82,323seconds), so their absence is a capture
coverage limit, not four clean transitions or missing bus evidence. The gap
falls on historical dates; this audit makes no claim about the currently
running watcher's health. Exact bounds are in `coverage-gaps.json`.

`verify_receipts.py` independently rereads every original sample and recomputes
all487 candidate sets without importing the audit. It checks130 exact raw DB
records, all38 retained decisions,12 frozen input hashes, all1,400 prior
connected outcomes and the exact older442.82701916224846second regression.
Every original dataset and application file remains unchanged.

## Two useful transition facts

All five captured source visits have actual at-stop responses after the
retrospective recorded departure. The latest such receipts range from roughly
6 to25seconds after that departure. These are receipt times: older samples
without `observed_at` do not prove a fresh GPS collection after departure.
At source65347, explicit collection timestamps do prove that the at-stop flag
remains present at departure+4.975,+9.990and+15.137seconds. The flag describes
proximity to a stop after dwelling, not immobility. Source inspection agrees:
`Collector.updateLivePositions` gates it on nearest-stop residence and radius,
while `last_moved_at` separately reports movement.

For source65347 (#309, Winchester), actual timestamps also show a pre-departure
excursion: the captured position moves about95m south from its previous point,
loses the at-stop flag, then returns and regains the same pinned clock. The
rotation stream sees off-stop collection at14:58:22.924UTC and returned at-stop
collection at14:58:32.906UTC, before the recorded14:59:12.981departure. The
selected missing-journey poll14:58:17.847falls between captured collections.
This is useful evidence of the maneuver and unchanged collector clock, not a
same-poll observation of server belief. Source58224 also has a captured
pre-departure off/on transition; older timestamps remain ambiguous there.

The original warm server replay and its observed native states remain the
source for the modeled outgoing position. The watcher did not store
`server_eta`, so this audit cannot claim to reconstruct live production's full
belief, identify its first disagreement, or replace five-second inputs with a
ten-second recording while claiming equivalent forecasts. Reused dates are
not a fresh holdout. Both destination decisions and all unavailable cases stay
in the evidence.

## Reproduction and next step

From any cwd, run the two scripts below; output stays alongside the scripts:

```sh
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-13/audit_receipts.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-13/verify_receipts.py
```

Final invocations exit0; `audit.log` and `verification.log` retain results.
The first verifier failed because `Counter.update` received a dictionary with
dictionary values instead of its keys. Initial source and failure explanation
remain; only the report counter was corrected, with no data/acceptance change.
No application test, typecheck, Vite build, browser, full suite, staging or
production verification was needed or run for this input-only audit.

Do not repeat this census or infer missing receipt data. A future bounded,
tester-identified capture during Red service must retain the same response's
raw buses and complete server ETA, observed_at, forecastAt and receipt time,
including at least ten minutes of prior inputs if replay is intended. It must
leave the existing watcher untouched and must not become a second persistent
watcher. Actual door/boarding availability remains unobserved. Until then,
keep these38cases unresolved and preserve route-forward tracking and caution.
