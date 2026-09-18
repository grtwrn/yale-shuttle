# Overnight UI/UX team handoff

Prepared September 17, 2026, 22:03 ET from `40af3c0bb8e2522972b4e9f0222b1756fbd3c227`.

Worktree: `/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17`.
Evidence, work log, screenshots and reviewer results: this directory. Overnight window ends September 18 at 07:30 ET. Root owns the durable-worker schedule and integration; coordinate deployment with root.

## Objective

Make each rider view answer its immediate question with the least reading needed: Can I make class? Should I walk or take a shuttle? Where do I wait? Which bus is mine? When should I get off? Improve concrete obstacles and confusing states, not the visual identity for its own sake.

The user explicitly authorized two agent teams overnight and has standing authorization for implemented, reviewed, tested changes to merge and deploy through CI. This initial bootstrap made **no application edits, builds, commits, or deployments**. Findings below are source inspection, not browser-verified accessibility or visual results. A later worker must reproduce before claiming a measured UI defect fixed.

## Read and preserve

1. `CLAUDE.md` is current: production is `services/shuttle-v2`. Root `AGENT.md` describes archived v1, including outdated deploy/testing advice; do not edit or deploy that stack.
2. `web/src/TransitMap.tsx` owns the current shell. User-facing navigation is **Trip, Map, Issues**. No separate Favorites, All, Accuracy, History, or Settings tab exists. Saved places, weather units, alerts and planning times are contextual controls. Some legacy branches/types survive; do not mistake them for reachable views.
3. Route identity and colors come from `routes.ts`; retain the Map page's one filter across map and route cards. Preserve hidden-route persistence, both shuttle slots, and “same bus next lap” identity. Do not resurrect removed tabs or duplicate filters.
4. ETA team owns estimator/filter, release/lap fitting, backend transport and historical sample selection. Keep UX changes to presentation, interaction and truthful wording. Numerical planner/deadline changes require joint coordination. Never tighten a window by clipping it in the UI or relabel it as a calibrated confidence percentage.
5. Current app uses continuously warm server estimates. Observed wait, usual total wait, remaining wait, pickup ETA, destination ETA and past journey duration are different quantities. `ArrivalDetails`, `ArrivalHistory`, `ArriveBy`, `mapLabels` and `standWait` contain intentional distinctions. Read before simplifying.
6. User requested compact waiting text `X/~Y` beside the correct bus, and compact map windows. Do not reintroduce “about N” plus a second sentence on the minimap. Existing `mapWaitLabel` returns elapsed `M:SS` / usual total minutes. Its `m` suffix is a current exception/conflict with the broader `min` convention: review on a phone before changing, and keep values' units unambiguous without expanding the label.
7. Preserve intentional refresh behavior: both header refresh and installed-app pull-to-refresh clear the planned trip. Preserve stored draft/back-navigation behavior and final walking directions after ending ride tracking.
8. No production feedback submissions, token exposure, analytics contamination, live canary changes, or unrelated data edits. Root owns the live watcher. Use local/mock fixtures and existing `seedTestId` for browser probes.

## Highest-value findings

* `ArriveBy.tsx` uses the headline **“Your arrival is at risk” whenever no recommendation exists**. `compareDeadline()` can produce that state because all usable shuttle windows are unavailable, future, stale, or caution-only, or because a trip fits class but uses the user's buffer. The main headline collapses missing evidence, buffer use, and possible lateness. Make those states distinct without changing calculations. See `FIRST_TASK.md`.
* `TransitMap.tsx:3205` exposes `routes filtered by published hours, wait = ½ typical headway` in the rider's main future-planning line. Translate this into a brief statement that future times are estimates and live arrivals will be available near departure; put the method in optional help only if useful.
* Source-defined controls miss basic semantics: navigation near line 7640 has no programmatic selected-view state; From/To inputs near 2898/3040 use nearby spans rather than associated labels; To's `aria-expanded` reads `toSugg` while its rendered `PlaceList` uses `toRows`; feedback/reply textareas have no explicit labels; screenshot labels wrap inputs hidden from keyboard focus. These are strong candidates for a second, bounded accessibility pass with real keyboard checks.
* Future-time buttons use `minHeight: 40`; feedback priority buttons use `minHeight: 36`. Most other controls already target 44 px. Verify bounding boxes; fix specific short targets, not every small visual element indiscriminately.
* `ArrivalHistory.tsx` correctly separates historical dots from forecasts and already weights recency, but puts **“Recent-weighted median” and the weight-halving formula** in the main content. “Typical past trip” with a short recent-weighting explanation and method under existing details may be clearer. Keep matched origin, elapsed wait, sample count, date range, actual dots and median semantics explicit.
* `ArrivalPlot` provides SVG titles and an HTML data table via history. Dot titles alone are not a usable mobile interaction. Do not add 100 tiny keyboard stops; retain/enhance the accessible table and consider a single selected-dot affordance only if it improves a demonstrated use case.
* `main.tsx` crash fallback leads with “App crashed,” displays a raw stack, and offers `Reset app data & reload` without explaining what is lost. A useful recovery page should lead with reload, explain reset's actual consequences, and put technical error details under disclosure. No automatic data clearing.
* Map empty-filter states are repeated above the map and below it. Test whether one short actionable message at the decision point can do the job while preserving visible explanation where riders expect cards. Don't remove the explanation for selected-but-idle routes.

## Working cycle

Take one `BACKLOG.md` item with a clear before/after behavior. Reproduce in local/staged app, capture one phone screenshot and relevant DOM/keyboard evidence, implement the smallest coherent change, validate, then request an independent review. Reviewer checks changed behavior plus adjacent failure states and prior operator constraints. Respond to findings before merge.

Use `VIEW_COVERAGE.md` to ensure all reachable surfaces get attention over successive cycles. Mark `inspected`, `verified`, `changed`, or `deferred with reason`; do not claim “all views improved” from source search alone. Update the backlog after each result, including intentionally unchanged views.

For each item record: problem, affected rider action, files, evidence, implementation, validation, reviewer outcome, commit/PR, deploy state. Keep photos/fixtures free of private reports or admin tokens. Unvalidated proposals belong in the backlog, not shipped copy.

## Verification and integration

Current commands from `services/shuttle-v2`:

```sh
npm run typecheck
npm test -- <relevant test paths>
cd web
npx vite build
```

Full suite and normal deploy gates before merge. Prefer existing behavior tests; add tests for meaningful state distinctions (deadline unknown versus late, keyboard reachability), not assertions mirroring every style or sentence.

`scripts/pr-preview.mjs` can drive a staged server, use API mocks and produce screenshots. Its documented `views` includes historical names that are no longer tabs: use actual Trip/Map/Issues. It supports `BASE`, `RECIPE`, `OUT`, `BOT_CHROMIUM_PATH`; do not invoke it against a nonexistent staging server. Do not start a second collector pointed at the live DB. Root is establishing worktree dependencies and workers.

Minimum visual check: 360×800 and 390×844 portrait, 430 px phone, desktop 1280 px; 200% zoom/reflow; keyboard Tab/Enter/Space/Escape and focus restoration. For touched live UI, check pending, fresh, stale/failed, zero buses, long stop names, both shuttle slots and route identity. Check mobile touch with actual bounding boxes, not declared CSS alone. Respect reduced motion when touching animated UI.

Push reviewed source changes via normal PR/CI integration. Deploy only committed history via `.github/workflows/deploy.yml`; no direct `flyctl deploy` bypass. Root coordinates concurrent ETA merges and deploy sequencing. Rebase/fetch before final review if master changed. Send root compact findings and a concrete PR, including any unresolved behavior risk.

## Coordination requests for ETA team

* If they change point/interval semantics or availability flags, request a concise contract before UI wording changes. Current “About” point is not necessarily the mean or midpoint of the displayed interval.
* Distinguish stable evidence from an explanation: a driver's coordination rule is research until causal, held-out ETA validation supports it. Never ship copy such as “waiting for the bus ahead” merely from a fitted correlation.
* If historical matches are few, request cohort counts and exclusion reasons from ETA team. Do not broaden cohorts or hide short dots from this worktree.
* Frontend `standWait` still reads its historical stand table while current Winchester ETA uses a conditional release model; any proposed departure-probability explanation needs consistency reviewed by ETA team first. Showing elapsed and usual total wait remains descriptive.

## Suggested overnight order

1. Deadline states and future-planning wording (`FIRST_TASK.md`).
2. Accessible navigation/search/report controls and actual short touch targets.
3. Historical/forecast detail hierarchy and minimap attribution check using fixtures.
4. Trip details, alerts, on-board and ride-finish clarity/recovery.
5. Offline/crash recovery, About and operator dashboards; no gratuitous redesign.

End with all view coverage recorded, independently reviewed shippable work integrated, and a short morning report with deployed changes, measured checks, remaining issues and unpromoted ideas.
