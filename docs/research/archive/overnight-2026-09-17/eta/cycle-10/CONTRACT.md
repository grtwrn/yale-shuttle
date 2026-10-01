# Selected pickup metadata for trip presentation

Status: research contract for coordinated ETA/UX review, **not application code**.
Baseline: `d5a392f533e8684320259ff0d323a3b0da75cc50` (PR289).

## What the rider needs

The approaching bus and the pickup used to price a trip may differ. They may
also be the same vehicle on different visits. The expanded trip must attribute
its wait and ride to the selected pickup even when its destination forecast is
unavailable. Preserve the approaching bus countdown and both upcoming arrivals.

The current picker already answers these questions. `pickLiveArrival` returns
`match` and `boardable`. The shell uses `boardable` for wait and destination
pricing, then discards it. `TripOption.busName` deliberately belongs to `match`.
`tripBusIdentity` reconstructs the other identity from `journeyArrival.busName`;
this loses the choice when destination rows disappear and cannot distinguish
two visits by one vehicle.

## Proposed data contract

Add one optional per-selection object to `TripOption`. It is a projection of
the existing decision, not a second selector. Suggested shape:

```ts
type PickupEvidence =
  | { source: 'forecast'; busName: string; stopId: number;
      stopsAhead: number; etaSec: number; lowSec: number; highSec: number }
  | { source: 'raw-at-stop'; busName: string; stopId: number };

type LivePickupSelection = {
  selectedAtMs: number;
  countdown: PickupEvidence;
  boarding: PickupEvidence;
  relation: 'same-visit' | 'different-bus' | 'same-bus-later-visit' | 'raw-current';
};
```

This name is provisional. Route identity is the containing option's
`routeLabel`; bus names use existing `#` normalization. `selectedAtMs` is the
client computation time, **not** a server forecast receipt/time field. Existing
transport freshness remains authoritative.

For the ordinary path, project the exact `picked.match` and
`picked.boardable` objects already used for countdown and wait. Both are
within the same live arrival set. When bus identities are equal, compare
their boarding-stop occurrence (`stopId`, `stopsAhead`) within this selection.
A later occurrence is distinct even if the bus number matches. Do not derive
this relation from ETA equality, wait length, bus number alone or a guessed
lap duration.

For the raw-at-stop path, project the **selected raw vehicle** as raw evidence
for both fields. Preserve the current dwell gate and any positive-walk caution.
The current journey join may associate an existing approaching/current row,
but this row is not needed to retain the raw vehicle identity. If no compatible
row exists, do not relabel its next-lap forecast as the current boarding visit.
The research projection records the optional `forecastLink` for audit only;
it need not be part of the initial product API.

Clear this object for stale/missing live data, `departed`, no selected arrival,
walk options and future plans. In particular, `pickLiveArrival` can return a
fallback `boardable` while `departed=true`; that is not a selected catchable
pickup. Do not publish its identity as one. Do not carry live metadata into
saved future plans or active-ride persistence.

`stopsAhead` decreases as the vehicle advances. A `(bus, stop, stopsAhead)`
tuple is **not a persistent physical visit ID** and must not be used to infer
missed visits across polls, key long-lived focus state or match an observed
arrival. The relation is recomputed from the current selection. A stable
historical visit ID would require an additional tracking contract.

“Boardable” here means selected by today's walk/dwell rules. It does not
guarantee that the bus will wait or that the rider will catch it. The raw
at-stop state is existing sensor/selection evidence, not proven physical
boarding availability; 14 retained raw cases follow retrospective departure.

## UI consumption to coordinate

- Derive the ride's bus from the selected boarding evidence independently of
  destination availability. Keep unavailable destination windows unknown.
- Distinguish `differentVehicle` from `differentVisit`. The former controls
  two explicitly named manual boarding choices. The latter controls which
  pickup supplies the wait text and whether a later pickup needs explanation.
- Only use the countdown's band to describe the journey's wait when the
  selected pickup is the same visit (or the existing raw-current branch).
  Otherwise retain the existing selected `waitSec`, including same-bus later
  pickups. Do not narrow it using the first visit's band.
- Preserve the manual escape hatch for the vehicle actually boarded. A same
  vehicle's two visits should not create two identical “I'm on #307” buttons.
  Manual boarding tracks the physical vehicle after the rider acts, not a
  predicted future occurrence.
- Keep the current stale/future manual-action behavior until UX deliberately
  revises it. Clearing predicted selection must not silently disable the
  manual escape hatch or steal keyboard focus.

ETA should own the type/projection helper and the two shell return sites; UX
should own identity/wait/action consumption and copy. Review the combined
change as one coherent proposal. No server wire or estimator change is needed.
The existing countdown, wait, total, destination distributions, route ranking,
both arrivals, forward tracking and walking-caution logic must remain equal.

## Evidence and limits

`summary.json` classifies 4,688 unchanged historical decisions: 2,490 same
forecast visits, 1,456 raw-current selections and 742 different-vehicle
selections. No same-bus-later selection occurs in these 40 selected Red
sessions on two previously used dates. Those cases are demonstrated with
synthetic boundaries and the actual built SPA, not assigned an observed rate.

Deleting only destination rows in each wire preserves all 4,688 selected
pickups/countdowns/waits. It makes the current presentation misattribute the
742 distinct boarding choices because `journeyArrival` disappears. This is a
missing-data sensitivity experiment, not 742 observed production incidents.
Destination totals may fall back to the existing planned ride duration; the
ablation does **not** claim every numerical output is unchanged.

The remaining 38 raw-unlinked decisions remain exactly the previously audited
cases (24 before / 14 after recorded departure). This metadata contract does
not fix their tracking state or invent a current forecast. All 1,400 existing
connected outcomes and the 442.827-second added-error case remain unchanged.

Acceptance should rerun the saved numerical census, retain both occurrences
and all regressions, add substantive metadata tests for the cases in
`boundaries.mts`, and verify actual mobile/desktop/keyboard lifecycle including
missing/recovered destination, same-bus later pickup, stale/fresh and manual
boarding choices. No fitting, tail re-optimization or new accuracy claim is
justified by this presentation repair.
