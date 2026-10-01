# Attribute trip steps and ride tracking to the correct bus

Builder proposal, 2026-09-18 02:15–02:31 ET. **Candidate ready for independent review; not committed or published by this role.** Exact HEAD/base `2dbc060bf517225c219fba8cbc5cb343fb19312b`, controller branch/index preserved.

## Problem proved in the browser

The pickup countdown deliberately keeps following an approaching bus even when the walk model prices the journey using a following bus. In a sorted two-bus wire fixture on the checked-in Red route, the unmodified built app kept #307's roughly20sec pickup countdown while `journeyArrival.busName` was #309. The actual live option had129sec access walk,1071sec wait and2280sec total. Its expanded steps nevertheless showed `now–2 min` wait and `#307 · 18 min`. That paired one bus's pickup window and identity with another bus's trip duration. The only manual boarding action also silently tracked#307.

`baseline-sorted/identity-probe.json`, `baseline-sorted.log` and its phone screenshot retain both rendered text and actual live React options. The browser uses the real production bundle/planner/transport; network data are explicitly fabricated, sorted ETA rows and checked-in public stop geometry. This is a presentation regression fixture, not a measured accuracy result or new historical holdout.

The first unsorted-wire probe produced a same-bus later-lap total. Server-arrival order is part of the consumer contract, so that result is retained in `identity-probe.json`/`baseline.log` but is **not used as production evidence**. The corrected sorted probe independently demonstrates the distinct-bus mismatch. ETA's previously audited742 countdown/journey differences motivated the audit; their numerical experiment was not restarted. Read-only inspection of58224:48:150 confirms the existing recorded distinction309/308; this role does not claim a new browser replay of that historical case.

## Proposed behavior

- Expanded steps name the bus already used by the usable `journeyArrival`. When it differs from the pickup bus, the wait chip uses the existing `o.waitSec` point estimate instead of borrowing the pickup bus's range. No new range is synthesized.
- A short explanation names both: `Trip time uses #309. #307 may reach pickup before you.`
- Explicit `I'm on #309` and `I'm on #307` actions let the rider track the bus physically boarded. The original manual escape hatch remains available even when GPS overstates the walking distance. Ordinary single-bus presentation remains `I'm on it`.
- The persistent pickup action keeps keyboard focus when the additional journey action disappears with an unavailable forecast. Normal polls preserve focus; external focus is not stolen.
- Pickup countdown, pickup map/approach labels, following arrival, trip selection, route ranking, raw at-stop policy and both occurrences remain unchanged.

Five source files under v2: `web/src/TransitMap.tsx`, `web/src/tripBusIdentity.ts`, `web/src/tripBusIdentity.test.ts`, `web/src/TripBoardingActions.tsx`, `scripts/trip-identity-check.mjs`. The small component owns dynamic boarding focus; the pure helper only selects display identities. No ETA/server/planner/arrivals/wire/history or schema change.

`integrity.json` freezes the final five source hashes. The entire `options` live numerical memo is byte-identical to HEAD (SHA256105a01ac51b521b5029ef37b850ea47650023a96076adbe881ccab89c59a1e1c). `planner.ts`, `journeyArrival.ts`, `arrivals.ts` and `etaSource.ts` match HEAD bytes. A frozen HEAD shell is in `baseline-TransitMap.tsx`.

## Executed verification

Cwd for wrapper commands: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17`.

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06-trip/verify.sh` — **exit0**, final evidence `final-verify.log`.
   - From v2, `npm test -- web/src/tripBusIdentity.test.ts web/src/journeyArrival.test.ts web/src/planner.test.ts web/src/accuracy-closing-bus.test.ts web/src/RideFinish.test.tsx web/src/standWait.test.ts`: **131tests/six files pass**. Five new identity checks cover distinct/same normalized bus, unusable/departed forecasts and missing/future identity. Existing tests preserve closing-bus loyalty, trip selection and ride-finish semantics.
   - `npm run typecheck`: backend and frontend pass.
   - `(cd web && npx vite build)`:127modules,4.77sec, pass.
   - `node scripts/trip-identity-check.mjs` and `DESKTOP=1 OUT="$OUT/desktop" node scripts/trip-identity-check.mjs`: actual built SPA in separate mobile and desktop contexts, all checks pass. `final/trip-identity.json` and `final/desktop/trip-identity.json` have empty errors and resourcesClosed true.
2. `node --check services/shuttle-v2/scripts/trip-identity-check.mjs`; `git diff --check`; `git diff --cached --exit-code` — **exit0**. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06-trip/verify-integrity.py` — exit0; exact HEAD/five source hashes/frozen baseline/unchanged numerical memo/modules verified, `integrity.log` and `integrity.json`.
3. Baseline probe: `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06-trip/baseline-sorted flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash -c 'cd services/shuttle-v2 && node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06-trip/identity-probe.mjs'` — **exit0**, unmodified baseline bundle, before source changes were built.

The final browser fixture adds a real nonzero final-walk leg and long destination name. Its total is40min rather than the earlier fixture's37min because the destination was deliberately moved; this is not a before/after numerical improvement claim. It checks the rendered ride duration against the actual option rather than expecting a fixed rounding boundary.

Browser coverage:360/390/430 mobile,1280/640 desktop CSS-pixel reflow;44px action bounds; Tab/Enter/Space and real mobile tap; pickup#307 and following#309 dialog; access/ride/exit/final walk; Back retains endpoint draft; same-bus recovery; missing and stale wire remove the distinct-journey claim; fresh recovery; focus continuity across normal polling, focused-action removal and externally owned focus; both explicit boarding choices persist the correct bus and planned exit/destination; Done retains walking directions from current location to that exact destination. Phone/desktop screenshots were visually inspected.

All requests intercepted and tester identity seeded. Each page/context/browser closes in finally. No backend/staging server, persistent browser/watcher, second collector, dependency installation or production report/request write. Full suite, complete backend staging/API/browser smoke, CI, independent review and deployment verification remain controller gates.

## Failed/setup runs preserved

- `mobile.log`/`mobile/trip-identity.json`: fixture asserted18min at a floating-point floor boundary after adding the final walk; actual rideSec was just below1080. Corrected test to compare actual option duration; no application change for this failure.
- `mobile-2.log`/JSON: all checks through#309 boarding/final directions passed, then the harness expected expanded details immediately after reload. Its own init script intentionally opens overview; corrected the harness to explicitly reopen details.
- `mobile-3.log`/JSON then passed both manual choices before the new focus component was added. The final wrapper rebuilt and tested that component on both viewports. Earlier `verify.log` passed131tests/types/build before the extraction; final verification is authoritative.
- One read-only rg invocation was unavailable; grep/find fallback used. One optional morning-summary read used an underscore instead of the existing hyphenated filename; corrected without editing that nonexistent path. Neither was an application failure.

## Limits and next work

This fixes **distinct known bus identities**. A later pickup by the same bus, or a journey whose destination forecast is absent, cannot be distinguished by `journeyArrival.busName` alone. Do not infer an occurrence or invent an ETA from this helper. Coordinate an explicit boardable pickup/occurrence contract with ETA before expanding the scope. ETA's separate ordered raw-at-stop join is untouched and remains its own independently reviewed proposal.

No calibrated percentage, normality, coverage, accuracy, live overnight service or all-view accessibility claim. Tiles are blocked. Physical phones, native screen readers/native zoom, full on-board alert behavior and whole-view focus transitions remain outside this slice. Final walking preservation is verified, but not the full UX08 alert/auto-end matrix.

Independent reviewer should check identity/wait attribution, preservation of both manual choices, missing-forecast focus ownership, no change to numerical options, and boundaries above. Then continue UX07 selected-idle/all-hidden/off-hours versus unavailable-feed recovery; retain UX08 alerts and same-bus-visit coordination as separate work.

All owned exec sessions completed and locks released. HEAD/index unchanged. Existing simulated-rider watcher untouched. Shared screenshots145files/6,286,619bytes at integrity capture, well below100MiB; earlier evidence preserved. No other-team/controller/publication files changed.
