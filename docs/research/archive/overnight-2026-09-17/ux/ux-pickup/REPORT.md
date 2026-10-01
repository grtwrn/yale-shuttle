# Keep trip waits tied to the selected bus and visit

Tested combined ETA/UX candidate on production base `8aa67bd7f3883598f9458d825d97a52cbc004e0f` (PR291). Eight v2 files changed; HEAD and empty index preserved. No commit, branch change, PR, merge or deployment by this builder. Independent review and controller release gates remain.

## Rider problem and result

The countdown intentionally follows the approaching bus, while the trip can use a different pickup. Previously the expanded trip learned that pickup's identity only from its destination forecast. Removing destination rows changed a 17-minute wait for #309 into a short #307 wait label, despite unchanged numerical selection. A later visit by #307 also borrowed the earlier visit's short band.

The exact independently reviewed ETA cycle11 projection now retains the already-selected pickup vehicle and within-snapshot occurrence independently of destination availability. The UX consumer uses that identity and the existing selected wait. The reproduced missing-destination fixture shows #309 / 17 min and retains both explicit boarding choices. The same-vehicle later-visit fixture shows #307 / 41 min, explains the later visit, and keeps one physical-vehicle action. The pickup countdown, following arrival, and next pass remain visible with their existing meaning.

Destination loss no longer removes a focused #309 action. A transition from two physical vehicles to one still returns focus from the removed action to the persistent action. Existing stale/missing-data escape hatches and non-stealing focus behavior are preserved. Copy says “Trip uses” because missing destination timing does not establish a complete destination forecast.

No destination forecast is synthesized: journeyArrival remains absent and class arrival stays unknown. Existing fallback trip-duration/clock presentation is unchanged; this slice corrects the pickup attribution, not every missing-destination display. No selected pickup is promised physically catchable: the existing walking tolerance and raw-at-stop evidence remain intact. Manual tracking stores only the physical bus and existing trip fields, never stopsAhead or livePickupSelection.

## Files and ownership

ETA's exact reviewed patch supplies `web/src/livePickupSelection.ts`, a type-only addition to `planner.ts`, and two projection sites plus stale/departed/walk/future clearing in `TransitMap.tsx`. It applied without conflict to PR291. UX changes `tripBusIdentity.ts`, the expanded wait/copy in TransitMap and the existing browser assertion copy. New repository tests are `livePickupSelection.test.ts` and `scripts/pickup-selection-check.mjs`; existing `tripBusIdentity.test.ts` gains consumer coverage. TripBoardingActions is unchanged.

ETA cycle12's test supplement was read. The relevant selector/folded/missing/raw/tolerance/occurrence cases are already covered here; duplicate tests were not copied. The new deadline tests explicitly prevent pickup metadata from becoming a destination guarantee. No server wire, estimator, filter, ranking, walking, arrival bounds, history, notification, persistence or ride-engine behavior changed.

## Executed verification

All application commands below use `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2` unless the script changes directory. `O` means `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-pickup`; `L` means `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`.

1. `OUT=$O/release flock -w 900 $L bash $O/verify.sh` — exit 0, final source. 147 tests / eight files, backend/frontend TypeScript, Vite (128 modules), mobile and desktop pickup-selection browser tests, and both existing trip-identity suites. Exact outputs: `release-verify.log`, `release/browser-mobile.json`, `release/desktop/browser-desktop.json`, `release/identity/trip-identity.json`, `release/identity-desktop/trip-identity.json`.
2. `python3 $O/prepare-parity.py` — exit 0. Current PR291 numerical options block exactly equals the earlier reviewed production comparator; integrated numerical block and helper exactly equal ETA's reviewed cycle11 projection. Generates wrappers from actual current source; no algorithm copied by hand. `source-parity.json` records the base/hash.
3. `./node_modules/.bin/tsx $O/audit.mts > $O/audit.log 2>&1` — exit 0. 9,376 exact paired option, trace, ranking and metadata checks (4,688 historical + 4,688 synthetic missing-target states). All 4,688 historical decisions equal the previously audited production results; all input frames unchanged. See `audit-summary.json` and `paired-metadata.jsonl`.
4. `python3 $O/verify-integrity.py` — exit 0. HEAD/index/scope, unchanged planner runtime and timing/ride/transport/alert modules, exact reviewed projection, all four changed runtime modules in built sourcemaps, final browser reports, source hashes and screenshot budget verified. `integrity.json`, `integrity.log`, and complete eight-file `proposal.patch` are review aids, not publication controls.
5. Additional browser extension: `OUT=$O/final-second flock -w 900 $L bash $O/browser-final.sh` — exit 0 on both viewports before the final compatible-fallback change. The final release command then repeats these checks against the final built source.

Browser coverage uses the actual compiled SPA, checked-in route network and synthetic server ETA wire, fully intercepted requests, tester identity helpers, real keyboard/touch events and closed resources. Each final pickup report records 17 states plus real future-plan clearing, reload, and manual physical-bus storage. Mobile 360/390/430px and desktop 1280/640 CSSpx reflow pass. Both different-bus manual actions, same-vehicle single action, 44px targets, Enter/Space/Tab/tap, destination loss/recovery, stale/failed/missing feed, raw walking caution, departed recovery, final walking destination, both pickup slots and same-shuttle next pass pass. No page errors. Final phone and desktop screenshots were visually inspected.

## Preserved failures and evidence limits

- `verify.log`: initial new folded-route unit fixture mixed #307 and 307 row spellings, unlike the canonical reviewed folded fixture. Restoring the canonical normalized rows fixed the test; no selector change. Corrected initial gate: `verify-second.log`, 144 tests. Final expanded gate: 147 tests.
- `browser-final.log` / `final/browser-mobile.json`: all added feed/future checks passed, but the subsequent later-visit scenario assumed replanning preserved the earlier pin. Replanning legitimately changed it. The final fixture establishes a fresh initial pickup before its later visit, preserving real selector behavior. No application fix was needed. Failure resources closed; evidence retained.
- The replay is a parity check on reused data, not a new fit, holdout or accuracy gain. The 742 selected different-bus decisions are synthetic destination-outage sensitivity, not observed outages. No same-bus-later incidence is claimed from this historical cohort; that case is synthetic. All earlier connected outcomes, 38 unresolved raw cases and the old +442.827-second ordered-join regression retain exactly their prior numerical output. No observation was excluded or rewritten.
- No full-suite, backend staging/API smoke, CI, deployment, physical phone, native assistive technology, native zoom, OS notification or background-delivery claim. Map tiles are intercepted. Whole on-board/get-off/auto-end audit and every-view coverage remain unfinished.

At final integrity capture both teams' images total 10,736,682 bytes / 228 files, below 100 MiB. All command sessions and owned pages/contexts/browsers ended; no server, collector or persistent watcher launched or changed. No credentials, private reports, historical DB, controller, other-team files or publication settings changed.

## Handoff

Review this as one combined projection + consumer proposal, especially destination disappearance without action loss, later same-bus wait versus one action, real future replanning, and stale/departed/manual fallback. Reproduce with a fresh OUT; integrity pins the builder HEAD intentionally, so adapt its base check after controller capture while keeping source/hash/parity checks. Controller owns capture/commit/full-suite/staging/CI/merge/deployment verification. Next builder after acceptance: UX08 on-board stale/missing/get-off/finish recovery, then UX09 crash recovery; do not restart completed ETA screens or the reviewed pickup census.
