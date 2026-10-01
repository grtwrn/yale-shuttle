# Pickup projection integration handoff

The ETA implementation is executable and verified, but remains an artifact-only
prototype. Do not publish the unused metadata half. Apply it with the UX
identity/wait/action consumer as one proposal, after independent research review.
The baseline is d5a392f533e8684320259ff0d323a3b0da75cc50; a newer integrated
baseline needs an explicit conflict/parity check, not silent source replacement.

`eta-projection.patch` changes only three application paths:

- `web/src/livePickupSelection.ts`: typed projection of the actual current
  selector's rows, plus the raw override's selected vehicle.
- `web/src/planner.ts`: optional `TripOption.livePickupSelection` type only.
- `web/src/TransitMap.tsx`: ordinary/raw projections and explicit clearing
  for stale, departed/no-choice, walk and future options. No ETA arithmetic,
  ranking, visual component, copy, manual action or server wire change.

The patch is not applied to the worktree. The matching full sources and source
hashes are in `overlay.json`; `prepare.py` regenerates the patch from the pinned
base. Vite and TypeScript read these as virtual source modules. The original
application source and original web/dist remain untouched. The isolated bundle
is `cycle-11/dist`, with every repository source checked against the overlay or
unchanged checkout in `evidence.json`.

## Consumer behavior to implement in the UX-owned slice

Use `livePickupSelection.boarding.busName` to identify the selected ride while
metadata is present. Its identity survives a missing destination forecast;
destination availability must stay unknown. Continue treating `busName` and
the current countdown fields as the approaching pickup. Retain existing
manual fallback behavior when metadata is absent.

Distinguish different vehicle from different visit. The relation
`different-bus` means both. `same-bus-later-visit` means only a different visit;
it needs the existing selected `waitSec`, without borrowing the earlier
countdown's band or creating two identically named manual boarding buttons.
`same-visit` and `raw-current` keep existing corresponding wait presentation.
UX owns exact succinct copy and the existing focus behavior when actions change.

The helper does not promise physical catchability. It reports the existing
picker's choice. In particular, the picker can return `departed=false` with its
pinned bus retained inside the 90-second walking tolerance even if the strict
catchable list is empty. Preserve that choice; do not use metadata to tighten
the rule. `raw-current` preserves sensor/selection evidence even when no
compatible forecast exists; the 38 unresolved cases remain unresolved.

`selectedAtMs` is client computation time. Route identity comes from the option.
`stopsAhead` is snapshot-relative, never a persistent visit key, observed visit
ID, server receipt time, focus key, or active-ride identity. Manual boarding
continues to track a physical vehicle after explicit rider action. Do not add
this transient object to saved plans or ride persistence.

## Acceptance for the combined proposal

The current prototype proves exact numerical/trace/ranking parity on 9,376
paired states and exact metadata parity with the reviewed census. It also
proves stale/missing/recovered destination, same-vehicle later occurrence,
raw walking caution, departed clearing and recovery in the actual built SPA
on mobile and desktop. The first eight options match the prior production
browser artifact exactly after stripping only additive metadata.

The current browser still asserts the old display defects because UX has not
changed it. Replace those display expectations when integrating; retain its
metadata and numerical assertions. Add final tests for both explicit manual
actions, same-vehicle single action, action-removal focus, missing/recovered
destinations, stale/fresh and future-plan behavior, folded-route missingness,
and both upcoming arrivals. `boundaries.mts` contains 17 executable projection
and lifecycle groups; port the substantive cases into repository tests with
normal imports. The future guard is tested from exact generated shell source;
this round does not claim actual-browser future-plan entry.

Run normal application tests/typechecks/build and controller-owned full
suite/staging/CI/integration/release gates on the combined final source. The
artifact's virtual compilation is not a substitute for those release gates.
No new estimator score, calibration, coverage, incidence or holdout claim is
supported. The original 1,400 connected outcomes and 442.827-second regression
remain unchanged; same-bus-later incidence remains synthetic-only here.
