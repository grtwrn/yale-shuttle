# Transfer itineraries

The Trip view can show one change between two shuttle lines. Each route pair
retains its closest first pickup, least walking, and earliest available arrival
when those are different paths. Direct rides stay visible; transfers that add
no time, walking, or pickup-risk benefit are available through Show more.

A structural connection is not a timed connection. Live timing reads the same
fresh server publication used by ordinary trips. Both pickups and both exits
must match the selected forward route calls, including repeated calls on folded
routes. Bus two must reach its pickup after the first exit and transfer walk.
Each pickup keeps its served window. Final arrival is conditional on catching
both buses; separate windows are not combined into a joint confidence interval.
A tight or overlapping connection is identified without a claimed probability.
Missing live timing never becomes a headway estimate.

Explicit future planning uses typical rides and waits, labels them as typical,
and checks published hours at each expected boarding time. It has no live bus
identity, boarding action, or reminder until the rider chooses Plan for now.
A live first visit can remain visible outside published hours with a caution;
this does not promise another lap or that a bus will wait.

The first boarded ride stores the onward route, public stops, planned bus name,
and final destination. Ending that ride opens the next pickup. If tracking ends
because of age, a missing bus, or an off-bus observation, the rider must explicitly
continue; none of those conditions proves arrival at the transfer stop. A first
ride that expires while the page is closed can recover its onward trip for up to
four hours from planning. The next walk uses a fresh rider fix when available.

Only the current pickup has boarding and reminder controls. Minutes, stops, and
leave-time reminders use that pickup's live boarding evidence; leave time needs
a known walk. Armed reminders and forecasts are not restored from storage.
Both bus identities are watched for reporting interruptions while viewing a
connection. Feedback diagnostics retain both public ride legs and the displayed
pickup text, with the existing publication receipt, without copying the rider's
address or GPS into screen evidence.

`transfer-trip-check.mjs` runs against actual built or explicitly selected
published assets using a retained network and intercepted, controlled responses.
It covers phone and desktop transfers, reminders, independent bus loss/return,
failed polling, refresh in each stage, tracking-loss recovery, replanning, future
mode, keyboard selection, and overflow. These are behavior and source-consistency
checks, not independent observations of physical shuttle arrivals.

The legacy `/api/plan` compatibility endpoint continues to return its one-ride
response. The current SPA and virtual-rider trip flow do not call that endpoint;
transfer arrival windows are not forced into its aggregate confidence fields.
