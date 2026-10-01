# Independent review 12 — selected pickup identity and visit

Reviewed September 18, 2026, 04:18–04:25 ET (controller round 10). **Verdict: approve. No blocking findings.**

Exact HEAD: `7f681d92a7d30331728d637216dabecf9d9e356c`.
Exact supplied base, parent and merge-base: `8aa67bd7f3883598f9458d825d97a52cbc004e0f` (PR291).

The entire eight-file candidate diff was inspected against that base. The captured source equals the builder-tested source hashes; the rebuilt bundle contains the exact current source. HEAD, tracked checkout and index are unchanged and clean. No application fix, commit, branch change, GitHub action or publication occurred during review.

## Supported rider improvement

The existing picker already distinguishes the approaching countdown from the pickup used to price the trip. The new projection carries those exact rows, and the raw override's physical bus, independently of destination availability. `tripBusIdentity` consumes the selected boarding identity while it is usable and preserves the prior fallback otherwise. Different vehicles produce distinct manual actions; different visits by one vehicle produce one action but use the selected wait.

Independently run actual-SPA fixtures show the missing-destination trip retaining **#309 / 17 min**, both named boarding actions and focused #309 action. A later visit by the same **#307 / 41 min** keeps one physical-bus action and explicitly says the trip uses a later visit. Removal of the different-vehicle action returns focus only when it owned focus; recovery and destination changes do not steal external focus. Phone and desktop screenshots generated in this review were visually inspected: compact route/wait/bus attribution is readable and there is no horizontal overflow at tested widths.

Metadata clears for stale/failed/missing server forecasts, an empty fleet, departed/no selection and actual future planning. Raw-at-stop evidence does not borrow a later forecast occurrence, and positive remaining walking retains its existing connection caution. A missing destination remains unavailable in the class comparison, including the case where walking is already late. Actual explicit #309 boarding while its destination forecast is absent tracks #309 through reload and preserves the final walking destination after Done. Storage contains physical ride fields, not `stopsAhead` or `livePickupSelection`.

## Code and evidence audit

- `planner.ts` differs only in types. Removing the new type import and optional property reproduces exact base source. The new helper's imports from planner/arrivals are type-only; it does not expand the server's runtime dependency closure. Docker closure tests pass and all server/Docker source is unchanged.
- The two projection sites and lifecycle clearing match the independently reviewed ETA cycle-11 patch exactly. Actual current-base and head options blocks were independently extracted into fresh reviewer wrappers. All numerical options, selector/journey traces and stable rankings remain exact in 9,376 paired states; all 4,688 historical options equal the prior audited production results. Input frames remain byte-identical. Fresh audit outputs equal the builder outputs byte-for-byte.
- Snapshot-relative `stopsAhead` is used only to distinguish rows within this selection. Neither selectedAtMs nor relative hops becomes a durable physical visit ID. The existing walking tolerance is preserved; metadata is not a boarding guarantee. No bus selector, route-position tracking, forecast bounds, uncertainty calibration, class-deadline calculation, alert/ride engine or historical outcome is modified.
- This replay is integration parity on reused evidence, not new holdout validation or an accuracy gain. The 742 different-bus cases after destination ablation are synthetic missing-data sensitivity, not observed outages. Same-bus-later visits are demonstrated by synthetic fixtures, not an incidence claim from this historical cohort. The 38 unresolved raw cases and the prior legitimate ordered-join regression retain their numerical outputs. No outcome exclusion or data rewrite was performed.
- Current release/follower reports were read. Score-dependent, date-confounded exploratory neighbor results remain research; this candidate does not promote coefficients or consume future neighbor trajectories.

## Independently executed commands and results

All paths below are absolute. Commands except the Python source preparation/integrity checks run from `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2`. Heavy test/build/browser work held the shared heavy.lock. Fresh evidence is under `ux/review-ux-pickup/`.

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/browser flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-pickup/verify.sh`

   **Exit 0**, `verify.log`: 147 tests / eight files; backend and frontend TypeScript; Vite build (128 modules, 4.85 seconds); both 17-state mobile/desktop pickup-selection suites; both existing trip-identity suites. All four browser reports complete with no page errors and closed resources. Covered both upcoming slots, same-shuttle next pass, missing/recovered destination, stale/failed/missing feed, raw walking caution, departed/fresh recovery, real future-plan clearing, physical ride reload, both named manual choices, keyboard Enter/Space/Tab/Escape, touch, 44px targets and phone/desktop reflow. Reflow includes 360/390/430 and 1280/640 CSSpx; this is not native browser zoom certification.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock npm test -- src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.release.test.ts web/src/etaSource.test.ts web/src/arriveByMessage.test.ts web/src/ArriveBy.render.test.tsx web/src/tripRanking.test.ts`

   **Exit 0**, `integration.log`: 57 further tests / seven files. Warm/corrupt/old checkpoint recovery, row parity, wire freshness/cache expiry, both occurrences in recorded Red release transitions, ranking and deadline unknown/buffer/late distinctions pass. Combined with item 1: **204 distinct tests in 15 files**. Full suite is not claimed.

3. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/prepare-parity.py`

   **Exit 0**: reviewer copy of generator explicitly reads the supplied base rather than builder-era HEAD. Exact current-source extraction and comparison to reviewed ETA projection pass. Creates only reviewer artifacts.

4. `./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/audit.mts`

   **Exit 0**, `audit.log`, `audit-summary.json`, `paired-metadata.jsonl`: 9,376 exact decision/trace/ranking/metadata comparisons, 4,688 historical prior-production matches and unchanged input frames. Each arm has 2,490 same-visit, 1,456 raw-current and 742 different-bus decisions. Repeated decisions are correlated and are not independent accuracy outcomes.

5. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/lifecycle-mobile flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/lifecycle.mjs`

   **Exit 0**, `lifecycle-mobile-second.log` and `lifecycle-mobile/browser-mobile.json`: reviewer-authored five check groups / nine recorded states / ten feed requests. Verifies missing-destination external focus, failure/removal/recovery focus, empty fleet recovery, actual class advice remaining unknown with a late walk, and explicit #309 boarding without destination data through reload and final walk. No page errors; resources closed. The first invocation of this same command used the repository-root cwd, failed **exit 1** resolving playwright-core, and launched no browser. Its original log `lifecycle-mobile.log` is retained. Correcting cwd required no source or dependency change.

6. `VIEWPORT=desktop OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/lifecycle-desktop flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/lifecycle.mjs`

   **Exit 0**, `lifecycle-desktop.log` and `lifecycle-desktop/browser-desktop.json`: same five groups/nine states with keyboard Space boarding, no page errors, all resources closed.

7. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux-pickup/verify-integrity.py`

   **Exit 0**, `integrity.log/json`: exact head/base/parent/merge-base; clean checkout/index; eight-file diff and source hash parity; planner runtime and server/Docker source unchanged; four runtime bundle sources equal committed source; six browser reports complete; all 44 original builder evidence files preserved; source syntax/whitespace pass. Both teams' screenshots total 234 files / 11,341,460 bytes, below 100 MiB. This reviewer added six images and no screenshots in the additional lifecycle runs.

## Limits and continuation

All browser requests were intercepted on a synthetic host, with tester identity helpers and blocked service workers. No production/private feedback/credential/historical database reads or writes were needed. No real-device/native assistive technology, OS notification/background delivery, backend staging/API smoke, full CI, deployment or new accuracy certification is claimed. The controller owns remaining release gates and exact-head integration.

The existing fallback total/arrival clock and ride-duration presentation when destination forecasts disappear remains unchanged and is explicitly outside this pickup-attribution slice; it should not be read as validated destination timing. Class advice correctly says it lacks a live destination window. The unavailable class row also retains its existing countdown identity; broader missing-destination copy/attribution can be examined as a separate bounded follow-up, without synthesizing a forecast. These pre-existing limits do not block the demonstrated pickup improvement.

Next builder: resume UX08 on-board stale/missing-bus, get-off and finish recovery, followed by UX09 crash/offline recovery. Do not rerun completed ETA screens or pickup incidence research. All reviewer sessions (22020, 14297, 76791, 11324, 59322) finished; every launched page/context/browser closed; no owned persistent server or lock remains. Existing simulated-rider watcher untouched. Only this team's review artifacts and log/checkpoint/morning notes were written.
