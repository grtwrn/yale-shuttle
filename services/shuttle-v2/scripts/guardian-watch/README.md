# Guardian bridge and incident evidence

`poll.py` retains the Mac bridge's existing health, rider-stall, candidate-event
and failed-journey alerts, two-hour deduplication, and event read offsets.
`launcher.py` is the reviewed entrypoint copied to the launchd job's existing
`~/.openclaw/yale-shuttle-team/bin/ys-watch-bridge.py` path. The job still runs
once a minute; it uses the repository version without restarting riders or the
learner. `YALE_SHUTTLE_ROOT` overrides the launcher repository. `GUARDIAN_STATE`
and `GUARDIAN_WATCH` select isolated queue and rider locations for diagnostics.

Independent Linux riders can opt in with `GUARDIAN_NAMESPACE` set to
`linux-arm64-rider-red-guardian-v1` or `linux-arm64-rider-random-guardian-v1`.
Both `GUARDIAN_STATE` and `GUARDIAN_WATCH` must then be explicit absolute paths.
Use fresh private state; the bridge refuses legacy or foreign bridge, queue,
and status records, malformed consumed state, and open incidents outside its
own pending queue before rotating logs or writing state. Incident IDs are
namespace-specific; records carry explicit namespace and Linux source labels.
Leaving the variable unset
preserves the legacy bridge behavior.

The Linux Guardian must execute in the rider's own container and PID namespace
(for example through its reviewed `docker exec` adapter): `storage.lock` stores
guest PIDs. Give both roles the same `GUARDIAN_WATCH` base ending in `rider`, but
mount only that role's rider output; the Red path is still derived as `rider-red`.
Prime the fresh bridge before the rider emits its first records, and quiesce
in-flight Guardian work before stopping the rider. The namespace option does
not activate a job or attest physical arrivals or a qualified runtime.

An incident's original pointers to rotating logs remain as provenance. Each
new rider-event occurrence also receives a private, atomic evidence bundle
under the guardian state's `evidence-bundles/<incident>/<event>/`. It contains
the original event, matching run records from current and rotated sample,
event and journey logs, and up to five referenced/start/pickup JPEGs. Current
status and checkpoint files are explicitly labelled as capture-time context.
The bridge uses the same PID lock as the Node rider's storage code so that
rotation cannot remove a file during capture. It never changes rider records.

Every file has a byte count and SHA-256 in the manifest. The incident retains
the manifest checksum; duplicate captures verify the original immutable bundle.
Repeated alerts grouped into one incident retain separate occurrence receipts.
A capture failure stays visible in the incident and `evidence-status.json` and
retries on the next poll. A failed capture does not suppress the alert or reset
read offsets. Only the two configured rider roots supply evidence; referenced
paths cannot copy arbitrary files or follow screenshot symlinks.

Existing pending rider alerts are backfilled from whatever remains available.
The manifest compares sample rows with the journey's recorded sample count.
Missing samples, partial or malformed source rows, and unavailable screenshots
stay explicit; a completed capture does not assert complete historical data.
These GPS-correlated virtual records are not independent physical boarding or
ETA accuracy evidence.

Original response context includes each versioned boarding check's referenced
body, including checks retained only in a retry event. These can differ from
the earlier pickup screen and from the feed present when rejection is logged.
Duplicate references preserve both boarding and arrival context. Existing
8 MiB response-context and 32 MiB bundle bounds still apply; omitted or
unavailable bodies remain explicit, and unavailable references prevent a
complete-context claim. No missing historical response is reconstructed.

Arrival context also selects the response linked by `arrivalTextContext` and
the `arrived` event's `detail.screen`. It can differ from the first qualifying
arrival response and from the final sample. References from both the event and
journey preserve their context tags while sharing one body when their IDs
match. Unavailable text references prevent a complete-context claim; the same
response-context and bundle byte limits still apply. The text's source
association does not identify an atomic screenshot render or physical arrival.
The October 23 Gold trip demonstrated this gap: its saved arrival text used a
response five seconds after its first-arrival response, which the old selected
context omitted. Existing immutable bundles retain their original omissions.

Routine rider images and logs keep their existing rolling policies. Bundles
referenced by pending incidents are protected. Once their incident leaves the
pending queue, bundles roll by seven days from capture and a combined 256 MiB target.
Protected overage is reported and fails the bridge's evidence-health check;
unresolved bundles are retained. A malformed pending queue or damaged bundle
refuses cleanup. Dead writers' incomplete temporary bundles are discarded;
live writers' files remain protected and counted. A bundle is bounded to
64 MiB of selected log rows and 32 MiB of stored payload; exceeding either
limit reports a retryable capture failure and preserves the original sources.

The scheduled output log keeps approximately 1 MiB live plus one compressed
1 MiB tail. Copy/truncate preserves launchd's open append descriptors. This
routine log can roll because incident records and evidence have separate
retention; pending evidence is not deleted when output rotates.

The production health check normally uses Python's standard HTTPS client.
Only a DNS lookup failure for that fixed health URL invokes `health.mjs` using
`GUARDIAN_NODE` (default `/opt/homebrew/bin/node`). The child uses the shared
`monitor-fetch.mjs` transport, retains certificate and hostname verification,
and has a ten-second request deadline, 16 KiB JSON limit and fifteen-second
process deadline. HTTP errors, timeouts and TLS failures from the original
check keep the normal three-failure alert rule without this retry. A fallback
response still needs HTTP 200 and literal `ok: true`. `healthCheck` records the
latest check; `healthDNSFallbacks` and `healthDNSLastFallback` retain the retry
count and last outcome, including the original lookup failure. No system DNS
or VPN configuration changes.

`evidence-status.json` exposes fresh status, capture/retention errors, retained
and protected bytes, and historical sample gaps. The bridge also records the
running Python source hashes in `bridge-state.json`. Exit 0 means the poll's
evidence work succeeded; exit 1 means it needs attention. Health incidents
retain their separate existing consecutive-failure rule.

Rider heartbeats and feed receipts are checked separately. A running browser
with no valid feed receipt for more than five minutes raises
`rider-feed-stalled`, even if its heartbeat is fresh or its `feedStale` flag is
false. Receipts older than 30 seconds remain `stale` during the five-minute
alert grace; that grace never labels old data fresh. The existing 15-minute
heartbeat-stall check remains. Fresh empty feeds
are healthy receipt evidence; this does not attest upstream GPS age, a
completed journey, or ETA accuracy. Missing, malformed or future receipt clocks
remain `unknown` in `bridge-state.json`'s `riderFeedHealth`.

One feed-stall incident is emitted per outage. That latch survives monitor
restarts and rearms only after an observed fresh receipt, keeping repeated
checks from growing protected occurrences and bundles indefinitely. Unknown
data does not clear the latch. Existing incidents and their evidence remain
untouched.

Run `python3 -m unittest discover -s scripts/guardian-watch -p 'test_*.py' -v`
from `services/shuttle-v2`. `bridge.test.mjs` runs the same Python tests inside
the normal Vitest release gates.

Transfer rider events carry the current leg’s `line`. Candidate and failed-journey incidents use that explicit line; older events fall back to the journey-started mapping. Resuming on the second leg does not require replaying an earlier start event to attribute an alert.

Completed one-seat journeys also receive a pickup-window diagnostic. The bridge
seals the original run before comparing its first literal `Arrival: ... Likely`
window with a recorded pickup-area observation. It requires complete samples,
a fresh initial screen, the same named vehicle, unchanged provider ID, one
route, the same pickup label and stop coordinates, fresh GPS and receipt clocks,
and no waiting-observation gap over 30 seconds. The first qualifying pickup
position must agree with the at-pickup card and precede the boarding action by
at most 15 seconds. An earlier close pass stays unknown. Resumed, excluded,
transfer, ambiguous, missing and changed-vehicle records remain unknown.

A pickup between the ten-second waiting samples can instead use the original
versioned boarding checks. Both the selected card and each check must bind to
verified saved response bytes, the same pickup and stored ride, and the same
provider. The selected card must show the bus at pickup and remain stable; the
first qualifying ready check uses the existing 45 m / stationary 60 m rule,
freshness limits and 15-second boarding fence. Missing bodies, failed checks
and changed identities stay unknown. An earlier sampled opportunity still
takes precedence, including one whose card is unconfirmed. This adds a saved
observation to the GPS diagnostic; it does not infer an intermediate position.

A pickup observed more than five minutes before the first window's lower
bound or beyond its upper bound raises
`rider-pickup-window-miss` for review, even when the journey completed. This is
the existing canary's five-minute first-sight diagnostic tolerance, checked for
parity by tests and applied equally to both tails. Early receipts use
`early-window` and include `earlyBeforeWindowSec`; late receipts retain
`late-window` and `lateBeyondWindowSec`. The strict threshold excludes exactly
five minutes in either direction. These shared-GPS records do not prove physical boarding or
independent ETA accuracy, and do not fit or publish a model. A result inside
the tolerance is not an accuracy qualification. The October 20 Purple #124
record has a literal 4–12 min first window and a pickup-area observation 27 min
later; the retained Orange Night record instead changed vehicles and cannot
be scored as the original vehicle's late arrival.

A second verified boarding path handles a response arriving between the saved
at-stop card and eligibility. The original selected body must independently
show the same stationary named curb within the app’s 75 m observation radius;
this is selection context, not the scored pickup. Every original check body
must retain that vehicle, route and curb with fresh, monotone receipt, model
and GPS clocks. The first qualifying check before boarding supplies the pickup
clock under the existing 45 m / stationary-named-60 m criteria. A provider’s
older zone-start clock never substitutes for that observation.

This path also verifies the complete saved fleet and compact model, the declared
pickup coordinates, stable at-stop text and the newly stored ride. An explicit
null other-occurrence finding is allowed only in the within-45 m at-stop branch
where the runner emits it; missing or positive findings remain unqualified.
A manual card check needs its own stable at-stop text and original body. Missing
sources, moving/non-at-stop transitions and earlier unbound opportunities stay
unknown. The original same-response boarding path and existing known first-window
results remain unchanged, and historical verdicts are never relabelled. These
remain shared-feed virtual diagnostics, not physical arrival evidence.

`updatedWindowAudit` separately reviews later literal pickup windows after a
qualified first-window audit. Two stable later quotes must miss the same tail
by more than the existing five-minute tolerance and name the watched vehicle
in the selected card. Their original response IDs
must differ; receipt, model and GPS clocks must each advance 5–30 seconds.
Cached views cannot confirm, and a race, unavailable window, clock regression
or recovered quote resets confirmation. The first-window result stays intact.
Neither a no-confirmed-miss scan nor an unknown result qualifies ETA accuracy.

A later candidate must bind both original quote bodies and the qualified
pickup observation body to the saved fleet and model fields. If the first
bundle lacks that context, the bridge creates a second immutable bundle with
up to three selected `pickupWindowReferences`. Its versioned context identity
pins those response IDs; plain capture retains its original identity and
never rewrites the first bundle. Missing or budget-omitted bodies remain
unknown. Existing 8 MiB context and 32 MiB bundle limits still apply.

Both first and later misses use the existing per-run incident deduplication,
including processed incidents. The first-window miss takes alert priority if
both fail. Pending incidents retain the confirming contexts; routine verdicts
still roll at 200 per rider, and routine evidence keeps its existing limits.
`evidence-status.json` reports `updatedStates` separately from first-window
states. Existing verdicts and the historical backlog are not relabelled.

Auditing starts with future completed events at first activation. It does not
relabel old journeys or retrospectively emit alerts from an old backlog.
At most two queued runs per rider are checked per poll. Capture failures leave
pending work for retry. A retained incident, including one already processed,
prevents duplicate occurrences after a lost bridge checkpoint. Each rider keeps
at most 200 routine verdicts in bridge state. Routine audit bundles use the
existing seven-day / 256 MiB rolling store; candidate incident bundles receive
the existing pending-evidence protection. `evidence-status.json.pickupAudits`
reports pending work and separate unknown, early-window, late-window and
tolerance counts. Existing audit verdicts are not rewritten when early-window
support is installed.
